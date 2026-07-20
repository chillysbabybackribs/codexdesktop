import assert from 'node:assert/strict'
import test from 'node:test'
import type { ServerNotification } from '../../shared/session-protocol/index.ts'
import type { ThreadItem } from '../../shared/session-protocol/index.ts'
import type { Turn } from '../../shared/session-protocol/index.ts'
import {
  emptySessionState,
  reduceSessionNotification,
  type SessionReduceContext,
  type SessionRenderState
} from './session-store.ts'
import { buildRows } from './transcript-model.ts'

// Replay-style contract tests: full notification sequences through the ONE
// notification → render-model path, asserting the shape the UI would draw.
// These pin behavior for the dock migration and future provider adapters.

const context: SessionReduceContext = { atMs: 5_000_000, fallbackModel: 'gpt-test', workspace: '/tmp/ws' }

function replay(notifications: ServerNotification[], initial?: SessionRenderState): SessionRenderState {
  return notifications.reduce(
    (state, notification) => reduceSessionNotification(state, notification, context),
    initial ?? emptySessionState()
  )
}

function n(method: string, params: Record<string, unknown>): ServerNotification {
  return { method, params: { threadId: 't-1', ...params } } as unknown as ServerNotification
}

function makeTurn(id: string, items: ThreadItem[], overrides: Partial<Turn> = {}): Turn {
  return {
    id,
    items,
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: 4_000,
    completedAt: null,
    durationMs: null,
    ...overrides
  } as unknown as Turn
}

const userMessage = (id: string, text: string): ThreadItem =>
  ({ type: 'userMessage', id, content: [{ type: 'text', text }] }) as unknown as ThreadItem
const agentMessage = (id: string, text: string): ThreadItem =>
  ({ type: 'agentMessage', id, text, phase: null, memoryCitation: null }) as ThreadItem
const command = (id: string, cmd: string): ThreadItem =>
  ({ type: 'commandExecution', id, command: cmd, aggregatedOutput: '', status: 'inProgress', exitCode: null }) as unknown as ThreadItem

test('replay: full turn lifecycle produces the expected render rows and telemetry', () => {
  const state = replay([
    n('thread/name/updated', { threadName: 'Golden thread' }),
    n('turn/started', { turn: makeTurn('turn-1', [userMessage('u-1', 'hello there')]) }),
    n('item/started', { turnId: 'turn-1', item: agentMessage('a-1', ''), startedAtMs: 10 }),
    n('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'a-1', delta: 'Hi ' }),
    n('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'a-1', delta: 'there' }),
    n('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'a-1', delta: '!' }),
    n('item/completed', { turnId: 'turn-1', item: agentMessage('a-1', 'Hi there!'), completedAtMs: 90 }),
    n('thread/tokenUsage/updated', {
      turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 900, inputTokens: 700, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
        last: { totalTokens: 900, inputTokens: 700, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
        modelContextWindow: 200_000
      }
    }),
    n('turn/completed', { turn: makeTurn('turn-1', [], { status: 'completed', completedAt: 4_100 }) })
  ])

  assert.equal(state.title, 'Golden thread')
  assert.equal(state.turnId, null)
  assert.equal(state.items.length, 2)
  const assistant = state.items.find((item) => item.id === 'a-1')
  assert.equal((assistant as { text: string }).text, 'Hi there!')

  const meta = state.turnMeta['turn-1']
  assert.equal(meta?.status, 'completed')
  assert.equal(meta?.completedAtMs, 4_100_000)
  assert.equal(meta?.tokens?.modelCallCount, 1)
  assert.equal(state.contextUsage?.last.totalTokens, 900)

  // No work items in this turn, so no tail row — just the two chat rows.
  const { rows } = buildRows(state.items, state.itemMeta, null)
  assert.deepEqual(rows.map((row) => row.kind), ['chat', 'chat'])
})

test('replay: work items group into an activity row with a live tail', () => {
  const state = replay([
    n('turn/started', { turn: makeTurn('turn-2', [userMessage('u-2', 'run the tests')]) }),
    n('item/started', { turnId: 'turn-2', item: command('c-1', 'npm test'), startedAtMs: 10 }),
    n('item/commandExecution/outputDelta', { turnId: 'turn-2', itemId: 'c-1', delta: 'ok 1\n' }),
    n('item/commandExecution/outputDelta', { turnId: 'turn-2', itemId: 'c-1', delta: 'ok 2\n' }),
    n('item/reasoning/summaryTextDelta', { turnId: 'turn-2', itemId: 'r-1', summaryIndex: 0, delta: 'Checking…' }),
    n('item/plan/delta', { turnId: 'turn-2', itemId: 'p-1', delta: '1. run tests' })
  ])

  const commandItem = state.items.find((item) => item.id === 'c-1')
  assert.equal((commandItem as { aggregatedOutput: string }).aggregatedOutput, 'ok 1\nok 2\n')
  assert.equal(state.turnId, 'turn-2')

  const { rows, turnWork } = buildRows(state.items, state.itemMeta, 'turn-2')
  assert.deepEqual(rows.map((row) => row.kind), ['chat', 'activity', 'tail'])
  assert.equal(turnWork.get('turn-2')?.length, 3)
})

test('replay: compaction, goal, and terminal error sequence', () => {
  const compaction = { type: 'contextCompaction', id: 'comp-1' } as unknown as ThreadItem
  const usage = (total: number, last: number) => ({
    total: { totalTokens: total, inputTokens: total, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    last: { totalTokens: last, inputTokens: last, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
    modelContextWindow: 200_000
  })

  let state = replay([
    n('thread/goal/updated', { goal: { objective: 'stay focused' } }),
    n('turn/started', { turn: makeTurn('turn-3', []) }),
    n('thread/tokenUsage/updated', { turnId: 'turn-3', tokenUsage: usage(150_000, 150_000) }),
    n('item/started', { turnId: 'turn-3', item: compaction, startedAtMs: 10 })
  ])
  assert.equal(state.isCompacting, true)
  assert.equal(state.activeCompaction?.beforeTokens, 150_000)
  assert.deepEqual(state.goal, { objective: 'stay focused' })

  state = replay([
    n('item/completed', { turnId: 'turn-3', item: compaction, completedAtMs: 60 }),
    n('thread/tokenUsage/updated', { turnId: 'turn-3', tokenUsage: usage(160_000, 9_000) }),
    n('thread/goal/cleared', {}),
    n('error', { willRetry: false, error: { message: 'boom' } })
  ], state)

  assert.equal(state.isCompacting, false)
  assert.equal(state.activeCompaction, null)
  assert.equal(state.goal, null)
  assert.equal(state.turnId, null)
  const lastCall = state.turnMeta['turn-3']?.tokens?.modelCalls.at(-1)
  assert.equal(lastCall?.compactedBeforeCall, true)
  assert.equal(state.contextUsage?.last.totalTokens, 9_000)
})
