import type { ModelRerouteReason } from '../../shared/session-protocol'
import type { ReasoningEffort } from '../../shared/session-protocol'
import type { ThreadGoal } from '../../shared/session-protocol'
import type { ThreadItem } from '../../shared/session-protocol'
import type { ThreadTokenUsage } from '../../shared/session-protocol'
import type { TokenUsageBreakdown } from '../../shared/session-protocol'
import type { TurnDiffSummary } from './diff'
import type { AgentRunStatus, AgentWakeStatus, BrowserDecisionEvent } from '../../shared/ipc'

export type TurnMetaStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted'
export type TurnTelemetryOrigin = 'live' | 'restored'

export type TurnModelReroute = {
  atMs: number
  fromModel: string
  toModel: string
  reason: ModelRerouteReason
}

export type TurnErrorEvent = {
  atMs: number
  message: string
  willRetry: boolean
}

export type ModelCallAttribution = {
  itemId: string
  itemType: string
  label: string
  argumentChars: number | null
  resultChars: number | null
}

export type ModelCallSample = {
  sequence: number
  atMs: number | null
  usage: TokenUsageBreakdown
  uncachedInputTokens: number
  contextWindow: number | null
  contextPercent: number | null
  inputDeltaFromPrevious: number | null
  compactedBeforeCall: boolean
  precedingItem: ModelCallAttribution | null
}

export const maxModelCallSamples = 128

export type TurnTokenTelemetry = {
  /** Usage accumulated across every model call observed for this turn. */
  turn: TokenUsageBreakdown
  /** Usage from the most recent individual model call. */
  latestCall: TokenUsageBreakdown
  /** App-server's cumulative usage for the thread at the latest update. */
  threadTotalAtEnd: TokenUsageBreakdown
  modelContextWindow: number | null
  modelCallCount: number
  /** Bounded exact per-call samples, oldest retained sample first. */
  modelCalls: ModelCallSample[]
  droppedModelCallSamples: number
}

export type TurnMeta = {
  status: TurnMetaStatus
  origin?: TurnTelemetryOrigin
  requestedModel?: string | null
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
  workspace?: string | null
  goalAtStart?: ThreadGoal | null
  goalAtEnd?: ThreadGoal | null
  goalContinuation?: boolean
  goalContinuationInferred?: boolean
  startedAtMs?: number
  completedAtMs?: number
  durationMs?: number
  errorMessage?: string
  errorEvents?: TurnErrorEvent[]
  modelReroutes?: TurnModelReroute[]
  tokens?: TurnTokenTelemetry
  diffSummary?: TurnDiffSummary
  browserDecision?: Omit<BrowserDecisionEvent, 'type' | 'threadId' | 'turnId'>
  agentRuns?: Array<{
    id: string
    provider: 'app' | 'codex' | 'claude'
    status: AgentRunStatus
    wakeStatus: AgentWakeStatus
    durationMs: number | null
  }>
}

export type TurnTelemetryState = Record<string, TurnMeta>

export type TurnTelemetryAction =
  | { type: 'patch'; turnId: string; patch: Partial<TurnMeta> }
  | {
      type: 'tokenUsage'
      turnId: string
      tokenUsage: ThreadTokenUsage
      atMs?: number
      precedingItem?: ModelCallAttribution | null
      compactedBeforeCall?: boolean
    }
  | {
      type: 'modelRerouted'
      turnId: string
      atMs: number
      fromModel: string
      toModel: string
      reason: ModelRerouteReason
    }
  | { type: 'error'; turnId: string; atMs: number; message: string; willRetry: boolean }

const emptyUsage: TokenUsageBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0
}

export function reduceTurnTelemetry(
  state: TurnTelemetryState,
  action: TurnTelemetryAction
): TurnTelemetryState {
  const current = state[action.turnId] ?? { status: 'inProgress' }
  let next: TurnMeta

  switch (action.type) {
    case 'patch':
      next = { ...current, ...action.patch }
      break
    case 'tokenUsage':
      next = {
        ...current,
        tokens: accumulateTokenUsage(current.tokens, action.tokenUsage, {
          atMs: action.atMs,
          precedingItem: action.precedingItem,
          compactedBeforeCall: action.compactedBeforeCall
        })
      }
      break
    case 'modelRerouted':
      next = {
        ...current,
        model: action.toModel,
        modelReroutes: [
          ...(current.modelReroutes ?? []),
          {
            atMs: action.atMs,
            fromModel: action.fromModel,
            toModel: action.toModel,
            reason: action.reason
          }
        ].slice(-10)
      }
      break
    case 'error': {
      const errorEvents = [
        ...(current.errorEvents ?? []),
        { atMs: action.atMs, message: action.message, willRetry: action.willRetry }
      ].slice(-20)
      next = action.willRetry
        ? { ...current, errorEvents }
        : {
            ...current,
            status: 'failed',
            completedAtMs: action.atMs,
            errorMessage: action.message,
            errorEvents
          }
      break
    }
  }

  if (shallowEqualTurnMeta(current, next)) return state
  return { ...state, [action.turnId]: next }
}

