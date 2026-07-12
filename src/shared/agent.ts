export type AgentProvider = 'codex' | 'claude'

export type AgentConnectionStatus = 'idle' | 'starting' | 'ready' | 'exited' | 'error'

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A model identity that remains unambiguous when multiple providers are live. */
export type AgentModelRef = {
  provider: AgentProvider
  model: string
}

/** A persisted provider session. Session ids are only unique within a provider. */
export type AgentSessionRef = {
  provider: AgentProvider
  sessionId: string
}

/** A turn identity scoped through its owning provider session. */
export type AgentTurnRef = AgentSessionRef & {
  turnId: string
}

export type AgentModel = {
  provider: AgentProvider
  id: string
  displayName: string
  description: string
  isDefault: boolean
  inputModalities: Array<'text' | 'image'>
  supportedEfforts: AgentEffort[]
}

export type AgentSessionSummary = {
  provider: AgentProvider
  id: string
  title: string
  cwd: string | null
  createdAt: number | null
  updatedAt: number
}

export function agentModelKey(ref: AgentModelRef): string {
  return JSON.stringify([ref.provider, ref.model])
}

export function parseAgentModelKey(value: string): AgentModelRef | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [provider, model] = parsed
    if ((provider !== 'codex' && provider !== 'claude') || typeof model !== 'string' || !model) return null
    return { provider, model }
  } catch {
    return null
  }
}

export type AgentTranscriptMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export type AgentUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUsd: number
}

export type AgentContextUsage = {
  currentTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  autoCompactThreshold: number | null
  isAutoCompactEnabled: boolean
}

export type AgentEvent =
  | { type: 'status'; provider: AgentProvider; status: AgentConnectionStatus; message?: string }
  | { type: 'session.started'; provider: AgentProvider; sessionId: string; model: string; cwd: string }
  | { type: 'turn.started'; provider: AgentProvider; sessionId: string; turnId: string }
  | { type: 'message.delta'; provider: AgentProvider; sessionId: string; turnId: string; itemId: string; text: string }
  | { type: 'message.completed'; provider: AgentProvider; sessionId: string; turnId: string; itemId: string; blocks: unknown[]; parentToolUseId: string | null }
  | { type: 'reasoning.delta'; provider: AgentProvider; sessionId: string; turnId: string; itemId: string; text: string }
  | { type: 'tool.started'; provider: AgentProvider; sessionId: string; turnId: string; callId: string; name: string; input: unknown }
  | { type: 'tool.completed'; provider: AgentProvider; sessionId: string; turnId: string; callId: string; failed: boolean; content: unknown }
  | { type: 'tool.progress'; provider: AgentProvider; sessionId: string; turnId: string; callId: string; name: string; elapsedSeconds: number }
  | { type: 'tokenUsage.updated'; provider: AgentProvider; sessionId: string; turnId: string; callId: string; usage: AgentUsage; totalUsage: AgentUsage; context: AgentContextUsage | null }
  | { type: 'compaction.completed'; provider: AgentProvider; sessionId: string; beforeTokens: number; afterTokens: number | null }
  | { type: 'turn.completed'; provider: AgentProvider; sessionId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted'; result: string | null; error: string | null; usage: AgentUsage }
