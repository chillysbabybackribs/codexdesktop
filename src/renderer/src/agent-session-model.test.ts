import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendAgentSessionMessage,
  agentSessionsForMainChatTab,
  applyAgentDeltas,
  buildAgentRoster,
  collapseAdjacentAssistantDuplicates,
  completeAgentMessage,
  createAgentSession,
  createReviewerSession,
  createWorkerSession,
  defaultReviewerModel,
  dockRoleFlags,
  dockRoleOf,
  latestAuditReport,
  parseAgentDock,
  resetAgentSession,
  reviewerTitle,
  rollupStatus,
  serializeAgentDock,
  stripMainChatContext,
  updateAgentSession
} from './agent-session-model.ts'
import type { AgentSession } from './agent-session-model.ts'
import type { Model } from '../../shared/session-protocol'

test('agent session updates preserve unrelated sessions', () => {
  const first = createAgentSession('one', 'Agent 2')
  const second = createAgentSession('two', 'Agent 3')
  const updated = updateAgentSession([first, second], 'one', (session) => ({ ...session, status: 'working' }))

  assert.equal(updated[0]?.status, 'working')
  assert.equal(updated[1], second)
})

test('agent windows belong to one main chat tab', () => {
  const first = createAgentSession('one', 'Agent 2', 'tab-a')
  const second = createAgentSession('two', 'Agent 3', 'tab-b')
  const legacy = createAgentSession('legacy', 'Agent 4')

  assert.deepEqual(
    agentSessionsForMainChatTab([first, second, legacy], 'tab-a').map((session) => session.key),
    ['one'],
  )
  assert.deepEqual(
    agentSessionsForMainChatTab([first, second, legacy], 'tab-b').map((session) => session.key),
    ['two'],
  )
})

test('resetting an agent starts a fresh chat in the same configured slot', () => {
  const session = {
    ...createAgentSession('one', 'Agent 2'),
    threadId: 'thread-1',
    status: 'done' as const,
    messages: [{ id: 'answer', role: 'assistant' as const, text: 'Complete' }],
    watchesMain: true,
    auditsMain: false,
    model: 'gpt-5'
  }
  const reset = resetAgentSession(session)

  assert.equal(reset.key, 'one')
  assert.equal(reset.title, 'Agent 2')
  assert.equal(reset.model, 'gpt-5')
  assert.equal(reset.watchesMain, true)
  assert.equal(reset.threadId, null)
  assert.deepEqual(reset.messages, [])
})

test('agent messages dedupe terminal errors and complete streamed text', () => {
  const session = createAgentSession('one', 'Agent 2')
  const message = { id: 'error-turn', role: 'assistant' as const, text: 'failed' }
  const once = appendAgentSessionMessage([session], 'one', message, true)
  const twice = appendAgentSessionMessage(once, 'one', message, true)
  const completed = completeAgentMessage(twice, 'one', 'error-turn', 'final failure')

  assert.equal(completed[0]?.messages.length, 1)
  assert.equal(completed[0]?.messages[0]?.text, 'final failure')
})

test('buffered deltas append in order and create missing assistant messages', () => {
  const session = {
    ...createAgentSession('one', 'Agent 2'),
    messages: [{ id: 'answer', role: 'assistant' as const, text: 'Hello' }]
  }
  const result = applyAgentDeltas([session], new Map([
    ['one', new Map([['answer', ' world'], ['second', 'Next']])]
  ]))

  assert.deepEqual(result[0]?.messages.map(({ id, text }) => ({ id, text })), [
    { id: 'answer', text: 'Hello world' },
    { id: 'second', text: 'Next' }
  ])
})

