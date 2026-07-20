#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { constants as fsConstants, promises as fs, rmSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const args = new Set(process.argv.slice(2))
const watchMode = !args.has('--once')
const gitTimeoutMs = 30_000
const maxGitOutputBytes = 2_000_000
const maxUntrackedFileBytes = 10 * 1024 * 1024
const emptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const pathChunkSize = 100
const pollIntervalMs = numberEnv('CODEXDESKTOP_AUTOGIT_INTERVAL_MS', 5_000)
const stableMs = numberEnv('CODEXDESKTOP_AUTOGIT_STABLE_MS', 6_000)
const pushEnabled = process.env.CODEXDESKTOP_AUTOGIT_PUSH !== '0'

let lockHandle = null
let lockPath = null

main().catch((error) => {
  log(`failed: ${errorMessage(error)}`)
  process.exitCode = 1
})

async function main() {
  if (isDisabled()) {
    log('disabled by CODEXDESKTOP_AUTOGIT')
    return
  }

  const repo = await discoverRepo(process.cwd())
  await acquireLock(repo.gitDir)

  if (watchMode) {
    await watch(repo)
  } else {
    const result = await autoSnapshot(repo)
    logResult(result)
  }
}

async function watch(repo) {
  log(`watching ${repo.repoRoot}`)

  let lastStatusKey = ''
  let firstSeenAt = 0
  let blockedStatusKey = ''

  for (;;) {
    const changes = await readChanges(repo)
    const statusKey = changes.raw

    if (!statusKey) {
      lastStatusKey = ''
      firstSeenAt = 0
      blockedStatusKey = ''
      await sleep(pollIntervalMs)
      continue
    }

    if (statusKey !== lastStatusKey) {
      lastStatusKey = statusKey
      firstSeenAt = Date.now()
      blockedStatusKey = ''
      log('changes detected; waiting for the tree to settle')
      await sleep(pollIntervalMs)
      continue
    }

    if (statusKey === blockedStatusKey || Date.now() - firstSeenAt < stableMs) {
      await sleep(pollIntervalMs)
      continue
    }

    const result = await autoSnapshot(repo)
    logResult(result)

    if (result.state !== 'committed') {
      blockedStatusKey = statusKey
    }

    lastStatusKey = ''
    firstSeenAt = 0
    await sleep(pollIntervalMs)
  }
}

async function autoSnapshot(repo) {
  try {
    const unsafeState = await getUnsafeRepositoryState(repo.gitDir)
    const branch = await readBranch(repo.repoRoot)

    if (unsafeState) {
      return {
        state: 'skipped',
        branch,
        changedFiles: 0,
        skippedFiles: [],
        skippedFileCount: 0,
        message: `repository is in a protected state: ${unsafeState}`
      }
    }

    const changes = await readChanges(repo)
    const prepared = await preparePaths(repo, changes.entries)

    if (!prepared.safePaths.length) {
      return {
        state: 'skipped',
        branch,
        changedFiles: 0,
        skippedFiles: prepared.skippedFiles.slice(0, 25),
        skippedFileCount: prepared.skippedFiles.length,
        message: prepared.skippedFiles.length ? 'only unsafe paths changed' : 'tree is clean'
      }
    }

    const headSha = await readHeadSha(repo.repoRoot)
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'codexdesktop-autogit-'))
    const tempIndex = join(tempDir, 'index')

    try {
      const indexEnv = { GIT_INDEX_FILE: tempIndex }

      if (headSha) {
        await requireGit(runGit(repo.repoRoot, ['read-tree', headSha], { env: indexEnv }), 'Preparing autosnapshot index')
      }

      await gitAddPaths(repo.repoRoot, prepared.safePaths, indexEnv)
      const treeSha = (await requireGit(runGit(repo.repoRoot, ['write-tree'], { env: indexEnv }), 'Writing autosnapshot tree')).trim()
      const baseTreeSha = headSha ? await readTreeSha(repo.repoRoot, headSha) : emptyTreeSha

      if (treeSha === baseTreeSha) {
        return {
          state: 'skipped',
          branch,
          changedFiles: 0,
          skippedFiles: prepared.skippedFiles.slice(0, 25),
          skippedFileCount: prepared.skippedFiles.length,
          message: 'tree is already snapshotted'
        }
      }

      const identityEnv = await readCommitIdentityEnv(repo.repoRoot)
      const commitSha = await createCommit(repo, treeSha, headSha, identityEnv, prepared)
      await updateHead(repo.repoRoot, commitSha, headSha)
      if (pushEnabled) {
        await pushSnapshot(repo, branch)
      }
      await gitResetIndexPaths(repo.repoRoot, prepared.safePaths)

      return {
        state: 'committed',
        branch,
        commitSha,
        changedFiles: prepared.safePaths.length,
        skippedFiles: prepared.skippedFiles.slice(0, 25),
        skippedFileCount: prepared.skippedFiles.length,
        message: `committed ${prepared.safePaths.length} path(s)`
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  } catch (error) {
    return {
      state: 'error',
      changedFiles: 0,
      skippedFiles: [],
      skippedFileCount: 0,
      message: errorMessage(error)
    }
  }
}

