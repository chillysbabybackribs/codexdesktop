import type { ReasoningEffort } from '../codex-protocol/ReasoningEffort.js'
import type { ThreadGoalSetParams } from '../codex-protocol/v2/ThreadGoalSetParams.js'
import type { ChatAttachment } from './attachment-types.js'

export type CodexConnectionStatus = 'idle' | 'starting' | 'ready' | 'exited' | 'error'

export type CodexStatusEvent = {
  type: 'status'
  status: CodexConnectionStatus
  message?: string
}

export type CodexNotificationEvent = {
  type: 'notification'
  notification: unknown
  // Spawn-tree tagging (Phase 1 subagents). Set by the SubagentOrchestrator on
  // events belonging to a spawned child thread so the renderer roster can nest
  // them; absent for ordinary main/dock threads. The wire notification itself
  // is never modified — parentage lives on the envelope only.
  parentThreadId?: string | null
  parentAgentKey?: string | null
  agentKey?: string
}

// Announced the instant a subagent is spawned, before any of its turn events,
// so the renderer can create the worker session and route its stream. Carried
// on the same channel as notifications.
export type AgentSpawnedEvent = {
  type: 'agentSpawned'
  agentKey: string
  parentAgentKey: string | null
  parentThreadId: string | null
  title: string
  model: string | null
}

export type AgentRunProvider = 'app' | 'codex' | 'claude'
export type AgentRunLane = 'model' | 'browser-live' | 'browser-background'
export type AgentRunStatus = 'queued' | 'working' | 'waiting' | 'completed' | 'failed' | 'stopped'
export type AgentWakeStatus = 'none' | 'pending' | 'queued' | 'resumed' | 'suppressed'

export type AgentRunSnapshot = {
  id: string
  nativeId: string
  provider: AgentRunProvider
  lane: AgentRunLane
  parentThreadId: string | null
  parentTurnId: string | null
  parentAgentKey: string | null
  title: string
  task: string | null
  status: AgentRunStatus
  progress: string | null
  resultSummary: string | null
  outputPath: string | null
  wakeStatus: AgentWakeStatus
  startedAtMs: number
  updatedAtMs: number
  completedAtMs: number | null
}

export type AgentRunEvent = {
  type: 'agentRun'
  run: AgentRunSnapshot
}

export type BrowserDecisionEvent = {
  type: 'browserDecision'
  threadId: string
  turnId: string
  provider: 'codex' | 'claude'
  preset: 'quality-max' | 'balanced' | 'manual'
  mode: 'none' | 'live' | 'background' | 'dual'
  required: boolean
  reason: string
}

export type AgentRunCancelParams = {
  provider: 'codex' | 'claude'
  parentThreadId: string
  nativeId: string
}

export type ResearchProgressStage = 'queued' | 'preparing' | 'discovering' | 'verifying' | 'finalizing' | 'complete'

export type ResearchProgress = {
  stage: ResearchProgressStage
  message: string
  queryIndex?: number
  queryCount?: number
  pagesAttempted?: number
  pagesVerified?: number
  targetPages?: number
}

export type CodexResearchProgressEvent = {
  type: 'researchProgress'
  threadId: string
  turnId: string
  itemId: string
  progress: ResearchProgress
}

export type SessionEvent =
  | CodexStatusEvent
  | CodexNotificationEvent
  | CodexResearchProgressEvent
  | AgentSpawnedEvent
  | AgentRunEvent
  | BrowserDecisionEvent
/** @deprecated alias kept for migration; import SessionEvent. */
export type CodexEvent = SessionEvent

export type CodexSendMessageParams = {
  threadId?: string | null
  text: string
  attachments?: ChatAttachment[]
  cwd?: string | null
  /**
   * Model slug to run the turn with. Omitted/null keeps the CLI-configured
   * default (or whatever the thread was last switched to server-side).
   */
  model?: string | null
  /** Reasoning effort override for this turn and subsequent turns. */
  effort?: ReasoningEffort | null
  /** Opt-in: downshift supported simple requests while retaining the selected effort for substantive work. */
  fastMode?: boolean
}

export type CodexStartThreadParams = {
  cwd?: string | null
  model?: string | null
}

export type CodexResumeThreadParams = {
  threadId: string
  history: 'main' | 'background' | 'agent'
}

export type CodexListThreadTurnsParams = {
  threadId: string
  cursor: string
  limit?: number
}

export type CodexSetGoalParams = ThreadGoalSetParams

export type CodexInterruptTurnParams = {
  threadId: string
  turnId: string
}

export type CodexSteerTurnParams = {
  threadId: string
  turnId: string
  text: string
}

export type CodexListThreadsParams = {
  cursor?: string | null
  cwd?: string | null
}

export type CodexPluginQueryParams = {
  cwd?: string | null
}

export type CodexPluginInstallParams = {
  pluginName: string
  marketplacePath?: string | null
  remoteMarketplaceName?: string | null
}

export type CodexPluginReadParams = CodexPluginInstallParams

export type CodexPluginAppStatusParams = {
  appIds: string[]
  forceRefetch?: boolean
}

export type CodexPluginAppStatus = {
  id: string
  name: string
  installUrl: string | null
  isAccessible: boolean
  isEnabled: boolean
}

export type CodexPluginAppStatusResponse = {
  apps: CodexPluginAppStatus[]
}