test('buffered deltas preserve unaffected session and message identity', () => {
  const untouchedMessage = { id: 'untouched-message', role: 'assistant' as const, text: 'Settled' }
  const updatedMessage = { id: 'answer', role: 'assistant' as const, text: 'Hello' }
  const first = {
    ...createAgentSession('one', 'Agent 2'),
    messages: [untouchedMessage, updatedMessage]
  }
  const second = {
    ...createAgentSession('two', 'Agent 3'),
    messages: [{ id: 'other', role: 'assistant' as const, text: 'Other' }]
  }

  const result = applyAgentDeltas([first, second], new Map([
    ['one', new Map([['answer', ' world']])]
  ]))

  assert.equal(result[1], second)
  assert.equal(result[0]?.messages[0], untouchedMessage)
  assert.notEqual(result[0]?.messages[1], updatedMessage)
  assert.equal(result[0]?.messages[1]?.text, 'Hello world')
})

test('agent dock persistence keeps only durable metadata', () => {
  const session = {
    ...createAgentSession('one', 'Research'),
    threadId: 'thread-1',
    watchesMain: true,
    auditsMain: false,
    model: 'gpt-5',
    reasoningEffort: 'high'
  }
  const raw = serializeAgentDock(4, [session], ['one'], 'one')

  assert.deepEqual(parseAgentDock(raw), {
    counter: 4,
    sessions: [{
      mainChatTabKey: null,
      threadId: 'thread-1',
      title: 'Research',
      watchesMain: true,
      auditsMain: false,
      reportsToMain: false,
      sendPolicyDecided: false,
      model: 'gpt-5',
      reasoningEffort: 'high',
      open: true,
      selected: true
    }]
  })
  assert.equal(parseAgentDock('{broken'), null)
})

test('new agents are born reviewers: audit armed, send policy undecided', () => {
  const session = createReviewerSession('one', 'Reviewer', 'tab-a', 'claude-default')
  assert.equal(session.auditsMain, true)
  assert.equal(session.reportsToMain, false)
  assert.equal(session.sendPolicyDecided, false)
  assert.equal(session.model, 'claude-default')
  assert.equal(session.mainChatTabKey, 'tab-a')
})

test('reviewer titles count per owning tab', () => {
  const sessions = [
    createReviewerSession('a', 'Reviewer', 'tab-a', null),
    createReviewerSession('b', 'Reviewer 2', 'tab-a', null),
    { ...createAgentSession('c', 'Research', 'tab-a'), title: 'Research' },
    createReviewerSession('d', 'Reviewer', 'tab-b', null)
  ]
  assert.equal(reviewerTitle(sessions, 'tab-a'), 'Reviewer 3')
  assert.equal(reviewerTitle(sessions, 'tab-b'), 'Reviewer 2')
  assert.equal(reviewerTitle(sessions, 'tab-c'), 'Reviewer')
})

const model = (id: string, providerId: string | undefined, extra: Record<string, unknown> = {}): Model =>
  ({ id, model: id, providerId, hidden: false, isDefault: false, ...extra }) as unknown as Model

test('reviewer model defaults cross-family in both pairing directions', () => {
  const models = [
    model('gpt-5', 'codex', { isDefault: true }),
    model('gpt-5-mini', 'codex'),
    model('claude-default', 'claude'),
    model('claude:opus', 'claude')
  ]
  // Codex doer → claude reviewer (account default preferred).
  assert.equal(defaultReviewerModel('gpt-5', models), 'claude-default')
  // Null main model means the CLI default (codex) → still cross-family.
  assert.equal(defaultReviewerModel(null, models), 'claude-default')
  // Claude doer → codex reviewer (catalog default preferred).
  assert.equal(defaultReviewerModel('claude:opus', models), 'gpt-5')
})

test('reviewer model derivation respects hidden models and single-provider setups', () => {
  const single = [model('gpt-5', 'codex', { isDefault: true }), model('gpt-5-mini', 'codex')]
  // One family only: null — the agent follows the main chat's model.
  assert.equal(defaultReviewerModel('gpt-5', single), null)

  const hiddenOther = [
    model('gpt-5', 'codex'),
    model('claude:opus', 'claude', { hidden: true })
  ]
  assert.equal(defaultReviewerModel('gpt-5', hiddenOther), null)

  // Models without providerId count as codex (the host runtime).
  const legacy = [model('gpt-5', undefined), model('claude-default', 'claude')]
  assert.equal(defaultReviewerModel('gpt-5', legacy), 'claude-default')
})

