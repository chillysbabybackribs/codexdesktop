export type AgentProvider = 'codex' | 'claude'

export type AgentConnectionStatus = 'idle' | 'starting' | 'ready' | 'exited' | 'error'

export type AgentModel = {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  inputModalities: Array<'text' | 'image'>
  supportedEfforts: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>
}

export type AgentSessionSummary = {
  id: string
  title: string
  cwd: string | null
  createdAt: number | null
  updatedAt: number
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
  | { type: 'compaction.completed'; provider: AgentProvider; sessionId: string; beforeTokens: number; afterTokens: number | null }
  | { type: 'turn.completed'; provider: AgentProvider; sessionId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted'; result: string | null; error: string | null; usage: AgentUsage }
