import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem'
import type { TokenUsageBreakdown } from '../../shared/codex-protocol/v2/TokenUsageBreakdown'
import type { ItemMeta, TurnMeta, TurnPlanItem } from './TaskActivity'

const maxTextChars = 30_000
const maxFieldChars = 8_000

type SystemTraceItem = {
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
  schemaVersion: 2 | 3
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
    workspace: string | null
    modelReroutes: NonNullable<TurnMeta['modelReroutes']>
  }
  usage: {
    turn: TokenUsageBreakdown | null
    latestModelCall: TokenUsageBreakdown | null
    threadTotalAtEnd: TokenUsageBreakdown | null
    modelContextWindow: number | null
    modelCallCount: number
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
  const truncations = traceTruncations({
    thread: { title: traceTitle },
    prompt,
    finalResponse,
    timeline
  })
  const capture = traceCapture(params.meta, rawFinalResponse, truncations)

  return {
    schemaVersion: 3,
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
      workspace: valueOrFallback(params.meta?.workspace, params.workspace),
      modelReroutes: params.meta?.modelReroutes ?? []
    },
    usage: {
      turn: params.meta?.tokens?.turn ?? null,
      latestModelCall: params.meta?.tokens?.latestCall ?? null,
      threadTotalAtEnd: params.meta?.tokens?.threadTotalAtEnd ?? null,
      modelContextWindow: params.meta?.tokens?.modelContextWindow ?? null,
      modelCallCount: params.meta?.tokens?.modelCallCount ?? 0,
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
      items: traceSources(rawFinalResponse)
    },
    artifactIndex: {
      scope: 'visibleTurnEvents',
      items: traceArtifacts(turnItems)
    },
    skills,
    prompt: clip(prompt, maxTextChars),
    finalResponse: clip(finalResponse, maxTextChars),
    timeline
  }
}

export function isTurnTrace(value: unknown): value is TurnTrace {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TurnTrace>
  return (candidate.schemaVersion === 2 || candidate.schemaVersion === 3) &&
    typeof candidate.exportedAt === 'string' &&
    Boolean(candidate.turn && typeof candidate.turn.id === 'string') &&
    Boolean(candidate.thread && Array.isArray(candidate.timeline))
}

function traceEvent(item: TraceInputItem, meta: ItemMeta | undefined, index: number): TurnTraceEvent {
  const base = {
    index: index + 1,
    id: item.id,
    type: item.type,
    label: itemLabel(item),
    startedAt: iso(meta?.startedAtMs),
    completedAt: iso(meta?.completedAtMs),
    durationMs: itemDuration(item, meta),
    status: itemStatus(item),
    details: itemDetails(item, meta)
  }

  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined)) as TurnTraceEvent
}

function itemLabel(item: TraceInputItem): string {
  switch (item.type) {
    case 'userMessage': return 'User prompt'
    case 'agentMessage': return item.phase === 'commentary' ? 'Agent commentary' : 'Agent response'
    case 'commandExecution': return `Command: ${clip(singleLine(item.command), 80)}`
    case 'fileChange': return `Changed ${item.changes.length} ${item.changes.length === 1 ? 'file' : 'files'}`
    case 'dynamicToolCall': return `Tool: ${item.tool}`
    case 'mcpToolCall': return `MCP: ${item.server}/${item.tool}`
    case 'webSearch': return `Search: ${clip(item.query, 90)}`
    case 'reasoning': return 'Reasoning summary'
    case 'turnPlan': return 'Turn plan'
    case 'plan': return 'Plan'
    case 'system': return `System ${item.level}`
    default: return item.type
  }
}

function itemStatus(item: TraceInputItem): string | null | undefined {
  if (item.type === 'dynamicToolCall' && item.success !== null) return item.success ? 'completed' : 'failed'
  if ('status' in item && typeof item.status === 'string') return item.status
  if (item.type === 'system') return item.level
  return null
}