test('main chat context is removed from restored helper messages', () => {
  assert.equal(stripMainChatContext('<main-chat-context>summary</main-chat-context>\n\nQuestion'), 'Question')
  assert.equal(stripMainChatContext('Question'), 'Question')
})

test('latestAuditReport returns the final reply to the newest audit briefing only', () => {
  const audit = { userText: 'do it', files: ['a.ts'], steps: [], answerText: '' }
  assert.equal(
    latestAuditReport([
      { id: 'u1', role: 'user', text: '[auto-audit] …', audit },
      { id: 'a1', role: 'assistant', text: 'Checking the diff.' },
      { id: 'a2', role: 'assistant', text: 'Bug found.\nVERDICT: flag' }
    ]),
    'Bug found.\nVERDICT: flag',
    'interim narration stays out of the forwarded report'
  )
  assert.equal(
    latestAuditReport([
      { id: 'u1', role: 'user', text: '[auto-audit] …', audit },
      { id: 'a1', role: 'assistant', text: 'Fine.\nVERDICT: pass' },
      { id: 'u2', role: 'user', text: 'unrelated manual question' },
      { id: 'a2', role: 'assistant', text: 'manual answer' }
    ]),
    null,
    'a manual exchange after the audit is never treated as a report'
  )
  assert.equal(latestAuditReport([{ id: 'u1', role: 'user', text: '[auto-audit] …', audit }]), null, 'no reply yet')
  assert.equal(latestAuditReport([]), null)
})

test('adjacent identical assistant messages collapse; non-adjacent repeats stay', () => {
  // Stream-restate artifact shape: the same reply persisted under two item
  // ids (threads recorded before the translator dedupe fix keep this forever).
  const collapsed = collapseAdjacentAssistantDuplicates([
    { id: 'u1', role: 'user', text: 'audit this' },
    { id: 'a1', role: 'assistant', text: 'Looks solid.' },
    { id: 'a2', role: 'assistant', text: 'Looks solid.' },
    { id: 'a3', role: 'assistant', text: 'A different follow-up.' }
  ])
  assert.deepEqual(collapsed.map(({ id }) => id), ['u1', 'a1', 'a3'])

  const separated = collapseAdjacentAssistantDuplicates([
    { id: 'a1', role: 'assistant', text: 'ok' },
    { id: 'u1', role: 'user', text: 'again?' },
    { id: 'a2', role: 'assistant', text: 'ok' }
  ])
  assert.deepEqual(separated.map(({ id }) => id), ['a1', 'u1', 'a2'])
})

function workingSession(session: AgentSession): AgentSession {
  return { ...session, status: 'working' }
}
function doneSession(session: AgentSession): AgentSession {
  return { ...session, status: 'done' }
}

test('createWorkerSession links to its parent and never audits', () => {
  const worker = createWorkerSession('w1', 'summarize', 'tab-1', 'lead-1', 'turn-9', 'gpt-x')
  assert.equal(worker.role, 'worker')
  assert.equal(worker.parentAgentKey, 'lead-1')
  assert.equal(worker.spawnedByTurnId, 'turn-9')
  assert.equal(worker.mainChatTabKey, 'tab-1')
  assert.equal(worker.model, 'gpt-x')
  assert.equal(worker.auditsMain, false)
})

test('createAgentSession defaults to a parentless reviewer', () => {
  const session = createAgentSession('a', 'Reviewer')
  assert.equal(session.role, 'reviewer')
  assert.equal(session.parentAgentKey, null)
  assert.equal(session.spawnedByTurnId, null)
})

test('buildAgentRoster nests workers under their lead', () => {
  const lead = { ...createAgentSession('lead', 'Lead', 'tab'), role: 'lead' as const }
  const workerA = createWorkerSession('wa', 'A', 'tab', 'lead', 'turn-1', null)
  const workerB = createWorkerSession('wb', 'B', 'tab', 'lead', 'turn-1', null)
  const roster = buildAgentRoster([lead, workerA, workerB])
  assert.equal(roster.length, 1)
  assert.equal(roster[0].session.key, 'lead')
  assert.deepEqual(roster[0].children.map((node) => node.session.key), ['wa', 'wb'])
})

