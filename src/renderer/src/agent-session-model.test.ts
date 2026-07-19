import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendAgentSessionMessage,
  agentSessionsForMainChatTab,
  applyAgentDeltas,
  collapseAdjacentAssistantDuplicates,
  completeAgentMessage,
  createAgentSession,
  createReviewerSession,
  defaultReviewerModel,
  latestAuditReport,
  parseAgentDock,
  resetAgentSession,
  reviewerTitle,
  serializeAgentDock,
  stripMainChatContext,
  updateAgentSession
} from './agent-session-model.ts'
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
