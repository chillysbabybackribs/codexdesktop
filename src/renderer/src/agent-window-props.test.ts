import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentSession } from './agent-session-model.ts'
import type { LiveTurnGlance } from './audit-trigger.ts'
import type { SessionStore } from './session-store.ts'
import {
  areAgentWindowPropsEqual,
  isSameLiveGlance,
  type AgentWindowProps
} from './agent-window-props.ts'

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    key: 'agent-1',
    mainChatTabKey: null,
    role: 'reviewer',
    parentAgentKey: null,
    spawnedByTurnId: null,
    threadId: 'thread-1',
    title: 'Reviewer',
    status: 'idle',
    turnId: null,
    messages: [],
    watchesMain: false,
    auditsMain: false,
    reportsToMain: false,
    sendPolicyDecided: false,
    lastAuditNote: null,
    model: null,
    reasoningEffort: null,
    contextUsage: null,
    isCompacting: false,
    ...overrides
  }
}

function makeGlance(overrides: Partial<LiveTurnGlance> = {}): LiveTurnGlance {
  return {
    turnId: 'turn-1',
    stepCount: 3,
    fileCount: 1,
    lastStep: 'Checking git status',
    ...overrides
  }
}

const noop = (): void => {}
const asyncTrue = async (): Promise<boolean> => true
const asyncVoid = async (): Promise<void> => {}

function makeProps(overrides: Partial<AgentWindowProps> = {}): AgentWindowProps {
  return {
    session: makeSession(),
    isSelected: false,
    isExtended: false,
    sessionStore: {} as SessionStore,
    workspace: '/tmp/project',
    models: [],
    mainModel: 'gpt-5',
    mainReasoningEffort: null,
    liveMainTurn: null,
    onSetModel: noop,
    onSetModelEffort: noop,
    onSelect: noop,
    onMinimize: noop,
    onCloseSession: noop,
    onResetSession: noop,
    onPromote: noop,
    onSetRole: noop,
    onToggleReport: noop,
    onSendFeedback: noop,
    onDecideSendPolicy: noop,
    onToggleExtend: noop,
    onSend: asyncTrue,
    onSteer: asyncTrue,
    onStop: asyncVoid,
    onCompact: asyncVoid,
    ...overrides
  }
}

test('areAgentWindowPropsEqual treats identical props as equal', () => {
  const props = makeProps()
  assert.equal(areAgentWindowPropsEqual(props, props), true)
})

test('areAgentWindowPropsEqual ignores unlisted prop churn (callbacks, store, workspace)', () => {
  const previous = makeProps()
  const next = makeProps({
    session: previous.session,
    models: previous.models,
    onSelect: () => {},
    sessionStore: {} as SessionStore,
    workspace: '/somewhere/else'
  })
  assert.equal(areAgentWindowPropsEqual(previous, next), true)
})

test('areAgentWindowPropsEqual detects session, selection, and model changes', () => {
  const previous = makeProps()
  assert.equal(
    areAgentWindowPropsEqual(previous, { ...previous, session: makeSession() }),
    false
  )
  assert.equal(areAgentWindowPropsEqual(previous, { ...previous, isSelected: true }), false)
  assert.equal(areAgentWindowPropsEqual(previous, { ...previous, isExtended: true }), false)
  assert.equal(areAgentWindowPropsEqual(previous, { ...previous, models: [] }), false)
  assert.equal(areAgentWindowPropsEqual(previous, { ...previous, mainModel: 'o4' }), false)
  assert.equal(
    areAgentWindowPropsEqual(previous, { ...previous, mainReasoningEffort: 'high' }),
    false
  )
})

test('non-auditor windows skip live-glance updates', () => {
  const session = makeSession({ auditsMain: false })
  const previous = makeProps({ session, liveMainTurn: makeGlance() })
  const next = { ...previous, liveMainTurn: makeGlance({ stepCount: 9 }) }
  assert.equal(areAgentWindowPropsEqual(previous, next), true)
})

test('auditor windows re-render when the nested glance changes', () => {
  const session = makeSession({ auditsMain: true })
  const previous = makeProps({ session, liveMainTurn: makeGlance() })
  const next = { ...previous, liveMainTurn: makeGlance({ stepCount: 9 }) }
  assert.equal(areAgentWindowPropsEqual(previous, next), false)
})

test('auditor windows treat value-equal glances as equal across references', () => {
  const session = makeSession({ auditsMain: true })
  const previous = makeProps({ session, liveMainTurn: makeGlance() })
  const next = { ...previous, liveMainTurn: makeGlance() }
  assert.equal(areAgentWindowPropsEqual(previous, next), true)
})

test('isSameLiveGlance compares by value and handles nulls', () => {
  const glance = makeGlance()
  assert.equal(isSameLiveGlance(glance, glance), true)
  assert.equal(isSameLiveGlance(null, null), true)
  assert.equal(isSameLiveGlance(glance, null), false)
  assert.equal(isSameLiveGlance(null, glance), false)
  assert.equal(isSameLiveGlance(glance, makeGlance()), true)
  assert.equal(isSameLiveGlance(glance, makeGlance({ turnId: 'turn-2' })), false)
  assert.equal(isSameLiveGlance(glance, makeGlance({ stepCount: 4 })), false)
  assert.equal(isSameLiveGlance(glance, makeGlance({ fileCount: 2 })), false)
  assert.equal(isSameLiveGlance(glance, makeGlance({ lastStep: null })), false)
})
