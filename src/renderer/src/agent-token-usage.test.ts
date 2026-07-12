import assert from 'node:assert/strict'
import test from 'node:test'
import { agentTokenUsage } from './agent-token-usage.ts'

test('maps Anthropic cache writes as input but not cache hits', () => {
  const tokenUsage = agentTokenUsage(
    { inputTokens: 100, outputTokens: 7, cacheReadInputTokens: 80, cacheCreationInputTokens: 20, costUsd: 0 },
    { inputTokens: 150, outputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 30, costUsd: 0 },
    { currentTokens: 198, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 0.1, autoCompactThreshold: 180_000, isAutoCompactEnabled: true }
  )

  assert.deepEqual(tokenUsage.last, {
    inputTokens: 200,
    cachedInputTokens: 80,
    outputTokens: 7,
    reasoningOutputTokens: 0,
    totalTokens: 207
  })
  assert.equal(tokenUsage.total.totalTokens, 290)
  assert.equal(tokenUsage.modelContextWindow, 200_000)
})