async function discoverRepo(cwd) {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])

  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error('current directory is not inside a git work tree')
  }

  const bare = await requireGit(runGit(cwd, ['rev-parse', '--is-bare-repository']), 'Checking git repository')

  if (bare.trim() === 'true') {
    throw new Error('autosnapshot does not run in bare repositories')
  }

  const repoRootRaw = await requireGit(runGit(cwd, ['rev-parse', '--show-toplevel']), 'Finding git root')
  const repoRoot = await fs.realpath(repoRootRaw.trim())
  const gitDirRaw = (await requireGit(runGit(repoRoot, ['rev-parse', '--git-dir']), 'Finding git dir')).trim()
  const gitDir = await fs.realpath(isAbsolute(gitDirRaw) ? gitDirRaw : resolve(repoRoot, gitDirRaw))

  return { repoRoot, gitDir }
}

async function readChanges(repo) {
  const raw = await requireGit(
    runGit(repo.repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    'Reading git status'
  )

  return {
    raw,
    entries: parsePorcelainStatus(raw)
  }
}

function parsePorcelainStatus(output) {
  const entries = output.split('\0').filter(Boolean)
  const changes = []

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]

    if (entry.length < 4) {
      continue
    }

    const status = entry.slice(0, 2)
    const path = entry.slice(3)

    if (status[0] === 'R' || status[0] === 'C') {
      changes.push({ status, path, originalPath: entries[index + 1] })
      index += 1
    } else {
      changes.push({ status, path })
    }
  }

  return changes
}

async function preparePaths(repo, changes) {
  const candidates = new Map()
  const skippedFiles = []

  for (const change of changes) {
    for (const path of [change.path, change.originalPath]) {
      if (!path) {
        continue
      }

      if (!isRepoRelativePath(path)) {
        skippedFiles.push(`${path} (outside repository)`)
        continue
      }

      candidates.set(path, {
        path,
        status: change.status,
        untracked: change.status === '??'
      })
    }
  }

  const safePaths = []

  for (const candidate of candidates.values()) {
    const skipReason = await unsafePathReason(repo, candidate)

    if (skipReason) {
      skippedFiles.push(`${candidate.path} (${skipReason})`)
    } else {
      safePaths.push(candidate.path)
    }
  }

  return { safePaths, skippedFiles }
}

async function unsafePathReason(repo, candidate) {
  if (isGitInternalPath(candidate.path)) {
    return 'git internals are never autosnapshotted'
  }

  if (!candidate.untracked) {
    return null
  }

  if (looksLikeSecretPath(candidate.path)) {
    return 'looks like a secret'
  }

  const absolutePath = resolve(repo.repoRoot, candidate.path)

  try {
    const stat = await fs.lstat(absolutePath)

    if (stat.isSymbolicLink()) {
      return 'untracked symlink'
    }

    if (stat.isFile() && stat.size > maxUntrackedFileBytes) {
      return `larger than ${Math.round(maxUntrackedFileBytes / 1024 / 1024)}MB`
    }
  } catch {
    return null
  }

  return null
}