export function accumulateTokenUsage(
  current: TurnTokenTelemetry | undefined,
  incoming: ThreadTokenUsage,
  sampleContext: {
    atMs?: number
    precedingItem?: ModelCallAttribution | null
    compactedBeforeCall?: boolean
  } = {}
): TurnTokenTelemetry {
  if (!current) {
    const modelCallCount = incoming.last.totalTokens > 0 ? 1 : 0
    return {
      turn: cloneUsage(incoming.last),
      latestCall: cloneUsage(incoming.last),
      threadTotalAtEnd: cloneUsage(incoming.total),
      modelContextWindow: incoming.modelContextWindow,
      modelCallCount,
      modelCalls: modelCallCount > 0
        ? [buildModelCallSample(1, incoming, null, sampleContext)]
        : [],
      droppedModelCallSamples: 0
    }
  }

  const totalDelta = subtractUsage(incoming.total, current.threadTotalAtEnd)
  const totalAdvanced = totalDelta.totalTokens > 0

  if (!totalAdvanced) {
    return {
      ...current,
      latestCall: cloneUsage(incoming.last),
      threadTotalAtEnd: cloneUsage(incoming.total),
      modelContextWindow: incoming.modelContextWindow
    }
  }

  const sample = buildModelCallSample(
    current.modelCallCount + 1,
    incoming,
    current.latestCall,
    sampleContext
  )
  const modelCalls = [...current.modelCalls, sample]
  const droppedNow = Math.max(0, modelCalls.length - maxModelCallSamples)

  return {
    turn: addUsage(current.turn, totalDelta),
    latestCall: cloneUsage(incoming.last),
    threadTotalAtEnd: cloneUsage(incoming.total),
    modelContextWindow: incoming.modelContextWindow,
    modelCallCount: current.modelCallCount + 1,
    modelCalls: modelCalls.slice(-maxModelCallSamples),
    droppedModelCallSamples: current.droppedModelCallSamples + droppedNow
  }
}

export function modelCallAttributionForItem(item: ThreadItem): ModelCallAttribution | null {
  switch (item.type) {
    case 'userMessage':
      return attribution(item, 'User prompt', serializedChars(item.content), null)
    case 'hookPrompt':
      return attribution(item, 'Hook prompt', serializedChars(item.fragments), null)
    case 'commandExecution':
      return attribution(item, 'Shell command', item.command.length, item.aggregatedOutput?.length ?? null)
    case 'fileChange':
      return attribution(
        item,
        'File change',
        null,
        item.changes.reduce((sum, change) => sum + change.diff.length, 0)
      )
    case 'mcpToolCall':
      return attribution(
        item,
        `${item.server}/${item.tool}`,
        serializedChars(item.arguments),
        serializedChars(item.result ?? item.error)
      )
    case 'dynamicToolCall':
      return attribution(
        item,
        item.namespace ? `${item.namespace}/${item.tool}` : item.tool,
        serializedChars(item.arguments),
        dynamicToolTextChars(item.contentItems)
      )
    case 'collabAgentToolCall':
      return attribution(item, item.tool, item.prompt?.length ?? null, serializedChars(item.agentsStates))
    case 'webSearch':
      return attribution(item, 'Web search', item.query.length, serializedChars(item.action))
    case 'imageView':
      return attribution(item, 'Image view', item.path.length, null)
    case 'imageGeneration':
      return attribution(item, 'Image generation', item.revisedPrompt?.length ?? null, item.result.length)
    default:
      return null
  }
}

function buildModelCallSample(
  sequence: number,
  incoming: ThreadTokenUsage,
  previous: TokenUsageBreakdown | null,
  context: {
    atMs?: number
    precedingItem?: ModelCallAttribution | null
    compactedBeforeCall?: boolean
  }
): ModelCallSample {
  const usage = cloneUsage(incoming.last)
  const contextWindow = incoming.modelContextWindow

  return {
    sequence,
    atMs: context.atMs ?? null,
    usage,
    uncachedInputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
    contextWindow,
    contextPercent: contextWindow && contextWindow > 0
      ? roundPercent(usage.inputTokens / contextWindow)
      : null,
    inputDeltaFromPrevious: previous ? usage.inputTokens - previous.inputTokens : null,
    compactedBeforeCall: context.compactedBeforeCall ?? false,
    precedingItem: context.precedingItem ? { ...context.precedingItem } : null
  }
}

function attribution(
  item: ThreadItem,
  label: string,
  argumentChars: number | null,
  resultChars: number | null
): ModelCallAttribution {
  return {
    itemId: item.id,
    itemType: item.type,
    label,
    argumentChars,
    resultChars
  }
}

function serializedChars(value: unknown): number | null {
  if (value === null || value === undefined) return null
  try {
    return JSON.stringify(value).length
  } catch {
    return null
  }
}

function dynamicToolTextChars(contentItems: Extract<ThreadItem, { type: 'dynamicToolCall' }>['contentItems']): number | null {
  if (!contentItems) return null
  return serializedChars(contentItems
    .filter((item) => item.type === 'inputText')
    .map((item) => ({ type: item.type, text: item.text })))
}

function roundPercent(value: number): number {
  return Math.round(value * 10_000) / 100
}

function addUsage(left: TokenUsageBreakdown, right: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens
  }
}

function subtractUsage(next: TokenUsageBreakdown, previous: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: Math.max(0, next.totalTokens - previous.totalTokens),
    inputTokens: Math.max(0, next.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, next.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(0, next.reasoningOutputTokens - previous.reasoningOutputTokens)
  }
}

function cloneUsage(value: TokenUsageBreakdown | undefined): TokenUsageBreakdown {
  return value ? { ...value } : { ...emptyUsage }
}

function shallowEqualTurnMeta(left: TurnMeta, right: TurnMeta): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof TurnMeta>
  return [...keys].every((key) => Object.is(left[key], right[key]))
}
