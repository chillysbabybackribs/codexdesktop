import assert from 'node:assert/strict'
import test from 'node:test'
import type { ServerNotification } from '../../shared/session-protocol/index.ts'
import type { ThreadItem } from '../../shared/session-protocol/index.ts'
import type { Turn } from '../../shared/session-protocol/index.ts'
import type { ThreadTokenUsage } from '../../shared/session-protocol/index.ts'
import {
  SessionStore,
  emptySessionState,
  reduceSessionNotification,
  type SessionReduceContext
} from './session-store.ts'

const context: SessionReduceContext = { atMs: 1_000_000, fallbackModel: 'gpt-test', workspace: '/tmp/ws' }

function breakdown(totalTokens: number): ThreadTokenUsage['total'] {
  return {
    totalTokens,
    inputTokens: Math.floor(totalTokens * 0.8),
    cachedInputTokens: 0,
    outputTokens: Math.ceil(totalTokens * 0.2),
    reasoningOutputTokens: 0
  }
}

function usage(total: number, last: number): ThreadTokenUsage {
  return { total: breakdown(total), last: breakdown(last), modelContextWindow: 272_000 }
}

function agentMessage(id: string, text: string): ThreadItem {
  return { type: 'agentMessage', id, text, phase: null, memoryCitation: null } as ThreadItem
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-1',
    items: [],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: 500,
    completedAt: null,
    durationMs: null,
    ...overrides
  } as unknown as Turn
}

function notify(method: string, params: Record<string, unknown>): ServerNotification {
  return { method, params } as unknown as ServerNotification
}

test('unrelated notifications return the identical state reference', () => {
  const state = emptySessionState()
  const next = reduceSessionNotification(
    state,
    notify('thread/started', { threadId: 't-1' }),
    context
  )
  assert.equal(next, state)
})

test('turn/started folds the turn payload and marks the session working', () => {
  const state = emptySessionState({ goal: { objective: 'ship it' } as never })
  const turn = makeTurn({ items: [agentMessage('m-1', 'hello')] })
  const next = reduceSessionNotification(state, notify('turn/started', { threadId: 't', turn }), context)

  assert.equal(next.turnId, 'turn-1')
  assert.equal(next.items.length, 1)
  assert.equal(next.itemMeta['m-1']?.turnId, 'turn-1')
  assert.equal(next.turnMeta['turn-1']?.status, 'inProgress')
  assert.equal(next.turnMeta['turn-1']?.model, 'gpt-test')
  assert.equal(next.turnMeta['turn-1']?.startedAtMs, 500_000)
  assert.deepEqual(next.turnMeta['turn-1']?.goalAtStart, { objective: 'ship it' })
  assert.notEqual(next.turnMeta['turn-1']?.goalAtStart, state.goal, 'goal is cloned, not shared')
})

test('agent message deltas accumulate text through the item reducers', () => {
  let state = emptySessionState()
  state = reduceSessionNotification(
    state,
    notify('item/agentMessage/delta', { threadId: 't', turnId: 'turn-1', itemId: 'm-1', delta: 'Hel' }),
    context
  )
  state = reduceSessionNotification(
    state,
    notify('item/agentMessage/delta', { threadId: 't', turnId: 'turn-1', itemId: 'm-1', delta: 'lo' }),
    context
  )
  const item = state.items[0]
  assert.equal(item.type, 'agentMessage')
  assert.equal((item as { text: string }).text, 'Hello')
  assert.equal(state.itemMeta['m-1']?.turnId, 'turn-1')
})

test('a live item evicts the same turn\'s resume-enumerated copies', () => {
  // A thread resumed mid-turn seeds items with the server's persisted item-N
  // ids; the live stream then re-delivers the same rows under stable provider
  // ids. Both copies rendering at once was the restored-thread duplication bug.
  let state = emptySessionState({ threadId: 'th-1' })
  state = reduceSessionNotification(
    state,
    notify('turn/started', {
      threadId: 'th-1',
      turn: makeTurn({
        id: 'turn-live',
        items: [
          { type: 'userMessage', id: 'item-0', content: [{ type: 'text', text: 'hi' }] },
          agentMessage('item-1', 'partial answer'),
        ] as unknown as ThreadItem[],
      }),
    }),
    context
  )
  state = reduceSessionNotification(
    state,
    notify('item/started', {
      threadId: 'th-1',
      turnId: 'turn-live',
      startedAtMs: 1_000_100,
      item: { type: 'userMessage', id: 'um_live1', content: [{ type: 'text', text: 'hi' }] },
    }),
    context
  )
  assert.deepEqual(
    state.items.map((item) => item.id),
    ['um_live1'],
    'resume-enumerated rows of the turn are replaced by the live stream'
  )

  // A resume-shaped completion (item-N id) must NOT evict its own family.
  state = reduceSessionNotification(
    state,
    notify('item/completed', {
      threadId: 'th-1',
      turnId: 'turn-other',
      completedAtMs: 1_000_200,
      item: agentMessage('item-3', 'restored row'),
    }),
    context
  )
  assert.deepEqual(state.items.map((item) => item.id), ['um_live1', 'item-3'])
})

