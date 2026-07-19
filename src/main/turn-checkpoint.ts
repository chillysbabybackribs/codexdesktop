import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

// Phase 4: per-turn workspace checkpoints (reversibility only — no gates, no
// approval prompts). A checkpoint snapshots the workspace's non-ignored files
// through a TEMPORARY git index into a commit referenced from a hidden ref
// namespace, so the user's worktree, index, branches, and the autosnapshot
// watcher are completely undisturbed. Revert makes the worktree match a
// checkpoint exactly (restore + delete files created since) and takes a
// safety checkpoint of the current state first, so a revert is itself
// revertible.

const run = promisify(execFile)

const refNamespace = 'refs/codexdesktop/checkpoints'
const maxCheckpointsPerThread = 40

export type CheckpointRecord = {
  id: string
  commit: string
  workspace: string
  repoRoot: string
  threadId: string
  turnId: string | null
  label: string
  createdAt: number
}

type CheckpointIndexFile = {
  version: 1
  checkpoints: CheckpointRecord[]
}

async function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd: root,
    env: {
      ...process.env,
      // Plumbing commands only; a fixed identity keeps commit-tree independent
      // of the user's git config.
      GIT_AUTHOR_NAME: 'codexdesktop-checkpoint',
      GIT_AUTHOR_EMAIL: 'checkpoint@codexdesktop.local',
      GIT_COMMITTER_NAME: 'codexdesktop-checkpoint',
      GIT_COMMITTER_EMAIL: 'checkpoint@codexdesktop.local',
      ...env
    },
    maxBuffer: 64 * 1024 * 1024
  })
  return stdout.trim()
}

export class TurnCheckpointStore {
  private readonly indexPath: string
  private queue: Promise<unknown> = Promise.resolve()
  private readonly repoRootCache = new Map<string, string | null>()

  constructor(stateDirectory: string) {
    this.indexPath = join(stateDirectory, 'checkpoints.json')
  }