async function getUnsafeRepositoryState(gitDir) {
  const files = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']
  const dirs = ['rebase-apply', 'rebase-merge']

  for (const file of files) {
    if (await exists(join(gitDir, file))) {
      return `${file} exists`
    }
  }

  for (const dir of dirs) {
    if (await exists(join(gitDir, dir))) {
      return `${dir} is active`
    }
  }

  return null
}

async function readBranch(repoRoot) {
  const branch = await runGit(repoRoot, ['branch', '--show-current'])

  if (branch.exitCode === 0 && branch.stdout.trim()) {
    return branch.stdout.trim()
  }

  const head = await runGit(repoRoot, ['rev-parse', '--short', 'HEAD'])
  return head.exitCode === 0 && head.stdout.trim() ? `detached@${head.stdout.trim()}` : undefined
}

async function readHeadSha(repoRoot) {
  const head = await runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'])
  return head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : null
}

async function readTreeSha(repoRoot, headSha) {
  return (await requireGit(runGit(repoRoot, ['rev-parse', `${headSha}^{tree}`]), 'Reading git tree')).trim()
}

async function readCommitIdentityEnv(repoRoot) {
  const [name, email] = await Promise.all([
    runGit(repoRoot, ['config', '--get', 'user.name']),
    runGit(repoRoot, ['config', '--get', 'user.email'])
  ])
  const env = {}

  if (name.exitCode !== 0 || !name.stdout.trim()) {
    env.GIT_AUTHOR_NAME = 'Codex Desktop'
    env.GIT_COMMITTER_NAME = 'Codex Desktop'
  }

  if (email.exitCode !== 0 || !email.stdout.trim()) {
    env.GIT_AUTHOR_EMAIL = 'codexdesktop@local.invalid'
    env.GIT_COMMITTER_EMAIL = 'codexdesktop@local.invalid'
  }

  return env
}

async function createCommit(repo, treeSha, headSha, identityEnv, prepared) {
  const timestamp = new Date().toISOString()
  const subject = 'chore: autosnapshot development changes'
  const bodyLines = [
    'Created by Codex Desktop development autosnapshot.',
    `Timestamp: ${timestamp}`,
    `Repository: ${repo.repoRoot}`,
    prepared.skippedFiles.length ? `Skipped unsafe files: ${prepared.skippedFiles.length}` : null
  ].filter(Boolean)
  const args = ['commit-tree', treeSha]

  if (headSha) {
    args.push('-p', headSha)
  }

  args.push('-m', subject, '-m', bodyLines.join('\n'))

  return (await requireGit(runGit(repo.repoRoot, args, { env: identityEnv }), 'Creating autosnapshot commit')).trim()
}

async function updateHead(repoRoot, commitSha, previousHeadSha) {
  const args = ['update-ref', '-m', 'Codex Desktop development autosnapshot', 'HEAD', commitSha]

  if (previousHeadSha) {
    args.push(previousHeadSha)
  }

  await requireGit(runGit(repoRoot, args), 'Updating git HEAD')
}

async function pushSnapshot(repo, branch) {
  if (!branch || branch.startsWith('detached@')) {
    throw new Error('cannot push an autosnapshot from a detached HEAD')
  }

  await requireGit(
    runGit(repo.repoRoot, ['push', 'origin', `HEAD:${branch}`]),
    `Pushing autosnapshot to origin/${branch}`
  )
}

async function gitAddPaths(repoRoot, paths, env) {
  for (const chunk of chunks(paths, pathChunkSize)) {
    await requireGit(runGit(repoRoot, ['add', '-A', '--', ...chunk], { env }), 'Staging autosnapshot paths')
  }
}

async function gitResetIndexPaths(repoRoot, paths) {
  for (const chunk of chunks(paths, pathChunkSize)) {
    await requireGit(runGit(repoRoot, ['reset', '-q', 'HEAD', '--', ...chunk]), 'Refreshing git index')
  }
}

