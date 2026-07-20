import assert from 'node:assert/strict'
import test from 'node:test'
import { emptySessionState } from './session-store.ts'
import { parseTranscriptSession, serializeTranscriptSession } from './transcript-cache-model.ts'

test('transcript cache model round-trips the renderable session state', () => {
  const session = emptySessionState({
    threadId: 'thread-1',
    title: 'Cached chat',
    items: [{ type: 'agentMessage', id: 'a-1', text: 'Hello', phase: null, memoryCitation: null }] as never[],
    itemMeta: { 'a-1': { turnId: 'turn-1' } },
    turnMeta: { 'turn-1': { status: 'completed', origin: 'restored', model: null, reasoningEffort: null, workspace: null } }
  })
  const saved = serializeTranscriptSession(session)
  assert.ok(saved)
  const restored = parseTranscriptSession(saved, 'thread-1')
  assert.equal(restored?.title, 'Cached chat')
  assert.equal(restored?.items?.length, 1)
  assert.equal(restored?.itemMeta?.['a-1']?.turnId, 'turn-1')
})

test('transcript cache model rejects a mismatched or malformed snapshot', () => {
  assert.equal(parseTranscriptSession({ version: 1, session: { threadId: 'other' } }, 'thread-1'), null)
  assert.equal(parseTranscriptSession({ version: 1, session: { threadId: 'thread-1', items: [], itemMeta: [], turnMeta: {} } }, 'thread-1'), null)
})
