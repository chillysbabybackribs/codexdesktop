import type { ModelRerouteReason } from '../../shared/codex-protocol/v2/ModelRerouteReason'
import type { ThreadTokenUsage } from '../../shared/codex-protocol/v2/ThreadTokenUsage'
import type { TokenUsageBreakdown } from '../../shared/codex-protocol/v2/TokenUsageBreakdown'
import type { TurnDiffSummary } from './diff'

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

export type TurnTokenTelemetry = {
  /** Usage accumulated across every model call observed for this turn. */
  turn: TokenUsageBreakdown
  /** Usage from the most recent individual model call. */
  latestCall: TokenUsageBreakdown
  /** App-server's cumulative usage for the thread at the latest update. */
  threadTotalAtEnd: TokenUsageBreakdown
  modelContextWindow: number | null
  modelCallCount: number
}

export type TurnMeta = {
  status: TurnMetaStatus
  origin?: TurnTelemetryOrigin
  requestedModel?: string | null
  model?: string | null
  workspace?: string | null
  startedAtMs?: number
  completedAtMs?: number
  durationMs?: number
  errorMessage?: string
  errorEvents?: TurnErrorEvent[]
  modelReroutes?: TurnModelReroute[]
  tokens?: TurnTokenTelemetry
  diffSummary?: TurnDiffSummary
}

export type TurnTelemetryState = Record<string, TurnMeta>

export type TurnTelemetryAction =
  | { type: 'patch'; turnId: string; patch: Partial<TurnMeta> }
  | { type: 'tokenUsage'; turnId: string; tokenUsage: ThreadTokenUsage }
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
      next = { ...current, tokens: accumulateTokenUsage(current.tokens, action.tokenUsage) }
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
  incoming: ThreadTokenUsage
): TurnTokenTelemetry {
  if (!current) {
    return {
      turn: cloneUsage(incoming.last),
      latestCall: cloneUsage(incoming.last),
      threadTotalAtEnd: cloneUsage(incoming.total),
      modelContextWindow: incoming.modelContextWindow,
      modelCallCount: incoming.last.totalTokens > 0 ? 1 : 0
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

  return {
    turn: addUsage(current.turn, totalDelta),
    latestCall: cloneUsage(incoming.last),
    threadTotalAtEnd: cloneUsage(incoming.total),
    modelContextWindow: incoming.modelContextWindow,
    modelCallCount: current.modelCallCount + 1
  }
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