async function acquireLock(gitDir) {
  lockPath = join(gitDir, 'codexdesktop-autogit.lock')

  for (;;) {
    try {
      lockHandle = await fs.open(lockPath, 'wx')
      break
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error
      }

      if (await isStaleLock(lockPath)) {
        await fs.rm(lockPath, { force: true })
        continue
      }

      log('another autosnapshot watcher is already running')
      process.exit(0)
    }
  }

  await lockHandle.writeFile(`${process.pid}\n`)

  const release = () => {
    if (lockPath) {
      try {
        rmSync(lockPath, { force: true })
      } catch {
        // Best effort cleanup.
      }
    }
  }

  process.once('exit', release)
  process.once('SIGINT', () => {
    release()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    release()
    process.exit(143)
  })
}

async function isStaleLock(path) {
  try {
    const pid = Number((await fs.readFile(path, 'utf8')).trim())

    if (!Number.isInteger(pid) || pid <= 0) {
      return false
    }

    process.kill(pid, 0)
    return false
  } catch (error) {
    return Boolean(error && error.code === 'ESRCH')
  }
}

async function requireGit(resultPromise, label) {
  const result = await resultPromise

  if (result.exitCode === 0) {
    return result.stdout
  }

  const details = result.timedOut
    ? 'timed out'
    : (result.stderr || result.stdout || `git exited with ${result.exitCode ?? result.signal ?? 'unknown'}`).trim()
  throw new Error(`${label} failed: ${details}`)
}

function runGit(cwd, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn('git', args, {
      cwd,
      env: gitEnv(options.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false
    let forceKillTimer = null

    const finish = (result) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)

      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }

      resolveRun(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
    }, options.timeoutMs ?? gitTimeoutMs)

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength

      if (stdoutBytes <= maxGitOutputBytes) {
        stdout.push(chunk)
      } else {
        child.kill('SIGTERM')
      }
    })

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.byteLength

      if (stderrBytes <= maxGitOutputBytes) {
        stderr.push(chunk)
      } else {
        child.kill('SIGTERM')
      }
    })

    child.on('error', (error) => {
      finish({
        exitCode: -1,
        signal: null,
        stdout: '',
        stderr: error.message,
        timedOut
      })
    })

    child.on('close', (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut
      })
    })

    child.stdin.end(options.input)
  })
}

function gitEnv(overrides = {}) {
  const env = { ...process.env }

  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) {
    delete env[key]
  }

  return {
    ...env,
    ...overrides,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C'
  }
}

function isDisabled() {
  return ['0', 'false', 'off'].includes(String(process.env.CODEXDESKTOP_AUTOGIT ?? '').toLowerCase())
}

function isRepoRelativePath(path) {
  return Boolean(path) && !isAbsolute(path) && !path.split('/').includes('..')
}

function isGitInternalPath(path) {
  return path === '.git' || path.startsWith('.git/')
}

function looksLikeSecretPath(path) {
  const lowerPath = path.toLowerCase()
  const base = basename(lowerPath)

  if (base === '.env' || base.startsWith('.env.')) {
    return true
  }

  return (
    ['.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials'].includes(base) ||
    lowerPath.endsWith('.pem') ||
    lowerPath.endsWith('.key') ||
    lowerPath.endsWith('.p12') ||
    lowerPath.endsWith('.pfx') ||
    lowerPath.endsWith('/application_default_credentials.json')
  )
}

async function exists(path) {
  try {
    await fs.access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function chunks(items, size) {
  const result = []

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }

  return result
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function logResult(result) {
  if (result.state === 'committed') {
    log(`${result.message}: ${result.commitSha?.slice(0, 12) ?? 'unknown'}`)
    return
  }

  if (result.skippedFileCount) {
    log(`${result.state}: ${result.message}; skipped ${result.skippedFileCount} unsafe file(s)`)
    return
  }

  log(`${result.state}: ${result.message}`)
}

function log(message) {
  process.stderr.write(`[autogit] ${message}\n`)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
