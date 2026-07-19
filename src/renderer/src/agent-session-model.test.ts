import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendAgentSessionMessage,
  applyAgentDeltas,
  completeAgentMessage,
  createAgentSession,
  parseAgentDock,
  resetAgentSession,
  serializeAgentDock,
  stripMainChatContext,
  updateAgentSession
} from './agent-session-model.ts'

test('agent session updates preserve unrelated sessions', () => {
  const first = createAgentSession('one', 'Agent 2')
  const second = createAgentSession('two', 'Agent 3')
  const updated = updateAgentSession([first, second], 'one', (session) => ({ ...session, status: 'working' }))

  assert.equal(updated[0]?.status, 'working')
  assert.equal(updated[1], second)
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
      threadId: 'thread-1',
      title: 'Research',
      watchesMain: true,
      auditsMain: false,
      model: 'gpt-5',
      reasoningEffort: 'high',
      open: true,
      selected: true
    }]
  })
  assert.equal(parseAgentDock('{broken'), null)
})

test('main chat context is removed from restored helper messages', () => {
  assert.equal(stripMainChatContext('<main-chat-context>summary</main-chat-context>\n\nQuestion'), 'Question')
  assert.equal(stripMainChatContext('Question'), 'Question')
})