function itemDuration(item: TraceInputItem, meta: ItemMeta | undefined): number | null | undefined {
  if ('durationMs' in item && typeof item.durationMs === 'number') return item.durationMs
  if (meta?.startedAtMs && meta.completedAtMs) return Math.max(0, meta.completedAtMs - meta.startedAtMs)
  return null
}

function itemDetails(item: TraceInputItem, meta: ItemMeta | undefined): Record<string, unknown> {
  switch (item.type) {
    case 'userMessage':
      return {
        content: item.content.map((content) => {
          if (content.type === 'text') return { type: 'text', text: clip(content.text, maxFieldChars) }
          if (content.type === 'skill') return { type: 'skill', name: content.name, path: content.path }
          if (content.type === 'image' || content.type === 'localImage') return { type: content.type, image: '[omitted from trace]' }
          return bounded(content)
        })
      }
    case 'agentMessage':
      return { phase: item.phase, text: clip(item.text, maxTextChars) }
    case 'commandExecution':
      return {
        command: item.command,
        cwd: item.cwd,
        source: item.source,
        commandActions: bounded(item.commandActions),
        exitCode: item.exitCode,
        output: clip(item.aggregatedOutput ?? '', maxTextChars),
        outputTruncated: Boolean(item.aggregatedOutput && item.aggregatedOutput.length > maxTextChars)
      }
    case 'fileChange':
      return {
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind,
          diff: clip(change.diff, maxTextChars),
          diffTruncated: change.diff.length > maxTextChars
        }))
      }
    case 'dynamicToolCall':
      return {
        namespace: item.namespace,
        tool: item.tool,
        arguments: bounded(item.arguments),
        success: item.success,
        output: item.contentItems?.map((content) =>
          content.type === 'inputText'
            ? { type: content.type, text: clip(content.text, maxTextChars), truncated: content.text.length > maxTextChars }
            : { type: content.type, image: '[omitted from trace]' }
        ) ?? null
      }
    case 'mcpToolCall':
      return {
        server: item.server,
        tool: item.tool,
        arguments: bounded(item.arguments),
        result: bounded(item.result),
        error: bounded(item.error)
      }
    case 'reasoning':
      return {
        summary: item.summary.map((part) => clip(part, maxFieldChars)),
        content: item.content.map((part) => clip(part, maxFieldChars))
      }
    case 'plan': return { text: clip(item.text, maxTextChars) }
    case 'turnPlan': return { explanation: item.explanation, steps: item.steps }
    case 'webSearch': return { query: item.query, action: bounded(item.action) }
    case 'system': return { level: item.level, text: clip(item.text, maxFieldChars) }
    default:
      return {
        item: bounded(item),
        ...(meta?.progress?.length ? { progress: meta.progress.map((message) => clip(message, 500)) } : {})
      }
  }
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

function bounded(value: unknown): unknown {
  if (value === null || value === undefined) return value
  try {
    const serialized = JSON.stringify(value, (_key, part) =>
      typeof part === 'string' ? clip(part, maxFieldChars) : part
    )
    if (serialized.length <= maxTextChars) return JSON.parse(serialized)
    return { preview: clip(serialized, maxTextChars), truncated: true }
  } catch {
    return clip(String(value), maxFieldChars)
  }
}

