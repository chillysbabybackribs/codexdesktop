import assert from 'node:assert/strict'
import test from 'node:test'
import { agentZoomStorageKey, storedAgentZoom } from './agent-zoom.ts'

test('agent zoom defaults to 100 percent when no preference is stored', () => {
  assert.equal(storedAgentZoom(null), 100)
})

test('agent zoom preserves and clamps stored preferences', () => {
  assert.equal(agentZoomStorageKey('reviewer'), 'codexdesktop.agent-zoom.reviewer')
  assert.equal(storedAgentZoom('110'), 110)
  assert.equal(storedAgentZoom('60'), 80)
  assert.equal(storedAgentZoom('160'), 140)
  assert.equal(storedAgentZoom('invalid'), 100)
})
