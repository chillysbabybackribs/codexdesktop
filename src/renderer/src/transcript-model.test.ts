import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadItem } from '../../shared/session-protocol/index.ts'
import {
  appendAgentMessageDelta,
  appendCommandOutputDelta,
  appendPlanDelta,
  appendReasoningDelta,
  buildRows,
  mergeChatItem,
  replaceFileChanges,
  upsertMany,
  type ChatItem
} from './transcript-model.ts'

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

test('message and plan deltas create missing items and append subsequent chunks', () => {
  const withMessage = appendAgentMessageDelta([], 'answer-1', 'Hello')
  const completedMessage = appendAgentMessageDelta(withMessage, 'answer-1', ' world')
  const withPlan = appendPlanDelta(completedMessage, 'plan-1', 'Step')
  const completedPlan = appendPlanDelta(withPlan, 'plan-1', ' one')

  assert.equal(completedPlan[0]?.type === 'agentMessage' && completedPlan[0].text, 'Hello world')
  assert.equal(completedPlan[1]?.type === 'plan' && completedPlan[1].text, 'Step one')
})

test('command deltas append to existing output and ignore missing or mismatched items', () => {
  const command: Extract<ThreadItem, { type: 'commandExecution' }> = {
    type: 'commandExecution',
    id: 'command-1',
    command: 'npm test',
    cwd: '/workspace',
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null
  }

  const first = appendCommandOutputDelta([command], 'command-1', 'pass')
  const second = appendCommandOutputDelta(first, 'command-1', 'ed')

  assert.equal(second[0]?.type === 'commandExecution' && second[0].aggregatedOutput, 'passed')
  assert.deepEqual(appendCommandOutputDelta(second, 'missing', 'ignored'), second)
})

test('reasoning deltas preserve sparse part indexes and append in arrival order', () => {
  const first = appendReasoningDelta([], 'reasoning-1', 'summary', 1, 'Second')
  const second = appendReasoningDelta(first, 'reasoning-1', 'summary', 1, ' part')
  const third = appendReasoningDelta(second, 'reasoning-1', 'content', 0, 'Details')
  const reasoning = third[0]

  assert.equal(reasoning?.type, 'reasoning')
  if (reasoning?.type !== 'reasoning') assert.fail('expected reasoning item')
  assert.deepEqual(reasoning.summary, ['', 'Second part'])
  assert.deepEqual(reasoning.content, ['Details'])
})

test('file change updates replace the full streamed change set', () => {
  const initial = [{ path: 'src/a.ts', kind: { type: 'update' as const, move_path: null }, diff: '+one' }]
  const replacement = [{ path: 'src/a.ts', kind: { type: 'update' as const, move_path: null }, diff: '+one\n+two' }]
  const created = replaceFileChanges([], 'file-1', [...initial])
  const updated = replaceFileChanges(created, 'file-1', [...replacement])

  assert.equal(updated[0]?.type, 'fileChange')
  if (updated[0]?.type !== 'fileChange') assert.fail('expected file change item')
  assert.deepEqual(updated[0].changes, replacement)
  assert.equal(updated[0].status, 'inProgress')
})
