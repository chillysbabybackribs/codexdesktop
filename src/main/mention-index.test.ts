import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { MentionIndexService } from './mention-index.ts'

const run = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd })
  return stdout.trim()
}

async function withRepo(
  runTest: (base: string, repo: string, service: MentionIndexService) => Promise<void>
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'mention-test-'))
  const repo = join(base, 'repo')
  await mkdir(repo)
  try {
    await git(repo, 'init', '-q')
    await runTest(base, repo, new MentionIndexService())
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('index lists tracked and untracked files, respects .gitignore', async () => {
  await withRepo(async (_base, repo, service) => {
    await writeFile(join(repo, '.gitignore'), 'secret.env\n')
    await writeFile(join(repo, 'secret.env'), 'KEY=1\n')
    await mkdir(join(repo, 'src'))
    await writeFile(join(repo, 'src/app.ts'), 'const a = 1\n')

    const index = await service.index(repo)
    assert.ok(index.files.includes('src/app.ts'))
    assert.ok(!index.files.includes('secret.env'), 'ignored files stay out of the index')
    assert.ok(index.dirs.includes('src'))
  })
})

test('file reads work; ignored and unindexed paths are rejected', async () => {
  await withRepo(async (_base, repo, service) => {
    await writeFile(join(repo, '.gitignore'), 'secret.env\n')
    await writeFile(join(repo, 'secret.env'), 'KEY=1\n')
    await writeFile(join(repo, 'app.ts'), 'const a = 1\n')

    const ok = await service.read(repo, 'app.ts', 'file')
    assert.equal(ok.content, 'const a = 1\n')

    const ignored = await service.read(repo, 'secret.env', 'file')
    assert.equal(ignored.content, null, 'reads are limited to what the index offered')

    const escape = await service.read(repo, '../outside.txt', 'file')
    assert.equal(escape.content, null)
  })
})

test('a tracked symlink pointing outside the workspace is never read', async () => {
  await withRepo(async (base, repo, service) => {
    await writeFile(join(base, 'outside-secret.txt'), 'root password\n')
    await symlink(join(base, 'outside-secret.txt'), join(repo, 'link.txt'))
    await writeFile(join(repo, 'inside.txt'), 'fine\n')
    await symlink(join(repo, 'inside.txt'), join(repo, 'inside-link.txt'))

    const index = await service.index(repo)
    assert.ok(index.files.includes('link.txt'), 'git indexes the symlink itself')

    const escaped = await service.read(repo, 'link.txt', 'file')
    assert.equal(escaped.content, null, 'real path resolves outside the real root → rejected')

    const internal = await service.read(repo, 'inside-link.txt', 'file')
    assert.equal(internal.content, 'fine\n', 'symlinks resolving inside the workspace stay readable')
  })
})

test('invalid workspace roots are rejected; picker approval admits non-git dirs', async () => {
  const service = new MentionIndexService()

  const plain = await mkdtemp(join(tmpdir(), 'mention-plain-'))
  try {
    await writeFile(join(plain, 'note.txt'), 'hello\n')

    assert.deepEqual(await service.index(plain), { files: [], dirs: [] }, 'non-git, unapproved → empty')
    assert.equal((await service.read(plain, 'note.txt', 'file')).content, null)
    assert.equal((await service.read('/nonexistent-path-xyz', 'a', 'file')).content, null)

    // The native picker approves a folder even outside git — but reads still
    // go through the (git-derived, thus empty) index, so nothing leaks.
    await service.approveWorkspace(plain)
    assert.equal((await service.read(plain, 'note.txt', 'file')).content, null)
  } finally {
    await rm(plain, { recursive: true, force: true })
  }
})

test('folder listings come from the index only', async () => {
  await withRepo(async (_base, repo, service) => {
    await mkdir(join(repo, 'src'))
    await writeFile(join(repo, 'src/a.ts'), 'a\n')
    await writeFile(join(repo, 'src/b.ts'), 'b\n')

    const listing = await service.read(repo, 'src', 'folder')
    assert.equal(listing.content, '- src/a.ts\n- src/b.ts')

    const escape = await service.read(repo, '../..', 'folder')
    assert.equal(escape.content, null)
  })
})
