import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TurnTraceStore } from './turn-trace-store.ts'

function trace(turnId: string, marker: string): string {
  return `${JSON.stringify({ schemaVersion: 2, turn: { id: turnId }, marker })}\n`
}

test('TurnTraceStore atomically persists, loads, and replaces a completed snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-traces-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TurnTraceStore(root)

  await store.persist({ threadId: 'thread-1', turnId: 'turn-1', content: trace('turn-1', 'first') })
  await store.persist({ threadId: 'thread-1', turnId: 'turn-1', content: trace('turn-1', 'second') })

  assert.equal(await store.load('thread-1', 'turn-1'), trace('turn-1', 'second'))
  assert.equal(
    await readFile(join(root, 'thread-1', 'turn-1.json'), 'utf8'),
    trace('turn-1', 'second')
  )
})

test('TurnTraceStore rejects unsafe ids and mismatched content', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-traces-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TurnTraceStore(root)

  await assert.rejects(
    store.persist({ threadId: '../escape', turnId: 'turn-1', content: trace('turn-1', 'bad') }),
    /invalid trace thread or turn id/
  )
  await assert.rejects(
    store.persist({ threadId: 'thread-1', turnId: 'turn-1', content: trace('turn-2', 'bad') }),
    /trace id does not match/
  )
})
