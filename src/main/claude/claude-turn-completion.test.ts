import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeClaudeCompletion } from './claude-turn-completion.ts'

test('Claude interruption drops SDK diagnostics from the user-facing completion', () => {
  assert.deepEqual(
    normalizeClaudeCompletion(
      true,
      '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'
    ),
    { status: 'interrupted', error: null }
  )
})

test('Claude failures preserve actionable errors', () => {
  assert.deepEqual(
    normalizeClaudeCompletion(false, 'Authentication failed'),
    { status: 'failed', error: 'Authentication failed' }
  )
})

test('Claude success remains a clean completion', () => {
  assert.deepEqual(
    normalizeClaudeCompletion(false, null),
    { status: 'completed', error: null }
  )
})