test('an authoritative user message strips the optimistic placeholder', () => {
  const optimistic = {
    type: 'userMessage',
    id: 'optimistic-user-1',
    content: [{ type: 'text', text: 'hi' }]
  } as unknown as ThreadItem
  const authoritative = {
    type: 'userMessage',
    id: 'real-user-1',
    content: [{ type: 'text', text: 'hi' }]
  } as unknown as ThreadItem

  let state = emptySessionState({ items: [optimistic] })
  state = reduceSessionNotification(
    state,
    notify('item/completed', { threadId: 't', turnId: 'turn-1', item: authoritative, completedAtMs: 5 }),
    context
  )
  const ids = state.items.map((item) => item.id)
  assert.ok(!ids.includes('optimistic-user-1'))
  assert.ok(ids.includes('real-user-1'))
})

test('compaction lifecycle: pending, active with beforeTokens, consumed by next call, cleared on completion', () => {
  const compaction = { type: 'contextCompaction', id: 'c-1' } as unknown as ThreadItem
  let state = emptySessionState({ contextUsage: usage(10_000, 9_000) })

  state = reduceSessionNotification(
    state,
    notify('item/started', { threadId: 't', turnId: 'turn-1', item: compaction, startedAtMs: 10 }),
    context
  )
  assert.equal(state.isCompacting, true)
  assert.deepEqual(state.activeCompaction, { itemId: 'c-1', turnId: 'turn-1', beforeTokens: 9_000 })
  assert.ok(state.pendingCompactionByTurn.has('turn-1'))
  assert.equal(state.itemMeta['c-1']?.compaction?.beforeTokens, 9_000)

  state = reduceSessionNotification(
    state,
    notify('thread/tokenUsage/updated', { threadId: 't', turnId: 'turn-1', tokenUsage: usage(12_000, 2_000) }),
    context
  )
  assert.equal(state.contextUsage?.last.totalTokens, 2_000)
  assert.ok(!state.pendingCompactionByTurn.has('turn-1'), 'pending compaction consumed by the next model call')
  assert.equal(state.turnMeta['turn-1']?.tokens?.modelCalls.at(-1)?.compactedBeforeCall, true)

  state = reduceSessionNotification(
    state,
    notify('item/completed', { threadId: 't', turnId: 'turn-1', item: compaction, completedAtMs: 20 }),
    context
  )
  assert.equal(state.isCompacting, false)
  assert.equal(state.activeCompaction, null)
})

test('turn/completed finalizes telemetry and clears the running turn', () => {
  let state = emptySessionState()
  state = reduceSessionNotification(
    state,
    notify('turn/started', { threadId: 't', turn: makeTurn() }),
    context
  )
  const completedTurn = makeTurn({
    status: 'failed',
    completedAt: 700,
    error: { message: 'boom' } as Turn['error']
  })
  state = reduceSessionNotification(state, notify('turn/completed', { threadId: 't', turn: completedTurn }), context)

  assert.equal(state.turnId, null)
  assert.equal(state.turnMeta['turn-1']?.status, 'failed')
  assert.equal(state.turnMeta['turn-1']?.completedAtMs, 700_000)
  assert.equal(state.turnMeta['turn-1']?.errorMessage, 'boom')
})

test('terminal errors clear the running turn; retryable errors change nothing', () => {
  const working = emptySessionState({ turnId: 'turn-1' })
  const retried = reduceSessionNotification(working, notify('error', { willRetry: true, error: {} }), context)
  assert.equal(retried, working)
  const failed = reduceSessionNotification(working, notify('error', { willRetry: false, error: {} }), context)
  assert.equal(failed.turnId, null)
})

test('SessionStore notifies key and global subscribers only on real changes', () => {
  const store = new SessionStore()
  let keyFires = 0
  let allFires = 0
  store.subscribe('s-1', () => { keyFires += 1 })
  store.subscribeAll(() => { allFires += 1 })

  const before = store.get('s-1')
  store.update('s-1', (state) => state)
  assert.equal(keyFires, 0, 'identity update does not notify')

  store.update('s-1', (state) => ({ ...state, title: 'Renamed' }))
  assert.equal(keyFires, 1)
  assert.equal(allFires, 1)
  assert.notEqual(store.get('s-1'), before)
  assert.equal(store.get('s-1'), store.get('s-1'), 'snapshot reference is stable between updates')

  store.remove('s-1')
  assert.equal(keyFires, 2)
})

test('subscribing is per key: other sessions do not fire the listener', () => {
  const store = new SessionStore()
  let fires = 0
  const unsubscribe = store.subscribe('s-1', () => { fires += 1 })
  store.update('s-2', (state) => ({ ...state, title: 'Other' }))
  assert.equal(fires, 0)
  unsubscribe()
  store.update('s-1', (state) => ({ ...state, title: 'Mine' }))
  assert.equal(fires, 0)
})
