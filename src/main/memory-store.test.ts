import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryStore } from './memory-store.ts'

test('MemoryStore writes Markdown and scopes retrieval to the workspace', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-memory-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = new MemoryStore(root)

  await store.persist({
    threadId: 'thread-1',
    title: 'Simple memory',
    workspace: '/tmp/project',
    updatedAt: '2026-07-11T12:00:00.000Z',
    turns: [{ user: 'Remember this?', assistant: 'The checkpoint was saved.' }]
  })

  const lastChat = await store.loadLastChat('/tmp/project')
  assert.match(lastChat ?? '', /# Simple memory/)
  assert.equal(await store.loadLastChat('/tmp/other-project'), null)

  const transcript = await readFile(join(root, 'chats', 'thread-1.md'), 'utf8')
  assert.match(transcript, /<!-- codexdesktop-turn:C01:start -->/)
  assert.match(transcript, /## Turn C01 — Remember this\?/)
})
