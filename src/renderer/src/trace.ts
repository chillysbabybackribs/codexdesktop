import type { ThreadItem } from '../../shared/session-protocol'
import type { TurnMeta } from './TaskActivity'
import type {
  BuildTurnTraceParams,
  TraceArtifact,
  TraceInputItem,
  TraceSource,
  TraceTruncation,
  TurnTrace
} from './trace-types'
import { traceArtifacts } from './trace-artifacts.js'
import { traceSources } from './trace-sources.js'
import { traceEvent } from './trace-timeline.js'
import { traceTruncations } from './trace-truncation.js'
import { traceTiming, turnDuration, usageAccounting } from './trace-usage.js'
import { clip, iso, maxTextChars, singleLine } from './trace-utils.js'

export type * from './trace-types'

export function buildTurnTrace(params: BuildTurnTraceParams): TurnTrace {
  const turnItems = params.items.filter((item) => params.itemMeta[item.id]?.turnId === params.turnId)
  const userItems = turnItems.filter((item): item is Extract<ThreadItem, { type: 'userMessage' }> => item.type === 'userMessage')
  const skills = uniqueSkills(userItems)
  const rawPrompt = userItems
    .flatMap((item) => item.content)
    .filter((content): content is Extract<typeof content, { type: 'text' }> => content.type === 'text')
    .map((content) => stripAutomaticSkillMarker(content.text))
    .join('\n')
  const rawFinalResponse = [...turnItems]
    .reverse()
    .find((item): item is Extract<ThreadItem, { type: 'agentMessage' }> =>
      item.type === 'agentMessage' && item.phase !== 'commentary'
    )?.text ?? ''
  const timeline = turnItems.map((item, index) => traceEvent(item, params.itemMeta[item.id], index))
  const toolItems = turnItems.filter((item) => item.type === 'dynamicToolCall' || item.type === 'mcpToolCall')
  const cleanTitle = stripSkillMarkerFromTitle(params.threadTitle)
  const traceTitle = cleanTitle === 'New Chat' && rawPrompt.trim()
    ? clip(singleLine(rawPrompt), 140)
    : cleanTitle
  const prompt = clip(rawPrompt, maxTextChars)
  const finalResponse = clip(rawFinalResponse, maxTextChars)
  const commandCount = turnItems.filter((item) => item.type === 'commandExecution').length
  const searchEventCount = turnItems.filter((item) => item.type === 'webSearch').length
  const structuredToolCallCount = toolItems.length
  const sources = traceSources(rawFinalResponse)
  const artifacts = traceArtifacts(turnItems)
  const truncations = traceTruncations({
    thread: { title: traceTitle },
    prompt,
    finalResponse,
    timeline
  })
  const capture = traceCapture(params.meta, rawFinalResponse, truncations)
  const goal = goalTrace(params.meta, turnItems, rawFinalResponse, sources, artifacts)

  return {
    schemaVersion: 5,
    exportedAt: new Date().toISOString(),
    capture,
    thread: {
      id: params.threadId,
      title: traceTitle
    },
    turn: {
      id: params.turnId,
      status: params.meta?.status ?? 'unknown',
      ...(iso(params.meta?.startedAtMs) ? { startedAt: iso(params.meta?.startedAtMs) } : {}),
      ...(iso(params.meta?.completedAtMs) ? { completedAt: iso(params.meta?.completedAtMs) } : {}),
      ...(turnDuration(params.meta) !== undefined ? { durationMs: turnDuration(params.meta) } : {}),
      ...(params.meta?.errorMessage ? { error: params.meta.errorMessage } : {}),
      ...(params.meta?.errorEvents?.length ? { errorEvents: params.meta.errorEvents } : {})
    },
    environment: {
      requestedModel: params.meta
        ? (params.meta.requestedModel ?? null)
        : params.model,
      model: valueOrFallback(params.meta?.model, params.model),
      reasoningEffort: params.meta?.reasoningEffort ?? null,
      workspace: valueOrFallback(params.meta?.workspace, params.workspace),
      modelReroutes: params.meta?.modelReroutes ?? []
    },
    ...(params.meta?.browserDecision ? { browser: params.meta.browserDecision } : {}),
    ...(params.meta?.agentRuns?.length ? { agents: { runs: params.meta.agentRuns } } : {}),
    usage: {
      turn: params.meta?.tokens?.turn ?? null,
      latestModelCall: params.meta?.tokens?.latestCall ?? null,
      threadTotalAtEnd: params.meta?.tokens?.threadTotalAtEnd ?? null,
      modelContextWindow: params.meta?.tokens?.modelContextWindow ?? null,
      modelCallCount: params.meta?.tokens?.modelCallCount ?? 0,
      modelCalls: params.meta?.tokens?.modelCalls ?? [],
      droppedModelCallSamples: params.meta?.tokens?.droppedModelCallSamples ?? 0,
      accounting: usageAccounting(params.meta?.tokens)
    },
    summary: {
      itemCount: turnItems.length,
      commandCount,
      browserToolCount: toolItems.filter((item) => item.type === 'dynamicToolCall' && item.tool.startsWith('browser_')).length,
      structuredToolCallCount,
      executionCount: commandCount + structuredToolCallCount + searchEventCount,
      failedCommandCount: turnItems.filter((item) => item.type === 'commandExecution' && item.status === 'failed').length,
      fileChangeCount: turnItems
        .filter((item): item is Extract<ThreadItem, { type: 'fileChange' }> => item.type === 'fileChange')
        .reduce((count, item) => count + item.changes.length, 0),
      searchEventCount,
      skillCount: skills.length
    },
    timing: traceTiming(params.meta, timeline),
    sourceIndex: {
      scope: 'finalResponseCitations',
      items: sources
    },
    artifactIndex: {
      scope: 'visibleTurnEvents',
      items: artifacts
    },
    ...(goal ? { goal } : {}),
    skills,
    prompt: clip(prompt, maxTextChars),
    finalResponse: clip(finalResponse, maxTextChars),
    timeline
  }
}