test('buildAgentRoster promotes an orphan whose parent is absent', () => {
  // Parent closed but the worker is still around — it must not vanish.
  const orphan = createWorkerSession('wa', 'A', 'tab', 'missing-lead', 'turn-1', null)
  const roster = buildAgentRoster([orphan])
  assert.equal(roster.length, 1)
  assert.equal(roster[0].session.key, 'wa')
  assert.equal(roster[0].children.length, 0)
})

test('buildAgentRoster preserves top-level order', () => {
  const first = { ...createAgentSession('one', 'One', 'tab'), role: 'lead' as const }
  const second = { ...createAgentSession('two', 'Two', 'tab'), role: 'lead' as const }
  const roster = buildAgentRoster([first, second])
  assert.deepEqual(roster.map((node) => node.session.key), ['one', 'two'])
})

test('rollupStatus reports working when any descendant is working', () => {
  const lead = { ...createAgentSession('lead', 'Lead', 'tab'), role: 'lead' as const }
  const busyWorker = workingSession(createWorkerSession('w', 'A', 'tab', 'lead', 't', null))
  const [node] = buildAgentRoster([lead, busyWorker])
  assert.equal(node.rollup, 'working')
})

test('rollupStatus reports done when the subtree only completed', () => {
  const lead = doneSession({ ...createAgentSession('lead', 'Lead', 'tab'), role: 'lead' as const })
  const doneWorker = doneSession(createWorkerSession('w', 'A', 'tab', 'lead', 't', null))
  const [node] = buildAgentRoster([lead, doneWorker])
  assert.equal(node.rollup, 'done')
})

test('rollupStatus surfaces attention over working so a failed child never hides', () => {
  const lead = { ...createAgentSession('lead', 'Lead', 'tab'), role: 'lead' as const }
  const busyWorker = workingSession(createWorkerSession('w1', 'A', 'tab', 'lead', 't', null))
  const failedWorker = createWorkerSession('w2', 'B', 'tab', 'lead', 't', null)
  const [node] = buildAgentRoster([lead, busyWorker, failedWorker], new Set(['w2']))
  assert.equal(node.rollup, 'attention')
})

test('rollupStatus is idle for a lone idle node', () => {
  const lead = { ...createAgentSession('lead', 'Lead', 'tab'), role: 'lead' as const }
  const [node] = buildAgentRoster([lead])
  assert.equal(node.rollup, 'idle')
})

test('dockRoleOf derives the card radio from session state', () => {
  assert.equal(dockRoleOf(createReviewerSession('r', 'Reviewer', 'tab', null)), 'reviewer')
  assert.equal(
    dockRoleOf({ ...createAgentSession('h', 'Helper', 'tab'), watchesMain: true }),
    'helper'
  )
  assert.equal(dockRoleOf(createWorkerSession('w', 'task', 'tab', 'lead', 'turn', null)), 'worker')
  // Legacy restore states: neither flag reads as the born-a-reviewer default;
  // both flags read as reviewer (audit wins). Re-picking the shown role
  // re-arms the flags, so both states heal on first touch.
  assert.equal(dockRoleOf(createAgentSession('n', 'Agent', 'tab')), 'reviewer')
  assert.equal(
    dockRoleOf({ ...createAgentSession('b', 'Agent', 'tab'), watchesMain: true, auditsMain: true }),
    'reviewer'
  )
})

test('dockRoleFlags arms exactly one flag and round-trips through dockRoleOf', () => {
  assert.deepEqual(dockRoleFlags('reviewer'), { auditsMain: true, watchesMain: false })
  assert.deepEqual(dockRoleFlags('helper'), { auditsMain: false, watchesMain: true })
  for (const role of ['reviewer', 'helper'] as const) {
    const session = { ...createAgentSession('x', 'Agent', 'tab'), ...dockRoleFlags(role) }
    assert.equal(dockRoleOf(session), role)
  }
})
