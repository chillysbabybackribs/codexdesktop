import type { AgentContextUsage, AgentUsage } from '../../shared/agent'
import type { ThreadTokenUsage } from '../../shared/codex-protocol/v2/ThreadTokenUsage'
import type { TokenUsageBreakdown } from '../../shared/codex-protocol/v2/TokenUsageBreakdown'

export function agentTokenUsage(
  usage: AgentUsage,
  totalUsage: AgentUsage,
  context: AgentContextUsage | null
): ThreadTokenUsage {
  return {
    last: usageBreakdown(usage),
    total: usageBreakdown(totalUsage),
    modelContextWindow: context?.maxTokens ?? null
  }
}

function usageBreakdown(usage: AgentUsage): TokenUsageBreakdown {
  // Anthropic reports fresh input, cache writes, and cache reads separately.
  // All three occupy the input context, but only reads are cache hits.
  const inputTokens = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
  return {
    inputTokens,
    cachedInputTokens: usage.cacheReadInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + usage.outputTokens
  }
}