export function isTurnTrace(value: unknown): value is TurnTrace {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TurnTrace>
  return (
    candidate.schemaVersion === 2 ||
    candidate.schemaVersion === 3 ||
    candidate.schemaVersion === 4 ||
    candidate.schemaVersion === 5
  ) &&
    typeof candidate.exportedAt === 'string' &&
    Boolean(candidate.turn && typeof candidate.turn.id === 'string') &&
    Boolean(candidate.thread && Array.isArray(candidate.timeline))
}

function uniqueSkills(items: Array<Extract<ThreadItem, { type: 'userMessage' }>>): Array<{ name: string; path: string }> {
  const byPath = new Map<string, { name: string; path: string }>()
  for (const item of items) {
    for (const content of item.content) {
      if (content.type === 'skill') byPath.set(content.path, { name: content.name, path: content.path })
    }
  }
  return [...byPath.values()]
}

function traceCapture(
  meta: TurnMeta | undefined,
  finalResponse: string,
  truncations: TraceTruncation[]
): TurnTrace['capture'] {
  const missing: string[] = []
  const source = meta?.origin ?? 'unknown'

  if (!meta) missing.push('turnTelemetry')
  if (!meta?.tokens) missing.push('tokenUsage')
  if (!finalResponse && meta?.status !== 'inProgress') missing.push('finalResponse')
  if (source === 'restored') {
    missing.push('ephemeralExecutionItems', 'structuredSkillSelection')
  }

  return {
    source,
    completeness: missing.length || truncations.length ? 'partial' : 'complete',
    missing,
    fidelity: truncations.length ? 'bounded' : 'full',
    truncations
  }
}

function goalTrace(
  meta: TurnMeta | undefined,
  items: TraceInputItem[],
  finalResponse: string,
  sources: TraceSource[],
  artifacts: TraceArtifact[]
): TurnTrace['goal'] | undefined {
  const start = meta?.goalAtStart ?? null
  const end = meta?.goalAtEnd === undefined ? start : meta.goalAtEnd
  if (!start && !end) return undefined

  const commandItems = items.filter(
    (item): item is Extract<ThreadItem, { type: 'commandExecution' }> => item.type === 'commandExecution'
  )
  const structuredItems = items.filter(
    (item): item is Extract<ThreadItem, { type: 'dynamicToolCall' | 'mcpToolCall' }> =>
      item.type === 'dynamicToolCall' || item.type === 'mcpToolCall'
  )
  const isStructuredSuccess = (item: typeof structuredItems[number]): boolean =>
    item.status === 'completed' && (item.type === 'dynamicToolCall' ? item.success !== false : item.error === null)
  const fileChangeCount = items
    .filter((item): item is Extract<ThreadItem, { type: 'fileChange' }> => item.type === 'fileChange')
    .reduce((count, item) => count + item.changes.length, 0)
  const startTokens = start?.tokensUsed ?? null
  const endTokens = end?.tokensUsed ?? null
  const startTime = start?.timeUsedSeconds ?? null
  const endTime = end?.timeUsedSeconds ?? null

  return {
    objective: end?.objective ?? start?.objective ?? '',
    statusAtStart: start?.status ?? null,
    statusAtEnd: end?.status ?? null,
    tokenBudget: end?.tokenBudget ?? start?.tokenBudget ?? null,
    tokensUsedAtStart: startTokens,
    tokensUsedAtEnd: endTokens,
    tokensUsedDelta: startTokens !== null && endTokens !== null ? Math.max(0, endTokens - startTokens) : null,
    timeUsedSecondsAtStart: startTime,
    timeUsedSecondsAtEnd: endTime,
    timeUsedSecondsDelta: startTime !== null && endTime !== null ? Math.max(0, endTime - startTime) : null,
    continuation: meta?.goalContinuation ?? false,
    continuationInferred: meta?.goalContinuationInferred ?? false,
    lifecycleChanged: Boolean(
      start && (!end || start.status !== end.status || start.objective !== end.objective || start.tokenBudget !== end.tokenBudget)
    ),
    completionClaimed: end?.status === 'complete',
    observedCompletionEvidence: {
      finalResponsePresent: Boolean(finalResponse.trim()),
      citationCount: sources.length,
      artifactCount: artifacts.length,
      successfulCommandCount: commandItems.filter((item) => item.status === 'completed').length,
      failedCommandCount: commandItems.filter((item) => item.status === 'failed' || item.status === 'declined').length,
      successfulStructuredToolCount: structuredItems.filter(isStructuredSuccess).length,
      failedStructuredToolCount: structuredItems.filter((item) =>
        item.status === 'failed' ||
        (item.type === 'dynamicToolCall' ? item.success === false : item.error !== null)
      ).length,
      successfulResearchToolCount: structuredItems.filter((item) =>
        item.type === 'dynamicToolCall' &&
        (item.tool === 'research_web' || item.tool === 'browser_live_search') &&
        isStructuredSuccess(item)
      ).length,
      fileChangeCount
    }
  }
}

function valueOrFallback<T>(value: T | null | undefined, fallback: T | null): T | null {
  return value === undefined ? fallback : value
}

function stripAutomaticSkillMarker(text: string): string {
  return text.replace(/^\$artifact-first-web-research[ \t]*\r?\n/i, '')
}

function stripSkillMarkerFromTitle(title: string): string {
  return title.replace(/^\$artifact-first-web-research\s*/i, '') || 'New Chat'
}
