import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ClaudeTurnTranslator,
  claudeContextWindowFor,
  turnStartedNotification,
  type ClaudeTurnContext
} from '../../shared/claude-events.ts'
import {
  emptySessionState,
  reduceSessionNotification,
  type SessionRenderState
} from './session-store.ts'
import type { TokenUsageBreakdown } from '../../shared/session-protocol/index.ts'

// End-to-end contract: spike-shaped SDK messages → translator → the SAME
// reducer the UI renders from. If this passes, a Claude turn renders.

function makeContext(): { context: ClaudeTurnContext; totals: () => TokenUsageBreakdown } {
  let total: TokenUsageBreakdown = {
    totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0
  }
  const context: ClaudeTurnContext = {
    threadId: 'claude-t1',
    turnId: 'claude-t1-turn1',
    nowMs: () => 1_000_000,
    tokens: {
      contextWindow: 200_000,
      addLast(last) {
        total = {
          totalTokens: total.totalTokens + last.totalTokens,
          inputTokens: total.inputTokens + last.inputTokens,
          cachedInputTokens: total.cachedInputTokens + last.cachedInputTokens,
          outputTokens: total.outputTokens + last.outputTokens,
          reasoningOutputTokens: 0
        }
        return { total, last }
      }
    }
  }
  return { context, totals: () => total }
}

// Message fixtures shaped exactly like the spike capture.
const init = { type: 'system', subtype: 'init', session_id: 'sdk-session-1', model: 'claude-opus-4-8' }
const blockStart = (index: number, block: Record<string, unknown>) =>
  ({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: block } })
