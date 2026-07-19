import type { TurnMeta } from './TaskActivity'
import type { TurnTrace, TurnTraceEvent } from './trace-types'

export function usageAccounting(tokens: TurnMeta['tokens'] | undefined): NonNullable<TurnTrace['usage']['accounting']> {
  const turn = tokens?.turn
  const latest = tokens?.latestCall
  const calls = tokens?.modelCallCount ?? 0
  const contextWindow = tokens?.modelContextWindow

  return {
    turnTotalSemantics: 'accumulatedAcrossModelCalls',
    latestModelCallSemantics: 'singleMostRecentCall',
    threadTotalAtEndSemantics: 'cumulativeThreadCounterSnapshot',
    uncachedInputTokens: turn ? Math.max(0, turn.inputTokens - turn.cachedInputTokens) : null,
    cachedInputPercent: turn && turn.inputTokens > 0
      ? roundPercent(turn.cachedInputTokens / turn.inputTokens)
      : null,
    latestCallContextPercent: latest && contextWindow && contextWindow > 0
      ? roundPercent(latest.inputTokens / contextWindow)
      : null,
    averageTokensPerModelCall: turn && calls > 0 ? Math.round(turn.totalTokens / calls) : null
  }
}

export function traceTiming(meta: TurnMeta | undefined, timeline: TurnTraceEvent[]): NonNullable<TurnTrace['timing']> {
  const intervals = timeline.flatMap((event) => {
    const start = event.startedAt ? Date.parse(event.startedAt) : Number.NaN
    let end = event.completedAt ? Date.parse(event.completedAt) : Number.NaN
    if (!Number.isFinite(end) && Number.isFinite(start) && typeof event.durationMs === 'number') {
      end = start + event.durationMs
    }
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [[start, end] as const] : []
  }).sort((left, right) => left[0] - right[0])

  let attributedDurationMs = 0
  let activeStart: number | null = null
  let activeEnd: number | null = null
  for (const [start, end] of intervals) {
    if (activeStart === null || activeEnd === null) {
      activeStart = start
      activeEnd = end
    } else if (start <= activeEnd) {
      activeEnd = Math.max(activeEnd, end)
    } else {
      attributedDurationMs += activeEnd - activeStart
      activeStart = start
      activeEnd = end
    }
  }
  if (activeStart !== null && activeEnd !== null) attributedDurationMs += activeEnd - activeStart

  const wallDurationMs = turnDuration(meta) ?? null
  const unattributedDurationMs = wallDurationMs === null
    ? null
    : Math.max(0, wallDurationMs - attributedDurationMs)

  return {
    wallDurationMs,
    attributedDurationMs,
    unattributedDurationMs,
    attributionPercent: wallDurationMs && wallDurationMs > 0
      ? roundPercent(Math.min(1, attributedDurationMs / wallDurationMs))
      : null,
    timedEventCount: intervals.length,
    method: 'unionOfVisibleEventSpans'
  }
}

export function turnDuration(meta: TurnMeta | undefined): number | undefined {
  if (typeof meta?.durationMs === 'number') return meta.durationMs
  if (meta?.startedAtMs && meta.completedAtMs) return Math.max(0, meta.completedAtMs - meta.startedAtMs)
  return undefined
}

function roundPercent(ratio: number): number {
  return Math.round(ratio * 1_000) / 10
}