function turnDuration(meta: TurnMeta | undefined): number | undefined {
  if (typeof meta?.durationMs === 'number') return meta.durationMs
  if (meta?.startedAtMs && meta.completedAtMs) return Math.max(0, meta.completedAtMs - meta.startedAtMs)
  return undefined
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

function usageAccounting(tokens: TurnMeta['tokens'] | undefined): NonNullable<TurnTrace['usage']['accounting']> {
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

function traceTiming(meta: TurnMeta | undefined, timeline: TurnTraceEvent[]): NonNullable<TurnTrace['timing']> {
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

function traceSources(finalResponse: string): TraceSource[] {
  const sources = new Map<string, TraceSource>()
  const markdownLink = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g
  for (const match of finalResponse.matchAll(markdownLink)) {
    addTraceSource(sources, match[2], match[1])
  }

  const bareUrl = /https?:\/\/[^\s<>"'`]+/g
  for (const match of finalResponse.matchAll(bareUrl)) {
    addTraceSource(sources, match[0])
  }
  return [...sources.values()]
}

function addTraceSource(sources: Map<string, TraceSource>, rawUrl: string | undefined, label?: string): void {
  if (!rawUrl) return
  const cleaned = rawUrl.replace(/[),.;:\]]+$/g, '')
  try {
    const parsed = new URL(cleaned)
    const url = parsed.toString()
    const existing = sources.get(url)
    if (existing && existing.label !== existing.host) return
    sources.set(url, {
      url,
      label: label?.trim() || parsed.hostname,
      host: parsed.hostname,
      kind: sourceKind(parsed)
    })
  } catch {
    // Ignore malformed URL-shaped text rather than polluting the source index.
  }
}

function sourceKind(url: URL): TraceSource['kind'] {
  if (url.hostname === 'electronjs.org' || url.hostname.endsWith('.electronjs.org')) return 'official'
  if (url.hostname === 'releases.electronjs.org') return 'official'
  if (url.hostname === 'github.com' && /\/electron\/electron\/(issues|discussions)\//.test(url.pathname)) return 'firsthand'
  if (url.hostname === 'github.com' && /\/electron\/electron\/(pull|commit|releases)\//.test(url.pathname)) return 'projectRecord'
  return 'other'
}

function traceArtifacts(items: TraceInputItem[]): TraceArtifact[] {
  const artifacts = new Map<string, TraceArtifact>()
  for (const item of items) {
    if (item.type === 'fileChange') {
      for (const change of item.changes) {
        artifacts.set(change.path, {
          path: change.path,
          kind: 'workspaceChange',
          originEventId: item.id,
          availability: 'pathOnly'
        })
      }
      continue
    }
    if (item.type !== 'commandExecution') continue
    const searchable = `${item.command}\n${item.aggregatedOutput ?? ''}`
    for (const match of searchable.matchAll(/\/tmp\/codexdesktop-tasks\/[A-Za-z0-9._/-]+/g)) {
      const path = match[0].replace(/[.,;:)\]]+$/g, '').replace(/\/$/, '')
      const leaf = path.split('/').pop() ?? ''
      artifacts.set(path, {
        path,
        kind: leaf.includes('.') ? 'generatedFile' : 'researchCapsule',
        originEventId: item.id,
        availability: 'pathOnly'
      })
    }
  }
  return [...artifacts.values()]
}

function traceTruncations(value: unknown): TraceTruncation[] {
  const truncations: TraceTruncation[] = []
  collectTruncations(value, '', truncations)
  return truncations
}

function collectTruncations(value: unknown, path: string, truncations: TraceTruncation[]): void {
  if (typeof value === 'string') {
    if (path.endsWith('.label')) return
    const marker = /\n\[… truncated (\d+) characters]$/.exec(value)
    if (marker) {
      truncations.push({
        path,
        reason: 'sizeLimit',
        capturedCharacters: marker.index,
        omittedCharacters: Number(marker[1])
      })
    } else if (value.includes('[omitted from trace]')) {
      truncations.push({ path, reason: 'omitted' })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((part, index) => collectTruncations(part, `${path}[${index}]`, truncations))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, part] of Object.entries(value)) {
    collectTruncations(part, path ? `${path}.${key}` : key, truncations)
  }
}

function roundPercent(ratio: number): number {
  return Math.round(ratio * 1_000) / 10
}

function valueOrFallback<T>(value: T | null | undefined, fallback: T | null): T | null {
  return value === undefined ? fallback : value
}

function iso(value: number | undefined): string | undefined {
  return typeof value === 'number' ? new Date(value).toISOString() : undefined
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… truncated ${text.length - max} characters]` : text
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stripAutomaticSkillMarker(text: string): string {
  return text.replace(/^\$artifact-first-web-research[ \t]*\r?\n/i, '')
}

function stripSkillMarkerFromTitle(title: string): string {
  return title.replace(/^\$artifact-first-web-research\s*/i, '') || 'New Chat'
}
