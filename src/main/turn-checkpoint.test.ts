import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { TurnCheckpointStore } from './turn-checkpoint.ts'

const run = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd })
  return stdout.trim()
}

async function withRepo(
  runTest: (repo: string, store: TurnCheckpointStore) => Promise<void>
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'ckpt-test-'))
  const repo = join(base, 'repo')
  await mkdir(repo)
  try {
    await git(repo, 'init', '-q')
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'base')
    const store = new TurnCheckpointStore(join(base, 'state'))
    await runTest(repo, store)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('checkpoint captures tracked, modified, and untracked files without touching the worktree', async () => {
  await withRepo(async (repo, store) => {
    await writeFile(join(repo, 'tracked.txt'), 'v1\n')
    await git(repo, 'add', 'tracked.txt')
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'add tracked')
    await writeFile(join(repo, 'tracked.txt'), 'v2\n')
    await writeFile(join(repo, 'untracked.txt'), 'new\n')

    const statusBefore = await git(repo, 'status', '--porcelain')
    const record = await store.createCheckpoint(repo, 'thread-1', 'turn one')
    assert.ok(record)
    const statusAfter = await git(repo, 'status', '--porcelain')

    assert.equal(statusAfter, statusBefore, 'worktree and index are undisturbed')
    const files = await git(repo, 'ls-tree', '-r', '--name-only', record!.commit)
    assert.ok(files.includes('tracked.txt'))
    assert.ok(files.includes('untracked.txt'))
    const content = await git(repo, 'show', `${record!.commit}:tracked.txt`)
    assert.equal(content, 'v2', 'checkpoint holds worktree content, not HEAD content')
  })
})

test('checkpoints respect .gitignore', async () => {
  await withRepo(async (repo, store) => {
    await writeFile(join(repo, '.gitignore'), 'secret.txt\n')
    await writeFile(join(repo, 'secret.txt'), 'shh\n')
    await writeFile(join(repo, 'kept.txt'), 'ok\n')
    const record = await store.createCheckpoint(repo, 'thread-1', 'ignore test')
    const files = await git(repo, 'ls-tree', '-r', '--name-only', record!.commit)
    assert.ok(files.includes('kept.txt'))
    assert.ok(!files.includes('secret.txt'))
  })
})

test('a non-git workspace returns null instead of failing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ckpt-plain-'))
  try {
    const store = new TurnCheckpointStore(join(dir, 'state'))
    assert.equal(await store.createCheckpoint(dir, 'thread-1', 'x'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('revert restores modified files, deletes files created after the checkpoint, and spares ignored files', async () => {
  await withRepo(async (repo, store) => {
    await writeFile(join(repo, '.gitignore'), 'scratch.log\n')
    await writeFile(join(repo, 'app.ts'), 'original\n')
    await git(repo, 'add', '-A')
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'code')

    const record = await store.createCheckpoint(repo, 'thread-1', 'before turn')

    // The "turn" edits a file, adds a new one, and writes an ignored log.
    await writeFile(join(repo, 'app.ts'), 'clobbered by the model\n')
    await writeFile(join(repo, 'brand-new.ts'), 'created by the model\n')
    await writeFile(join(repo, 'scratch.log'), 'ignored noise\n')

    await store.revert(record!.id)

    assert.equal(await readFile(join(repo, 'app.ts'), 'utf8'), 'original\n')
    assert.ok(!existsSync(join(repo, 'brand-new.ts')), 'file created after checkpoint is deleted')
    assert.ok(existsSync(join(repo, 'scratch.log')), 'ignored files are never touched')
  })
})

test('revert takes a safety checkpoint first, so a revert is revertible', async () => {
  await withRepo(async (repo, store) => {
    await writeFile(join(repo, 'file.txt'), 'before\n')
    const record = await store.createCheckpoint(repo, 'thread-1', 'baseline')

    await writeFile(join(repo, 'file.txt'), 'after turn\n')
    await store.revert(record!.id)
    assert.equal(await readFile(join(repo, 'file.txt'), 'utf8'), 'before\n')

    const all = await store.list('thread-1')
    const safety = all.find((candidate) => candidate.label.startsWith('pre-revert'))
    assert.ok(safety, 'safety checkpoint exists')

    await store.revert(safety!.id)
    assert.equal(await readFile(join(repo, 'file.txt'), 'utf8'), 'after turn\n', 'revert undone')
  })
})

test('assignTurn binds the pending checkpoint and find() locates it', async () => {
  await withRepo(async (repo, store) => {
    const record = await store.createCheckpoint(repo, 'thread-1', 'send')
    assert.equal(record!.turnId, null)
    await store.assignTurn(record!.id, 'turn-42')
    const found = await store.find('thread-1', 'turn-42')
    assert.equal(found?.id, record!.id)
  })
})

test('checkpoints work in a repo with no commits yet', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ckpt-empty-'))
  const repo = join(base, 'repo')
  await mkdir(repo)
  try {
    await git(repo, 'init', '-q')
    await writeFile(join(repo, 'only.txt'), 'hello\n')
    const store = new TurnCheckpointStore(join(base, 'state'))
    const record = await store.createCheckpoint(repo, 'thread-1', 'empty repo')
    assert.ok(record)
    const files = await git(repo, 'ls-tree', '-r', '--name-only', record!.commit)
    assert.ok(files.includes('only.txt'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('pruning caps checkpoints per thread and deletes their refs', async () => {
  await withRepo(async (repo, store) => {
    await writeFile(join(repo, 'file.txt'), 'x\n')
    const first = await store.createCheckpoint(repo, 'thread-1', 'first')
    for (let index = 0; index < 41; index += 1) {
      await store.createCheckpoint(repo, 'thread-1', `cp-${index}`)
    }
    const list = await store.list('thread-1')
    assert.equal(list.length, 40)
    assert.ok(!list.some((record) => record.id === first!.id), 'oldest pruned')
    await assert.rejects(
      git(repo, 'rev-parse', '--verify', `refs/codexdesktop/checkpoints/${first!.id}`),
      'pruned ref is deleted'
    )
  })
})

test('changedFiles ground-truths shell-made modifications, additions, and deletions', async () => {
  await withRepo(async (repo, store) => {
    await writeFile(join(repo, 'kept.txt'), 'same\n')
    await writeFile(join(repo, 'edited.txt'), 'v1\n')
    await writeFile(join(repo, 'doomed.txt'), 'bye\n')
    await git(repo, 'add', '-A')
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base')

    const record = await store.createCheckpoint(repo, 'thread-1', 'pre-turn')
    assert.deepEqual(await store.changedFiles(record!.id), [], 'untouched workspace reports no changes')

    // Simulate a turn made ONLY of shell writes (no fileChange items exist).
    await writeFile(join(repo, 'edited.txt'), 'v2\n')
    await writeFile(join(repo, 'brand-new.txt'), 'hi\n')
    await rm(join(repo, 'doomed.txt'))

    const changed = (await store.changedFiles(record!.id)).sort()
    assert.deepEqual(changed, ['brand-new.txt', 'doomed.txt', 'edited.txt'])
  })
})
