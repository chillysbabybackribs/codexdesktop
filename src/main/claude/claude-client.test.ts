import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentEvent, AgentUsage } from '../../shared/agent.ts'
import { ClaudeClient } from './claude-client.ts'

type CompletionEmitter = {
  emitTurnCompleted: (
    runtime: { sessionId: string },
    turn: { id: string; interrupted: boolean },
    result: string | null,
    error: string | null,
    usage: AgentUsage
  ) => void
}

const usage: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0
}

function completionEvent(interrupted: boolean, error: string | null): AgentEvent {
  const client = new ClaudeClient({} as never, {} as never)
  let emitted: AgentEvent | null = null
  client.once('event', (event: AgentEvent) => {
    emitted = event
  })

  const emitter = client as unknown as CompletionEmitter
  emitter.emitTurnCompleted(
    { sessionId: 'session-1' },
    { id: 'turn-1', interrupted },
    null,
    error,
    usage
  )

  assert.ok(emitted)
  return emitted
}

test('Claude interruption drops SDK diagnostics from the user-facing completion event', () => {
  const event = completionEvent(
    true,
    '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'
  )

  assert.equal(event.type, 'turn.completed')
  if (event.type !== 'turn.completed') return
  assert.equal(event.status, 'interrupted')
  assert.equal(event.error, null)
})

test('Claude failures preserve actionable errors', () => {
  const event = completionEvent(false, 'Authentication failed')

  assert.equal(event.type, 'turn.completed')
  if (event.type !== 'turn.completed') return
  assert.equal(event.status, 'failed')
  assert.equal(event.error, 'Authentication failed')
})
