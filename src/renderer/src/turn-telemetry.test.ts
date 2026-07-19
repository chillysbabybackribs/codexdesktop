import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadTokenUsage } from '../../shared/session-protocol/index.ts'
import type { ThreadItem } from '../../shared/session-protocol/index.ts'
import {
  accumulateTokenUsage,
  maxModelCallSamples,
  modelCallAttributionForItem,
  reduceTurnTelemetry
} from './turn-telemetry.ts'

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
  const first = accumulateTokenUsage(undefined, tokenUpdate(12_000, 112_000), {
    atMs: 1_000,
    precedingItem: {
      itemId: 'user-1',
      itemType: 'userMessage',
      label: 'User prompt',
      argumentChars: 80,
      resultChars: null
    }
  })
  const second = accumulateTokenUsage(first, tokenUpdate(8_000, 120_000), {
    atMs: 2_000,
    precedingItem: {
      itemId: 'tool-1',
      itemType: 'dynamicToolCall',
      label: 'research_web',
      argumentChars: 120,
      resultChars: 2_400
    },
    compactedBeforeCall: true
  })

  assert.deepEqual(first.turn, usage(12_000))
  assert.deepEqual(second.turn, usage(20_000))
  assert.deepEqual(second.latestCall, usage(8_000))
  assert.deepEqual(second.threadTotalAtEnd, usage(120_000))
  assert.equal(second.modelCallCount, 2)
  assert.equal(second.modelCalls.length, 2)
  assert.deepEqual(second.modelCalls[0], {
    sequence: 1,
    atMs: 1_000,
    usage: usage(12_000),
    uncachedInputTokens: 4_800,
    contextWindow: 200_000,
    contextPercent: 3.6,
    inputDeltaFromPrevious: null,
    compactedBeforeCall: false,
    precedingItem: {
      itemId: 'user-1',
      itemType: 'userMessage',
      label: 'User prompt',
      argumentChars: 80,
      resultChars: null
    }
  })
  assert.equal(second.modelCalls[1]?.inputDeltaFromPrevious, -2_400)
  assert.equal(second.modelCalls[1]?.compactedBeforeCall, true)
  assert.equal(second.modelCalls[1]?.precedingItem?.resultChars, 2_400)
})

test('duplicate token notifications do not inflate usage or model-call count', () => {
  const first = accumulateTokenUsage(undefined, tokenUpdate(12_000, 112_000))
  const duplicate = accumulateTokenUsage(first, tokenUpdate(12_000, 112_000))

  assert.deepEqual(duplicate.turn, usage(12_000))
  assert.equal(duplicate.modelCallCount, 1)
  assert.equal(duplicate.modelCalls.length, 1)
})

test('model-call samples stay bounded while preserving their global sequence', () => {
  let telemetry = accumulateTokenUsage(undefined, tokenUpdate(1, 1))

  for (let sequence = 2; sequence <= maxModelCallSamples + 3; sequence += 1) {
    telemetry = accumulateTokenUsage(telemetry, tokenUpdate(sequence, sequence))
  }

  assert.equal(telemetry.modelCallCount, maxModelCallSamples + 3)
  assert.equal(telemetry.modelCalls.length, maxModelCallSamples)
  assert.equal(telemetry.modelCalls[0]?.sequence, 4)
  assert.equal(telemetry.droppedModelCallSamples, 3)
})

test('tool attribution records model-visible argument and result sizes', () => {
  const item: ThreadItem = {
    type: 'dynamicToolCall',
    id: 'tool-1',
    namespace: null,
    tool: 'browser_run',
    arguments: { code: 'return document.title' },
    status: 'completed',
    contentItems: [{ type: 'inputText', text: '{"title":"Example"}' }],
    success: true,
    durationMs: 12
  }

  assert.deepEqual(modelCallAttributionForItem(item), {
    itemId: 'tool-1',
    itemType: 'dynamicToolCall',
    label: 'browser_run',
    argumentChars: JSON.stringify(item.arguments).length,
    resultChars: JSON.stringify(item.contentItems).length
  })
})

test('screenshot attribution excludes the raw vision data while retaining text metadata', () => {
  const text = JSON.stringify({ ok: true, result: { screenshot: { fileName: 'composer.png' } } })
  const item: ThreadItem = {
    type: 'dynamicToolCall',
    id: 'screenshot-1',
    namespace: null,
    tool: 'app_screenshot',
    arguments: {},
    status: 'completed',
    contentItems: [
      { type: 'inputText', text },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,this-is-not-text-output' }
    ],
    success: true,
    durationMs: 12
  }

  const attribution = modelCallAttributionForItem(item)
  assert.equal(attribution?.resultChars, JSON.stringify([{ type: 'inputText', text }]).length)
  assert.notEqual(attribution?.resultChars, JSON.stringify(item.contentItems).length)
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