  // Serialized: checkpoint/revert/prune all mutate refs + the index file.
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => {})
    return next
  }

  async repoRootFor(workspace: string): Promise<string | null> {
    const cached = this.repoRootCache.get(workspace)
    if (cached !== undefined) return cached
    let root: string | null
    try {
      root = await git(workspace, ['rev-parse', '--show-toplevel'])
    } catch {
      root = null
    }
    this.repoRootCache.set(workspace, root)
    return root
  }

  /**
   * Snapshot the workspace's current non-ignored files. Returns null when the
   * workspace is not inside a git work tree (checkpointing $HOME or arbitrary
   * directories would be nonsense; the ledger still works without it).
   */
  async createCheckpoint(
    workspace: string,
    threadId: string,
    label: string,
    now: number = Date.now()
  ): Promise<CheckpointRecord | null> {
    const root = await this.repoRootFor(workspace)
    if (!root) return null

    return this.enqueue(async () => {
      const temporaryIndex = join(tmpdir(), `codexdesktop-checkpoint-${randomUUID()}.index`)
      const env = { GIT_INDEX_FILE: temporaryIndex }
      try {
        let head: string | null
        try {
          head = await git(root, ['rev-parse', '--verify', 'HEAD'])
        } catch {
          head = null
        }
        if (head) await git(root, ['read-tree', 'HEAD'], env)
        else await git(root, ['read-tree', '--empty'], env)
        await git(root, ['add', '-A'], env)
        const tree = await git(root, ['write-tree'], env)

        const message = `codexdesktop checkpoint: ${label}`
        const commit = head
          ? await git(root, ['commit-tree', tree, '-p', head, '-m', message])
          : await git(root, ['commit-tree', tree, '-m', message])

        const id = randomUUID()
        await git(root, ['update-ref', `${refNamespace}/${id}`, commit])

        const record: CheckpointRecord = {
          id,
          commit,
          workspace,
          repoRoot: root,
          threadId,
          turnId: null,
          label,
          createdAt: now
        }
        await this.mutateIndex((index) => {
          index.checkpoints.push(record)
        })
        await this.pruneLocked(threadId)
        return record
      } finally {
        await rm(temporaryIndex, { force: true })
      }
    })
  }

  /** Bind a checkpoint created at send time to the turn id the server minted. */
  async assignTurn(checkpointId: string, turnId: string): Promise<void> {
    await this.enqueue(() =>
      this.mutateIndex((index) => {
        const record = index.checkpoints.find((candidate) => candidate.id === checkpointId)
        if (record) record.turnId = turnId
      })
    )
  }

  async list(threadId: string): Promise<CheckpointRecord[]> {
    const index = await this.readIndex()
    return index.checkpoints.filter((record) => record.threadId === threadId)
  }

  async find(threadId: string, turnId: string): Promise<CheckpointRecord | null> {
    const index = await this.readIndex()
    return index.checkpoints.find(
      (record) => record.threadId === threadId && record.turnId === turnId
    ) ?? null
  }

  /**
   * Ground-truth change detection: which non-ignored files differ between a
   * checkpoint (the pre-turn workspace snapshot) and the worktree NOW. Unlike
   * protocol fileChange items, this catches shell-command writes — the same
   * completeness argument as the checkpoints themselves.
   */
  async changedFiles(checkpointId: string, limit = 50): Promise<string[]> {
    const index = await this.readIndex()
    const record = index.checkpoints.find((candidate) => candidate.id === checkpointId)
    if (!record) return []
    const root = record.repoRoot

    const currentRaw = await git(root, ['ls-files', '-z', '-co', '--exclude-standard'])
    const current = new Set(currentRaw.split('\0').filter(Boolean))
    const checkpointRaw = await git(root, ['ls-tree', '-r', '-z', '--name-only', record.commit])
    const checkpointFiles = new Set(checkpointRaw.split('\0').filter(Boolean))
    const modifiedRaw = await git(root, ['diff', '--name-only', '-z', record.commit, '--', '.'])

    const changed = new Set<string>(modifiedRaw.split('\0').filter(Boolean))
    for (const file of current) if (!checkpointFiles.has(file)) changed.add(file)
    for (const file of checkpointFiles) if (!current.has(file)) changed.add(file)
    return [...changed].slice(0, limit)
  }

  /**
   * Make the worktree match the checkpoint exactly for non-ignored files:
   * restore every file the checkpoint holds and delete files created since.
   * The current state is checkpointed first ("pre-revert"), so this operation
   * is itself revertible. Ignored files are never touched.
   */
  async revert(checkpointId: string): Promise<CheckpointRecord> {
    const index = await this.readIndex()
    const record = index.checkpoints.find((candidate) => candidate.id === checkpointId)
    if (!record) throw new Error(`unknown checkpoint ${checkpointId}`)

    const safety = await this.createCheckpoint(
      record.workspace,
      record.threadId,
      `pre-revert of ${record.label}`
    )
    if (!safety) throw new Error('workspace is no longer a git work tree')

    return this.enqueue(async () => {
      const root = record.repoRoot

      const currentRaw = await git(root, ['ls-files', '-z', '-co', '--exclude-standard'])
      const current = new Set(currentRaw.split('\0').filter(Boolean))
      const checkpointRaw = await git(root, ['ls-tree', '-r', '-z', '--name-only', record.commit])
      const checkpointFiles = new Set(checkpointRaw.split('\0').filter(Boolean))

      for (const file of current) {
        if (checkpointFiles.has(file)) continue
        const absolute = resolve(root, file)
        // Defense against odd tracked paths; never delete outside the repo.
        if (!absolute.startsWith(root + sep)) continue
        await unlink(absolute).catch(() => undefined)
      }

      if (checkpointFiles.size > 0) {
        await git(root, ['checkout', record.commit, '--', ':/'])
      }
      return record
    })
  }

  private async pruneLocked(threadId: string): Promise<void> {
    const index = await this.readIndex()
    const forThread = index.checkpoints.filter((record) => record.threadId === threadId)
    const excess = forThread.length - maxCheckpointsPerThread
    if (excess <= 0) return
    const dropped = forThread.slice(0, excess)
    for (const record of dropped) {
      await git(record.repoRoot, ['update-ref', '-d', `${refNamespace}/${record.id}`]).catch(() => undefined)
    }
    const droppedIds = new Set(dropped.map((record) => record.id))
    await this.mutateIndex((current) => {
      current.checkpoints = current.checkpoints.filter((record) => !droppedIds.has(record.id))
    })
  }

  private async readIndex(): Promise<CheckpointIndexFile> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as CheckpointIndexFile
      if (parsed?.version === 1 && Array.isArray(parsed.checkpoints)) return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('checkpoint index unreadable; starting fresh', error)
      }
    }
    return { version: 1, checkpoints: [] }
  }

  private async mutateIndex(mutate: (index: CheckpointIndexFile) => void): Promise<void> {
    const index = await this.readIndex()
    mutate(index)
    await mkdir(dirname(this.indexPath), { recursive: true })
    const temporaryPath = `${this.indexPath}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.indexPath)
  }
}
