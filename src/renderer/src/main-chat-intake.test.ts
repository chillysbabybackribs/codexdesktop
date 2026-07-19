import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDeclinedInjection,
  buildExecutionInjection,
  buildPlanBriefing,
  buildRestateInjection,
  isNoPlan,
  lastAgentMessageText,
  latestAssistantText,
  noPlanReason,
  pickIntakeReviewer,
  reviewerDisplayLabel,
  stripIntakeInjections,
} from './main-chat-intake.ts'
import {
  createAgentSession,
  createReviewerSession,
  createWorkerSession,
} from './agent-session-model.ts'
import type { AgentLiteMessage } from './agent-session-model.ts'

test('pickIntakeReviewer finds only a Reviewer-role agent on the right tab', () => {
  const reviewer = createReviewerSession('r', 'Reviewer', 'tab-a', null)
  const otherTab = createReviewerSession('o', 'Reviewer', 'tab-b', null)
  const worker = createWorkerSession('w', 'task', 'tab-a', 'lead', null, null)
  const helper = { ...createAgentSession('h', 'Helper', 'tab-a'), watchesMain: true }

  assert.equal(pickIntakeReviewer([worker, helper, reviewer], 'tab-a')?.key, 'r')
  assert.equal(pickIntakeReviewer([otherTab, worker, helper], 'tab-a'), null)
  assert.equal(pickIntakeReviewer([], 'tab-a'), null)
})

test('reviewerDisplayLabel resolves the model display name', () => {
  const reviewer = { ...createReviewerSession('r', 'Reviewer', 'tab', 'claude-x') }
  const models = [{ id: 'claude-x', displayName: 'Claude X' }] as never
  assert.equal(reviewerDisplayLabel(reviewer, models), 'Reviewer (Claude X)')
  assert.equal(reviewerDisplayLabel({ ...reviewer, model: 'unknown-id' }, models), 'Reviewer (unknown-id)')
  assert.equal(reviewerDisplayLabel({ ...reviewer, model: null }, models), 'Reviewer')
  assert.equal(reviewerDisplayLabel(null, models), 'your reviewer')
})

test('intake injections strip cleanly, preserving the user text', () => {
  const user = 'build me a thing\nwith two lines'
  const restate = `${user}${buildRestateInjection('Reviewer (Claude X)')}`
  const withPlan = `${user}${buildExecutionInjection('1. do it\n2. verify', 'Reviewer (Claude X)')}`
  const noPlan = `${user}${buildExecutionInjection(null, 'Reviewer (Claude X)')}`
  const declined = `${user}${buildDeclinedInjection('the user asked a question')}`

  for (const composed of [restate, withPlan, noPlan, declined]) {
    assert.notEqual(composed, user)
    assert.equal(stripIntakeInjections(composed), user)
  }
  assert.equal(stripIntakeInjections(user), user)
})

test('restate injection names the reviewer and forbids starting', () => {
  const injection = buildRestateInjection('Reviewer (Claude X)')
  assert.match(injection, /Reviewer \(Claude X\)/)
  assert.match(injection, /Do NOT begin the task/)
  assert.match(injection, /confirm/)
})

test('plan briefing carries all three texts and the NO-PLAN escape', () => {
  const briefing = buildPlanBriefing({
    original: 'the original ask',
    restatement: 'the doer read',
    reply: 'yes but skip tests',
    doerLabel: 'GPT-5.6-Sol',
  })
  assert.match(briefing, /the original ask/)
  assert.match(briefing, /the doer read/)
  assert.match(briefing, /yes but skip tests/)
  assert.match(briefing, /GPT-5\.6-Sol/)
  assert.match(briefing, /NO-PLAN/)
  assert.match(briefing, /done-criteria/)
})

test('NO-PLAN detection and reason extraction', () => {
  assert.equal(isNoPlan('NO-PLAN: the user asked a question'), true)
  assert.equal(isNoPlan('  no-plan — declined'), true)
  assert.equal(isNoPlan('1. First step'), false)
  assert.equal(isNoPlan('NOPE'), false)
  assert.equal(noPlanReason('NO-PLAN: the user asked a question'), 'the user asked a question')
  assert.equal(noPlanReason('NO-PLAN — declined'), 'declined')
  assert.equal(noPlanReason('NO-PLAN'), '')
})

test('latestAssistantText returns the reply only once it exists', () => {
  const briefing: AgentLiteMessage = { id: 'u1', role: 'user', text: 'plan this' }
  const reply: AgentLiteMessage = { id: 'a1', role: 'assistant', text: '1. do it' }
  const blank: AgentLiteMessage = { id: 'a0', role: 'assistant', text: '  ' }

  assert.equal(latestAssistantText([]), null)
  assert.equal(latestAssistantText([briefing]), null)
  assert.equal(latestAssistantText([briefing, blank]), null)
  assert.equal(latestAssistantText([briefing, reply]), '1. do it')
  assert.equal(latestAssistantText([reply, briefing]), null)
})

test('lastAgentMessageText reads the newest agent message from thread items', () => {
  const items = [
    { type: 'userMessage' },
    { type: 'agentMessage', text: 'first' },
    { type: 'commandExecution' },
    { type: 'agentMessage', text: 'the restatement' },
    { type: 'reasoning' },
  ]
  assert.equal(lastAgentMessageText(items), 'the restatement')
  assert.equal(lastAgentMessageText([{ type: 'userMessage' }]), null)
  assert.equal(lastAgentMessageText([]), null)
})
