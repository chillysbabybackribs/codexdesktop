import type { ThreadItem, TokenUsageBreakdown } from '../../shared/session-protocol'
import type { ItemMeta, TurnMeta, TurnPlanItem } from './TaskActivity'

export type SystemTraceItem = {
  type: 'system'
  id: string
  level: string
  text: string
}

export type TraceInputItem = ThreadItem | TurnPlanItem | SystemTraceItem

export type TurnTraceEvent = {
  index: number
  id: string
  type: string
  label: string
  status?: string | null
  startedAt?: string
  completedAt?: string
  durationMs?: number | null
  details: Record<string, unknown>
}

export type TraceTruncation = {
  path: string
  reason: 'sizeLimit' | 'omitted'
  capturedCharacters?: number
  omittedCharacters?: number
}

export type TraceSource = {
  url: string
  label: string
  host: string
  kind: 'official' | 'firsthand' | 'projectRecord' | 'other'
}

export type TraceArtifact = {
  path: string
  kind: 'researchCapsule' | 'generatedFile' | 'workspaceChange'
  originEventId: string
  availability: 'pathOnly'
}

export type TurnTrace = {
  schemaVersion: 2 | 3 | 4 | 5
  exportedAt: string
  capture: {
    source: 'live' | 'restored' | 'unknown'
    completeness: 'complete' | 'partial'
    missing: string[]
    fidelity?: 'full' | 'bounded'
    truncations?: TraceTruncation[]
  }
  thread: {
    id: string | null
    title: string
  }
  turn: {
    id: string
    status: string
    startedAt?: string
    completedAt?: string
    durationMs?: number
    error?: string
    errorEvents?: NonNullable<TurnMeta['errorEvents']>
  }
  environment: {
    requestedModel: string | null
    model: string | null
    reasoningEffort: string | null
    workspace: string | null
    modelReroutes: NonNullable<TurnMeta['modelReroutes']>
  }
  browser?: NonNullable<TurnMeta['browserDecision']>
  agents?: {
    runs: NonNullable<TurnMeta['agentRuns']>
  }
  usage: {
    turn: TokenUsageBreakdown | null
    latestModelCall: TokenUsageBreakdown | null
    threadTotalAtEnd: TokenUsageBreakdown | null
    modelContextWindow: number | null
    modelCallCount: number
    modelCalls?: NonNullable<TurnMeta['tokens']>['modelCalls']
    droppedModelCallSamples?: number
    accounting?: {
      turnTotalSemantics: 'accumulatedAcrossModelCalls'
      latestModelCallSemantics: 'singleMostRecentCall'
      threadTotalAtEndSemantics: 'cumulativeThreadCounterSnapshot'
      uncachedInputTokens: number | null
      cachedInputPercent: number | null
      latestCallContextPercent: number | null
      averageTokensPerModelCall: number | null
    }
  }
  summary: {
    itemCount: number
    commandCount: number
    browserToolCount: number
    toolCallCount?: number
    structuredToolCallCount?: number
    executionCount?: number
    failedCommandCount?: number
    fileChangeCount: number
    searchCount?: number
    searchEventCount?: number
    skillCount: number
  }
  timing?: {
    wallDurationMs: number | null
    attributedDurationMs: number
    unattributedDurationMs: number | null
    attributionPercent: number | null
    timedEventCount: number
    method: 'unionOfVisibleEventSpans'
  }
  sourceIndex?: {
    scope: 'finalResponseCitations'
    items: TraceSource[]
  }
  artifactIndex?: {
    scope: 'visibleTurnEvents'
    items: TraceArtifact[]
  }
  goal?: {
    objective: string
    statusAtStart: string | null
    statusAtEnd: string | null
    tokenBudget: number | null
    tokensUsedAtStart: number | null
    tokensUsedAtEnd: number | null
    tokensUsedDelta: number | null
    timeUsedSecondsAtStart: number | null
    timeUsedSecondsAtEnd: number | null
    timeUsedSecondsDelta: number | null
    continuation: boolean
    continuationInferred: boolean
    lifecycleChanged: boolean
    completionClaimed: boolean
    observedCompletionEvidence: {
      finalResponsePresent: boolean
      citationCount: number
      artifactCount: number
      successfulCommandCount: number
      failedCommandCount: number
      successfulStructuredToolCount: number
      failedStructuredToolCount: number
      successfulResearchToolCount: number
      fileChangeCount: number
    }
  }
  skills: Array<{ name: string; path: string }>
  prompt: string
  finalResponse: string
  timeline: TurnTraceEvent[]
}

export type BuildTurnTraceParams = {
  threadId: string | null
  threadTitle: string
  turnId: string
  model: string | null
  workspace: string | null
  items: TraceInputItem[]
  itemMeta: Record<string, ItemMeta>
  meta: TurnMeta | undefined
}