const messageStart = (id: string) =>
  ({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
const textDelta = (index: number, text: string) =>
  ({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } })
const blockStop = (index: number) => ({ type: 'stream_event', event: { type: 'content_block_stop', index } })
const result = (usage: Record<string, number>, subtype = 'success') =>
  ({ type: 'result', subtype, usage, duration_ms: 2500 })

function replayTurn(messages: unknown[], userText: string): {
  state: SessionRenderState
  sessionId: string | null
  context: ClaudeTurnContext
} {
  const { context } = makeContext()
  const translator = new ClaudeTurnTranslator(context)
  const reduceContext = { atMs: 1_000_000, fallbackModel: 'claude-opus-4-8', workspace: '/tmp/ws' }
  let state = reduceSessionNotification(emptySessionState(), turnStartedNotification(context, userText), reduceContext)
  let sessionId: string | null = null
  for (const message of messages) {
    const translation = translator.handle(message)
    if (translation.sessionId) sessionId = translation.sessionId
    for (const notification of translation.notifications) {
      state = reduceSessionNotification(state, notification, reduceContext)
    }
  }
  return { state, sessionId, context }
}

test('a full claude turn renders through the shared reducer', () => {
  const { state, sessionId } = replayTurn([
    init,
    blockStart(0, { type: 'text' }),
    textDelta(0, 'Hel'),
    textDelta(0, 'lo!'),
    blockStop(0),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello!' }] } },
    result({ input_tokens: 4, cache_read_input_tokens: 100, output_tokens: 12 })
  ], 'Say hello')

  assert.equal(sessionId, 'sdk-session-1')
  assert.equal(state.turnId, null, 'turn completed')
  const user = state.items.find((item) => item.type === 'userMessage')
  assert.ok(user, 'authoritative user message present')
  const assistant = state.items.find((item) => item.type === 'agentMessage')
  assert.equal((assistant as { text: string }).text, 'Hello!')
  assert.equal(state.turnMeta['claude-t1-turn1']?.status, 'completed')
  assert.equal(state.contextUsage?.last.totalTokens, 116)
  assert.equal(state.contextUsage?.modelContextWindow, 200_000)
  assert.equal(state.turnMeta['claude-t1-turn1']?.tokens?.modelCallCount, 1)
})

test('thinking blocks render as reasoning; tool_use renders as a tool call that completes', () => {
  const { state } = replayTurn([
    init,
    messageStart('msg-tool'),
    blockStart(0, { type: 'thinking' }),
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering…' } } },
    blockStop(0),
    blockStart(1, { type: 'tool_use', id: 'toolu_123', name: 'Bash' }),
    blockStop(1),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_123', is_error: false }] } },
    messageStart('msg-answer'),
    blockStart(0, { type: 'text' }),
    textDelta(0, 'done'),
    blockStop(0),
    result({ input_tokens: 10, output_tokens: 5 })
  ], 'run something')

  const reasoning = state.items.find((item) => item.type === 'reasoning')
  assert.deepEqual((reasoning as { summary: string[] }).summary, ['pondering…'])
  const tool = state.items.find((item) => item.type === 'mcpToolCall')
  assert.equal((tool as { status: string }).status, 'completed')
  assert.equal((tool as { tool: string }).tool, 'Bash')
  const answer = state.items.find((item) => item.id.includes('msg-answer'))
  assert.equal((answer as { text: string }).text, 'done')
})

test('content-block indexes are scoped to each assistant message', () => {
  const { state } = replayTurn([
    messageStart('msg-first'),
    blockStart(0, { type: 'text' }),
    textDelta(0, 'first'),
    blockStop(0),
    { type: 'assistant', message: { id: 'msg-first', content: [{ type: 'text', text: 'first' }] } },
    messageStart('msg-second'),
    blockStart(0, { type: 'text' }),
    textDelta(0, 'second response'),
    blockStop(0),
    { type: 'assistant', message: { id: 'msg-second', content: [{ type: 'text', text: 'second response' }] } }
  ], 'use a tool')

  const messages = state.items.filter((item) => item.type === 'agentMessage') as Array<{ id: string; text: string }>
  assert.deepEqual(messages.map(({ text }) => text), ['first', 'second response'])
  assert.equal(new Set(messages.map(({ id }) => id)).size, 2)
})

test('rate-limit and SDK error details survive into the failed turn', () => {
  const { state } = replayTurn([
    {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 2_000_000_000 }
    },
    {
      type: 'result',
      subtype: 'error_during_execution',
      usage: { input_tokens: 1, output_tokens: 0 },
      errors: ['provider detail'],
      duration_ms: 20
    }
  ], 'continue')

  const meta = state.turnMeta['claude-t1-turn1']
  assert.equal(meta?.status, 'failed')
  assert.match(meta?.errorMessage ?? '', /usage limit reached/i)
  assert.equal(meta?.error?.codexErrorInfo, 'usageLimitExceeded')
})

test('a failed result marks the turn failed with the error message', () => {
  const { state } = replayTurn([
    init,
    result({ input_tokens: 1, output_tokens: 0 }, 'error_during_execution')
  ], 'boom')
  assert.equal(state.turnMeta['claude-t1-turn1']?.status, 'failed')
  assert.match(state.turnMeta['claude-t1-turn1']?.errorMessage ?? '', /claude turn ended/)
})

test('token totals accumulate across turns via the injected accumulator', () => {
  const { context } = makeContext()
  const first = new ClaudeTurnTranslator(context).handle(result({ input_tokens: 10, output_tokens: 5 }))
  const second = new ClaudeTurnTranslator(context).handle(result({ input_tokens: 20, output_tokens: 5 }))
  const firstUsage = (first.notifications[0] as unknown as { params: { tokenUsage: { total: TokenUsageBreakdown } } }).params.tokenUsage
  const secondUsage = (second.notifications[0] as unknown as { params: { tokenUsage: { total: TokenUsageBreakdown } } }).params.tokenUsage
  assert.equal(firstUsage.total.totalTokens, 15)
  assert.equal(secondUsage.total.totalTokens, 40)
})

test('context window inference: 1m-tagged models get the large window', () => {
  assert.equal(claudeContextWindowFor('claude-opus-4-8[1m]'), 1_000_000)
  assert.equal(claudeContextWindowFor('claude-opus-4-8'), 200_000)
  assert.equal(claudeContextWindowFor(null), 200_000)
})
