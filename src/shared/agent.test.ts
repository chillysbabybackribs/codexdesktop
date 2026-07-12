import assert from 'node:assert/strict'
import test from 'node:test'
import { agentModelKey, parseAgentModelKey } from './agent.ts'

test('provider-qualified model keys round-trip without delimiter collisions', () => {
  const ref = { provider: 'claude' as const, model: 'claude:model::with/slashes' }
  assert.deepEqual(parseAgentModelKey(agentModelKey(ref)), ref)
})

test('provider-qualified model keys reject malformed and unknown providers', () => {
  assert.equal(parseAgentModelKey('not-json'), null)
  assert.equal(parseAgentModelKey('["other","model"]'), null)
  assert.equal(parseAgentModelKey('["codex",""]'), null)
})
