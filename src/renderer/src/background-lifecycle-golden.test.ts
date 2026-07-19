import assert from 'node:assert/strict'
import test from 'node:test'
import type { ServerNotification } from '../../shared/session-protocol/index.ts'
import type { ThreadItem } from '../../shared/session-protocol/index.ts'
import type { Turn } from '../../shared/session-protocol/index.ts'
import { SessionStore, emptySessionState, reduceSessionNotification } from './session-store.ts'

test('golden background replay: an inactive session retains its completed work without touching the active session', () => {
  const store = new SessionStore()
  const activeKey = 'main-thread'
  const backgroundKey = 'background-thread'
  const item = {
    type: 'agentMessage',
    id: 'message-golden',
    text: 'Background work finished.',
    phase: null,
    memoryCitation: null
  } as unknown as ThreadItem
  const running = {
    id: 'turn-golden',
    items: [item],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: 100,
    completedAt: null,
    durationMs: null
  } as unknown as Turn
  const completed = { ...running, status: 'completed', completedAt: 120, durationMs: 20 } as Turn
  const notify = (method: string, turn: Turn): ServerNotification =>
    ({ method, params: { threadId: 'thread-golden', turn } } as unknown as ServerNotification)
  const context = { atMs: 130_000, fallbackModel: 'gpt-test', workspace: '/tmp/golden' }

  store.set(activeKey, emptySessionState({ threadId: 'main-thread', title: 'Active' }))
  store.set(backgroundKey, emptySessionState({ threadId: 'thread-golden', title: 'Background' }))
  const activeBefore = store.get(activeKey)
  store.update(backgroundKey, (state) => reduceSessionNotification(state, notify('turn/started', running), context))
  store.update(backgroundKey, (state) => reduceSessionNotification(state, notify('turn/completed', completed), context))

  const background = store.get(backgroundKey)
  assert.equal(store.get(activeKey), activeBefore, 'background events must not mutate the focused transcript')
  assert.equal(background.turnId, null)
  assert.equal(background.turnMeta['turn-golden']?.status, 'completed')
  assert.equal(background.items[0]?.id, 'message-golden')
})
