import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem.ts'
import { buildRows, mergeChatItem, upsertMany, type ChatItem } from './transcript-model.ts'

type AgentMessage = Extract<ThreadItem, { type: 'agentMessage' }>

function agentMessage(id: string, text: string, phase: 'commentary' | 'final_answer' | null = null): AgentMessage {
  return { type: 'agentMessage', id, text, phase, memoryCitation: null }
}

test('buildRows groups work and commentary before the final answer', () => {
  const items: ChatItem[] = [
    { type: 'reasoning', id: 'reasoning-1', summary: ['Checking'], content: [] },
    agentMessage('commentary-1', 'Still working', 'commentary'),
    agentMessage('answer-1', 'Done', 'final_answer')
  ]
  const result = buildRows(items, {
    'reasoning-1': { turnId: 'turn-1' },
    'commentary-1': { turnId: 'turn-1' },
    'answer-1': { turnId: 'turn-1' }
  }, null)

  assert.deepEqual(result.rows.map((row) => row.kind), ['activity', 'chat', 'tail'])
  assert.equal(result.rows[0]?.kind === 'activity' && result.rows[0].items.length, 2)
  assert.equal(result.rows[1]?.kind === 'chat' && result.rows[1].item.id, 'answer-1')
  assert.deepEqual(result.turnWork.get('turn-1')?.map((item) => item.id), ['reasoning-1'])
})

test('buildRows keeps the active turn receipt at the transcript tail', () => {
  const items: ChatItem[] = [
    { type: 'reasoning', id: 'reasoning-1', summary: ['Checking'], content: [] },
    agentMessage('answer-1', 'Partial answer', 'final_answer'),
    { type: 'system', id: 'notice-1', level: 'info', text: 'Notice' }
  ]
  const result = buildRows(items, {
    'reasoning-1': { turnId: 'turn-1' },
    'answer-1': { turnId: 'turn-1' }
  }, 'turn-1')

  assert.equal(result.rows.at(-1)?.kind, 'tail')
  assert.equal(result.rows.at(-1)?.turnId, 'turn-1')
})

test('mergeChatItem prevents a shorter snapshot from erasing streamed text', () => {
  const current = agentMessage('answer-1', 'A complete streamed response', 'final_answer')
  const stale = agentMessage('answer-1', 'A complete', 'final_answer')

  assert.equal((mergeChatItem(current, stale) as typeof current).text, current.text)
  assert.equal((mergeChatItem(stale, current) as typeof current).text, current.text)
})

test('upsertMany preserves ordering while updating existing items and appending new ones', () => {
  const current: ChatItem[] = [agentMessage('answer-1', 'Long response', 'final_answer')]
  const next = upsertMany(current, [
    agentMessage('answer-1', 'Short', 'final_answer'),
    { type: 'contextCompaction', id: 'compact-1' }
  ])

  assert.deepEqual(next.map((item) => item.id), ['answer-1', 'compact-1'])
  assert.equal(next[0]?.type === 'agentMessage' && next[0].text, 'Long response')
  assert.notEqual(next, current)
})
