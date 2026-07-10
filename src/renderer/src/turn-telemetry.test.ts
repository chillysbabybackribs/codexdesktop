import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadTokenUsage } from '../../shared/codex-protocol/v2/ThreadTokenUsage.ts'
import { accumulateTokenUsage, reduceTurnTelemetry } from './turn-telemetry.ts'

function usage(totalTokens: number): ThreadTokenUsage['last'] {
  return {
    totalTokens,
    inputTokens: Math.floor(totalTokens * 0.6),
    cachedInputTokens: Math.floor(totalTokens * 0.2),
    outputTokens: Math.floor(totalTokens * 0.3),
    reasoningOutputTokens: Math.floor(totalTokens * 0.1)
  }
}

function tokenUpdate(last: number, total: number): ThreadTokenUsage {
  return {
    last: usage(last),
    total: usage(total),
    modelContextWindow: 200_000
  }
}

test('accumulateTokenUsage separates the whole turn, latest call, and thread total', () => {
  const first = accumulateTokenUsage(undefined, tokenUpdate(12_000, 112_000))
  const second = accumulateTokenUsage(first, tokenUpdate(8_000, 120_000))

  assert.deepEqual(first.turn, usage(12_000))
  assert.deepEqual(second.turn, usage(20_000))
  assert.deepEqual(second.latestCall, usage(8_000))
  assert.deepEqual(second.threadTotalAtEnd, usage(120_000))
  assert.equal(second.modelCallCount, 2)
})

test('duplicate token notifications do not inflate usage or model-call count', () => {
  const first = accumulateTokenUsage(undefined, tokenUpdate(12_000, 112_000))
  const duplicate = accumulateTokenUsage(first, tokenUpdate(12_000, 112_000))

  assert.deepEqual(duplicate.turn, usage(12_000))
  assert.equal(duplicate.modelCallCount, 1)
})

test('retryable errors remain non-terminal while final errors fail the turn', () => {
  const retrying = reduceTurnTelemetry({}, {
    type: 'error',
    turnId: 'turn-1',
    atMs: 1_000,
    message: 'temporary transport error',
    willRetry: true
  })

  assert.equal(retrying['turn-1']?.status, 'inProgress')
  assert.equal(retrying['turn-1']?.errorEvents?.[0]?.willRetry, true)

  const failed = reduceTurnTelemetry(retrying, {
    type: 'error',
    turnId: 'turn-1',
    atMs: 2_000,
    message: 'retry exhausted',
    willRetry: false
  })

  assert.equal(failed['turn-1']?.status, 'failed')
  assert.equal(failed['turn-1']?.completedAtMs, 2_000)
  assert.equal(failed['turn-1']?.errorEvents?.length, 2)
})

test('model reroutes update the effective model and retain the transition', () => {
  const state = reduceTurnTelemetry({}, {
    type: 'modelRerouted',
    turnId: 'turn-1',
    atMs: 1_000,
    fromModel: 'model-a',
    toModel: 'model-b',
    reason: 'highRiskCyberActivity'
  })

  assert.equal(state['turn-1']?.model, 'model-b')
  assert.deepEqual(state['turn-1']?.modelReroutes?.[0], {
    atMs: 1_000,
    fromModel: 'model-a',
    toModel: 'model-b',
    reason: 'highRiskCyberActivity'
  })
})
