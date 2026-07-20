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

test('a poisoned snapshot with both id families for one turn heals on load', () => {
  // Caches written before the one-source-per-turn fix hold each row twice:
  // once under the live stream id, once under the resume page's item-N id.
  const session = emptySessionState({
    threadId: 'thread-1',
    items: [
      { type: 'userMessage', id: 'um-uuid-1', content: [{ type: 'text', text: '' }] },
      { type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: 'the question' }] },
      { type: 'agentMessage', id: 'msg_live', text: 'answer', phase: null, memoryCitation: null },
      { type: 'agentMessage', id: 'item-2', text: 'answer', phase: null, memoryCitation: null },
      { type: 'turnPlan', id: 'plan-turn-1', steps: [] },
      // A different turn restored purely from resume keeps its enumerated rows.
      { type: 'agentMessage', id: 'item-0', text: 'older turn', phase: null, memoryCitation: null }
    ] as never[],
    itemMeta: {
      'um-uuid-1': { turnId: 'turn-1' },
      'item-1': { turnId: 'turn-1' },
      msg_live: { turnId: 'turn-1' },
      'item-2': { turnId: 'turn-1' },
      'plan-turn-1': { turnId: 'turn-1' },
      'item-0': { turnId: 'turn-0' }
    },
    turnMeta: {
      'turn-0': { status: 'completed', origin: 'restored', model: null, reasoningEffort: null, workspace: null },
      'turn-1': { status: 'interrupted', origin: 'live', model: null, reasoningEffort: null, workspace: null }
    }
  })
  const restored = parseTranscriptSession(serializeTranscriptSession(session), 'thread-1')
  const ids = restored?.items?.map((item) => item.id)
  assert.deepEqual(ids, ['um-uuid-1', 'msg_live', 'plan-turn-1', 'item-0'])
  const user = restored?.items?.find((item) => item.id === 'um-uuid-1') as { content: Array<{ text: string }> }
  assert.equal(user.content[0].text, 'the question', 'empty live user message adopts the displaced enumerated text')
})

test('transcript cache model rejects a mismatched or malformed snapshot', () => {
  assert.equal(parseTranscriptSession({ version: 1, session: { threadId: 'other' } }, 'thread-1'), null)
  assert.equal(parseTranscriptSession({ version: 1, session: { threadId: 'thread-1', items: [], itemMeta: [], turnMeta: {} } }, 'thread-1'), null)
})
