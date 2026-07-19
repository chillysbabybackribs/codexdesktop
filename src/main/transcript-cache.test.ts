import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TranscriptCache } from './transcript-cache.ts'

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'transcript-cache-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('append then read round-trips entries in order', async () => {
  await withRoot(async (root) => {
    const cache = new TranscriptCache(root)
    await cache.append('thread-1', [{ id: 'a', n: 1 }, { id: 'b', n: 2 }])
    await cache.append('thread-1', [{ id: 'c', n: 3 }])
    assert.deepEqual(await cache.read('thread-1'), [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'c', n: 3 }
    ])
  })
})

test('reading an unknown thread returns an empty list', async () => {
  await withRoot(async (root) => {
    const cache = new TranscriptCache(root)
    assert.deepEqual(await cache.read('missing'), [])
  })
})

test('concurrent appends serialize per thread and preserve order', async () => {
  await withRoot(async (root) => {
    const cache = new TranscriptCache(root)
    await Promise.all([
      cache.append('thread-1', [{ seq: 1 }]),
      cache.append('thread-1', [{ seq: 2 }]),
      cache.append('thread-1', [{ seq: 3 }])
    ])
    assert.deepEqual(await cache.read('thread-1'), [{ seq: 1 }, { seq: 2 }, { seq: 3 }])
  })
})

test('a torn trailing line is skipped on read and appends keep working', async () => {
  await withRoot(async (root) => {
    const cache = new TranscriptCache(root)
    await cache.append('thread-1', [{ id: 'a' }])
    await appendFile(join(root, 'thread-1.jsonl'), '{"id":"torn', 'utf8')
    assert.deepEqual(await cache.read('thread-1'), [{ id: 'a' }])

    await cache.append('thread-1', [{ id: 'b' }])
    const entries = await cache.read('thread-1')
    assert.deepEqual(entries.at(0), { id: 'a' })
    assert.deepEqual(entries.at(-1), { id: 'b' })
  })
})

test('oversized entries are rejected without corrupting the file', async () => {
  await withRoot(async (root) => {
    const cache = new TranscriptCache(root, { maxEntryBytes: 64 })
    await cache.append('thread-1', [{ id: 'small' }])
    await assert.rejects(
      cache.append('thread-1', [{ id: 'big', text: 'x'.repeat(200) }]),
      /exceeds 64 bytes/
    )
    assert.deepEqual(await cache.read('thread-1'), [{ id: 'small' }])
  })
})

test('compaction keeps the newest entries within the target budget', async () => {
  await withRoot(async (root) => {
    const cache = new TranscriptCache(root, { maxFileBytes: 600, compactTargetBytes: 300 })
    for (let index = 0; index < 40; index += 1) {
      await cache.append('thread-1', [{ seq: index, pad: 'p'.repeat(20) }])
    }

    const raw = await readFile(join(root, 'thread-1.jsonl'), 'utf8')
    assert.ok(Buffer.byteLength(raw, 'utf8') <= 600, `file stayed bounded (${raw.length} bytes)`)

    const entries = (await cache.read('thread-1')) as Array<{ seq: number }>
    assert.ok(entries.length > 0)
    assert.equal(entries.at(-1)?.seq, 39, 'newest entry survives')
    const seqs = entries.map((entry) => entry.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'order preserved after compaction')
  })
})

test('replace rewrites the cache atomically', async () => {
  await withRoot(async (root) => {
    const cache = new TranscriptCache(root)
    await cache.append('thread-1', [{ id: 'old' }])
    await cache.replace('thread-1', [{ id: 'new-1' }, { id: 'new-2' }])
    assert.deepEqual(await cache.read('thread-1'), [{ id: 'new-1' }, { id: 'new-2' }])
  })
})

test('remove deletes the thread cache', async () => {
  await withRoot(async (root) => {
    const cache = new TranscriptCache(root)
    await cache.append('thread-1', [{ id: 'a' }])
    await cache.remove('thread-1')
    assert.deepEqual(await cache.read('thread-1'), [])
  })
})

test('invalid thread ids are rejected', async () => {
  await withRoot(async (root) => {
    const cache = new TranscriptCache(root)
    await assert.rejects(cache.append('../evil', [{ id: 'a' }]), /invalid transcript cache thread id/)
    await assert.rejects(cache.read('a/b'), /invalid transcript cache thread id/)
  })
})
