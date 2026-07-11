const maxLifecycleEvents = 96
const maxTimelineEvents = 96
const maxInteractionEvents = 96

export const PERFORMANCE_TIMELINE_EVENT_TYPES = [
  'largest-contentful-paint',
  'layout-shift',
  'longtask'
] as const

export type MetricRating = 'good' | 'needs-improvement' | 'poor' | 'unavailable'

export type PerformanceLifecycleEvent = {
  name: string
  frameId: string | null
  loaderId: string | null
  timestamp: number | null
}

export type PerformanceTimelineEvent = {
  type: string
  name: string
  frameId: string | null
  time: number | null
  durationMs: number | null
  beforeCollection?: boolean
  lcp?: {
    renderTime: number | null
    loadTime: number | null
    size: number | null
    elementId: string | null
    url: string | null
    nodeId: number | null
  }
  layoutShift?: {
    value: number
    hadRecentInput: boolean
    sourceCount: number
  }
}

export type PerformanceInteraction = {
  interactionId: number
  name: string
  startTimeMs: number
  durationMs: number
  inputDelayMs: number | null
  processingMs: number | null
  presentationDelayMs: number | null
  beforeCollection: boolean
}

export type PerformanceFinding = {
  severity: 'info' | 'warning' | 'critical'
  code: string
  message: string
}

export type PerformanceDiagnosticsPage = {
  active: boolean
  startedAt: string | null
  scope: {
    page: 'navigation-lifetime'
    runtimeMetrics: 'collection-window'
    collectionStartedAtPageMs: number | null
    pageAgeMs: number | null
    bufferedPageEvents: boolean
  }
  runtime: {
    timestamp: number | null
    documents: number | null
    frames: number | null
    nodes: number | null
    jsEventListeners: number | null
    layoutCount: number | null
    recalcStyleCount: number | null
    durationsMs: {
      script: number | null
      task: number | null
      layout: number | null
      styleRecalc: number | null
    }
    heap: {
      usedBytes: number | null
      totalBytes: number | null
    }
  }
  navigation: Record<string, unknown> | null
  lifecycle: PerformanceLifecycleEvent[]
  webVitals: {
    largestContentfulPaint: PerformanceTimelineEvent | null
    largestContentfulPaintMs: number | null
    cumulativeLayoutShift: number
    layoutShiftCount: number
    interactionToNextPaintMs: number | null
    interactionCount: number
    recentInteractions: PerformanceInteraction[]
    longTaskCount: number
    longTaskTotalMs: number
    longTaskBlockingMs: number
    collectionLongTaskCount: number
    collectionLongTaskBlockingMs: number
    longestTaskMs: number
    recentLongTasks: PerformanceTimelineEvent[]
  }
  assessment: {
    overallRating: 'good' | 'needs-improvement' | 'poor' | 'incomplete'
    metrics: {
      lcp: { valueMs: number | null; rating: MetricRating; goodAtOrBelowMs: 2500; poorAboveMs: 4000 }
      cls: { value: number; rating: MetricRating; goodAtOrBelow: 0.1; poorAbove: 0.25 }
      inp: { valueMs: number | null; rating: MetricRating; goodAtOrBelowMs: 200; poorAboveMs: 500; source: 'local-event-timing' | 'unavailable' }
    }
    longTasks: {
      count: number
      totalDurationMs: number
      totalBlockingMs: number
      longestMs: number
      thresholdMs: 50
    }
    findings: PerformanceFinding[]
    traceRecommended: boolean
  }
  support: {
    performanceTimeline: boolean
    eventTypes: string[]
    longTasks: 'performance-timeline' | 'performance-observer' | 'unavailable'
    interactions: 'performance-observer' | 'unavailable'
    warnings: string[]
  }
  droppedLifecycleEvents: number
  droppedTimelineEvents: number
  droppedInteractionEvents: number
}

export class PerformanceDiagnostics {
  private active = false
  private startedAt: string | null = null
  private collectionStartedAtPageMs: number | null = null
  private timelineSupported = false
  private longTaskSource: 'performance-timeline' | 'performance-observer' | 'unavailable' = 'unavailable'
  private interactionSource: 'performance-observer' | 'unavailable' = 'unavailable'
  private readonly eventTypes: string[] = []
  private readonly warnings: string[] = []
  private readonly lifecycle: PerformanceLifecycleEvent[] = []
  private readonly timeline: PerformanceTimelineEvent[] = []
  private readonly interactions: PerformanceInteraction[] = []
  private droppedLifecycleEvents = 0
  private droppedTimelineEvents = 0
  private droppedInteractionEvents = 0

  start(): void {
    this.active = true
    this.startedAt = new Date().toISOString()
    this.collectionStartedAtPageMs = null
    this.timelineSupported = false
    this.longTaskSource = 'unavailable'
    this.interactionSource = 'unavailable'
    this.eventTypes.length = 0
    this.warnings.length = 0
    this.lifecycle.length = 0
    this.timeline.length = 0
    this.interactions.length = 0
    this.droppedLifecycleEvents = 0
    this.droppedTimelineEvents = 0
    this.droppedInteractionEvents = 0
  }

  stop(): void {
    this.active = false
  }

  setTimelineSupport(eventTypes: readonly string[]): void {
    this.timelineSupported = true
    this.eventTypes.splice(0, this.eventTypes.length, ...eventTypes)
    if (eventTypes.includes('longtask')) this.longTaskSource = 'performance-timeline'
  }

  setObserverSupport(value: unknown): void {
    const support = asRecord(value)
    this.collectionStartedAtPageMs = readNumber(support.collectionStartedAtPageMs)
    if (support.longTasks === true) this.longTaskSource = 'performance-observer'
    if (support.interactions === true) this.interactionSource = 'performance-observer'
  }

  setLongTaskObserverSupport(): void {
    this.longTaskSource = 'performance-observer'
  }

  addWarning(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message)
  }

  record(method: string, value: unknown): void {
    if (!this.active) return
    const params = asRecord(value)
    if (method === 'Page.lifecycleEvent') {
      this.lifecycle.push({
        name: readString(params.name) ?? 'unknown',
        frameId: readString(params.frameId),
        loaderId: readString(params.loaderId),
        timestamp: readNumber(params.timestamp)
      })
      if (this.lifecycle.length > maxLifecycleEvents) {
        this.lifecycle.shift()
        this.droppedLifecycleEvents += 1
      }
      return
    }
    if (method !== 'PerformanceTimeline.timelineEventAdded') return
    const raw = asRecord(params.event)
    const event: PerformanceTimelineEvent = {
      type: readString(raw.type) ?? 'unknown',
      name: readString(raw.name) ?? '',
      frameId: readString(raw.frameId),
      time: readNumber(raw.time),
      durationMs: secondsToMs(readNumber(raw.duration))
    }
    const lcp = asRecord(raw.lcpDetails)
    if (Object.keys(lcp).length > 0) {
      event.lcp = {
        renderTime: readNumber(lcp.renderTime),
        loadTime: readNumber(lcp.loadTime),
        size: readNumber(lcp.size),
        elementId: readString(lcp.elementId),
        url: readString(lcp.url),
        nodeId: readNumber(lcp.nodeId)
      }
    }
    const shift = asRecord(raw.layoutShiftDetails)
    if (Object.keys(shift).length > 0) {
      event.layoutShift = {
        value: readNumber(shift.value) ?? 0,
        hadRecentInput: shift.hadRecentInput === true,
        sourceCount: Array.isArray(shift.sources) ? shift.sources.length : 0
      }
    }
    this.pushTimeline(event)
  }

  recordObservedData(value: unknown): void {
    const data = asRecord(value)
    this.recordObservedLongTasks(data.longTasks)
    this.recordObservedInteractions(data.interactions)
  }

  recordObservedLongTasks(value: unknown): void {
    if (!this.active || !Array.isArray(value)) return
    for (const item of value) {
      const entry = asRecord(item)
      const startTime = readNumber(entry.startTime)
      const durationMs = readNumber(entry.duration)
      this.pushTimeline({
        type: 'longtask',
        name: readString(entry.name) ?? 'self',
        frameId: null,
        time: startTime,
        durationMs: durationMs === null ? null : round(durationMs, 3),
        beforeCollection: startTime !== null && this.collectionStartedAtPageMs !== null
          ? startTime < this.collectionStartedAtPageMs
          : false
      })
    }
  }

  recordObservedInteractions(value: unknown): void {
    if (!this.active || !Array.isArray(value)) return
    for (const item of value) {
      const entry = asRecord(item)
      const interactionId = readNumber(entry.interactionId)
      const startTimeMs = readNumber(entry.startTime)
      const durationMs = readNumber(entry.duration)
      if (interactionId === null || interactionId <= 0 || startTimeMs === null || durationMs === null) continue
      const processingStart = readNumber(entry.processingStart)
      const processingEnd = readNumber(entry.processingEnd)
      const inputDelayMs = processingStart === null ? null : Math.max(0, processingStart - startTimeMs)
      const processingMs = processingStart === null || processingEnd === null ? null : Math.max(0, processingEnd - processingStart)
      const presentationDelayMs = processingEnd === null ? null : Math.max(0, startTimeMs + durationMs - processingEnd)
      this.interactions.push({
        interactionId,
        name: readString(entry.name) ?? 'unknown',
        startTimeMs: round(startTimeMs, 3),
        durationMs: round(durationMs, 3),
        inputDelayMs: nullableRound(inputDelayMs, 3),
        processingMs: nullableRound(processingMs, 3),
        presentationDelayMs: nullableRound(presentationDelayMs, 3),
        beforeCollection: this.collectionStartedAtPageMs !== null && startTimeMs < this.collectionStartedAtPageMs
      })
      if (this.interactions.length > maxInteractionEvents) {
        this.interactions.shift()
        this.droppedInteractionEvents += 1
      }
    }
  }

  page(metricsValue: unknown, navigation: Record<string, unknown> | null): PerformanceDiagnosticsPage {
    const metrics = metricMap(metricsValue)
    const layoutShifts = this.timeline.filter((event) => event.type === 'layout-shift' && !event.layoutShift?.hadRecentInput)
    const longTasks = this.timeline.filter((event) => event.type === 'longtask')
    const collectionLongTasks = longTasks.filter((event) => event.beforeCollection !== true)
    const longestTaskMs = longTasks.reduce((maximum, event) => Math.max(maximum, event.durationMs ?? 0), 0)
    const longTaskTotalMs = sumDurations(longTasks)
    const longTaskBlockingMs = blockingTime(longTasks)
    const collectionLongTaskBlockingMs = blockingTime(collectionLongTasks)
    const recentLongTasks = [...longTasks]
      .sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))
      .slice(0, 10)
    const latestLcp = [...this.timeline].reverse().find((event) => event.type === 'largest-contentful-paint') ?? null
    const lcpMs = normalizeLcpMs(latestLcp, navigation)
    const cls = round(layoutShifts.reduce((total, event) => total + (event.layoutShift?.value ?? 0), 0), 4)
    const interactionGroups = groupedInteractions(this.interactions)
    const inpMs = estimatedInp(interactionGroups)
    const recentInteractions = [...interactionGroups]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 10)
    const lcpRating = rateUpperBound(lcpMs, 2500, 4000)
    const clsRating = rateUpperBound(cls, 0.1, 0.25)
    const inpRating = rateUpperBound(inpMs, 200, 500)
    const findings = buildFindings({
      lcpMs,
      lcpRating,
      cls,
      clsRating,
      inpMs,
      inpRating,
      interactionCount: interactionGroups.length,
      longTaskCount: longTasks.length,
      longTaskBlockingMs,
      collectionLongTaskCount: collectionLongTasks.length,
      collectionLongTaskBlockingMs,
      longestTaskMs
    })
    const metricRatings = [lcpRating, clsRating, inpRating]
    const traceRecommended = findings.some((finding) => ['lcp', 'cls', 'inp', 'long-tasks'].includes(finding.code))

    return {
      active: this.active,
      startedAt: this.startedAt,
      scope: {
        page: 'navigation-lifetime',
        runtimeMetrics: 'collection-window',
        collectionStartedAtPageMs: this.collectionStartedAtPageMs,
        pageAgeMs: readNumber(navigation?.pageAgeMs),
        bufferedPageEvents: true
      },
      runtime: {
        timestamp: metric(metrics, 'Timestamp'),
        documents: metric(metrics, 'Documents'),
        frames: metric(metrics, 'Frames'),
        nodes: metric(metrics, 'Nodes'),
        jsEventListeners: metric(metrics, 'JSEventListeners'),
        layoutCount: metric(metrics, 'LayoutCount'),
        recalcStyleCount: metric(metrics, 'RecalcStyleCount'),
        durationsMs: {
          script: secondsToMs(metric(metrics, 'ScriptDuration')),
          task: secondsToMs(metric(metrics, 'TaskDuration')),
          layout: secondsToMs(metric(metrics, 'LayoutDuration')),
          styleRecalc: secondsToMs(metric(metrics, 'RecalcStyleDuration'))
        },
        heap: {
          usedBytes: metric(metrics, 'JSHeapUsedSize'),
          totalBytes: metric(metrics, 'JSHeapTotalSize')
        }
      },
      navigation,
      lifecycle: this.lifecycle.slice(-30),
      webVitals: {
        largestContentfulPaint: latestLcp,
        largestContentfulPaintMs: lcpMs,
        cumulativeLayoutShift: cls,
        layoutShiftCount: layoutShifts.length,
        interactionToNextPaintMs: inpMs,
        interactionCount: interactionGroups.length,
        recentInteractions,
        longTaskCount: longTasks.length,
        longTaskTotalMs,
        longTaskBlockingMs,
        collectionLongTaskCount: collectionLongTasks.length,
        collectionLongTaskBlockingMs,
        longestTaskMs: round(longestTaskMs, 2),
        recentLongTasks
      },
      assessment: {
        overallRating: overallRating(metricRatings),
        metrics: {
          lcp: { valueMs: lcpMs, rating: lcpRating, goodAtOrBelowMs: 2500, poorAboveMs: 4000 },
          cls: { value: cls, rating: clsRating, goodAtOrBelow: 0.1, poorAbove: 0.25 },
          inp: {
            valueMs: inpMs,
            rating: inpRating,
            goodAtOrBelowMs: 200,
            poorAboveMs: 500,
            source: inpMs === null ? 'unavailable' : 'local-event-timing'
          }
        },
        longTasks: {
          count: longTasks.length,
          totalDurationMs: longTaskTotalMs,
          totalBlockingMs: longTaskBlockingMs,
          longestMs: round(longestTaskMs, 2),
          thresholdMs: 50
        },
        findings,
        traceRecommended
      },
      support: {
        performanceTimeline: this.timelineSupported,
        eventTypes: [...this.eventTypes],
        longTasks: this.longTaskSource,
        interactions: this.interactionSource,
        warnings: [...this.warnings]
      },
      droppedLifecycleEvents: this.droppedLifecycleEvents,
      droppedTimelineEvents: this.droppedTimelineEvents,
      droppedInteractionEvents: this.droppedInteractionEvents
    }
  }

  private pushTimeline(event: PerformanceTimelineEvent): void {
    this.timeline.push(event)
    if (this.timeline.length > maxTimelineEvents) {
      this.timeline.shift()
      this.droppedTimelineEvents += 1
    }
  }
}

type FindingInput = {
  lcpMs: number | null
  lcpRating: MetricRating
  cls: number
  clsRating: MetricRating
  inpMs: number | null
  inpRating: MetricRating
  interactionCount: number
  longTaskCount: number
  longTaskBlockingMs: number
  collectionLongTaskCount: number
  collectionLongTaskBlockingMs: number
  longestTaskMs: number
}

function buildFindings(input: FindingInput): PerformanceFinding[] {
  const findings: PerformanceFinding[] = []
  if (input.lcpMs === null) {
    findings.push({ severity: 'info', code: 'lcp-unavailable', message: 'LCP is not available for this page snapshot.' })
  } else if (input.lcpRating !== 'good') {
    findings.push({ severity: input.lcpRating === 'poor' ? 'critical' : 'warning', code: 'lcp', message: `LCP is ${input.lcpMs} ms (${input.lcpRating}).` })
  }
  if (input.clsRating !== 'good') {
    findings.push({ severity: input.clsRating === 'poor' ? 'critical' : 'warning', code: 'cls', message: `CLS is ${input.cls} (${input.clsRating}).` })
  }
  if (input.inpMs === null) {
    findings.push({ severity: 'info', code: 'inp-unavailable', message: 'INP needs at least one observed user interaction.' })
  } else if (input.inpRating !== 'good') {
    findings.push({ severity: input.inpRating === 'poor' ? 'critical' : 'warning', code: 'inp', message: `Local INP is ${input.inpMs} ms across ${input.interactionCount} interactions (${input.inpRating}).` })
  }
  if (input.longTaskCount > 0) {
    findings.push({
      severity: input.longestTaskMs > 200 || input.longTaskBlockingMs > 200 ? 'critical' : 'warning',
      code: 'long-tasks',
      message: `${input.longTaskCount} long tasks caused ${input.longTaskBlockingMs} ms of blocking time; ${input.collectionLongTaskCount} tasks and ${input.collectionLongTaskBlockingMs} ms occurred during collection.`
    })
  }
  if (findings.length === 0) {
    findings.push({ severity: 'info', code: 'no-local-issues', message: 'No threshold violations were observed in this local snapshot.' })
  }
  return findings
}

function groupedInteractions(events: PerformanceInteraction[]): PerformanceInteraction[] {
  const byId = new Map<number, PerformanceInteraction>()
  for (const event of events) {
    const current = byId.get(event.interactionId)
    if (!current || event.durationMs > current.durationMs) byId.set(event.interactionId, event)
  }
  return [...byId.values()]
}

function estimatedInp(interactions: PerformanceInteraction[]): number | null {
  if (interactions.length === 0) return null
  const descending = interactions.map(({ durationMs }) => durationMs).sort((left, right) => right - left)
  const ignoredWorst = Math.floor(descending.length / 50)
  return round(descending[Math.min(ignoredWorst, descending.length - 1)], 3)
}

function normalizeLcpMs(event: PerformanceTimelineEvent | null, navigation: Record<string, unknown> | null): number | null {
  if (!event?.lcp) return null
  const rawSeconds = (event.lcp.renderTime ?? 0) > 0 ? event.lcp.renderTime : event.lcp.loadTime
  if (rawSeconds === null) return null
  const timeOriginMs = readNumber(navigation?.timeOriginMs)
  const absoluteMs = rawSeconds * 1000
  if (timeOriginMs !== null && absoluteMs > 1_000_000_000_000) return round(Math.max(0, absoluteMs - timeOriginMs), 3)
  return round(absoluteMs, 3)
}

function rateUpperBound(value: number | null, good: number, poor: number): MetricRating {
  if (value === null) return 'unavailable'
  if (value <= good) return 'good'
  if (value <= poor) return 'needs-improvement'
  return 'poor'
}

function overallRating(ratings: MetricRating[]): 'good' | 'needs-improvement' | 'poor' | 'incomplete' {
  if (ratings.includes('poor')) return 'poor'
  if (ratings.includes('needs-improvement')) return 'needs-improvement'
  if (ratings.includes('unavailable')) return 'incomplete'
  return 'good'
}

function sumDurations(events: PerformanceTimelineEvent[]): number {
  return round(events.reduce((total, event) => total + (event.durationMs ?? 0), 0), 2)
}

function blockingTime(events: PerformanceTimelineEvent[]): number {
  return round(events.reduce((total, event) => total + Math.max(0, (event.durationMs ?? 0) - 50), 0), 2)
}

function metricMap(value: unknown): Map<string, number> {
  const result = new Map<string, number>()
  const metrics = asRecord(value).metrics
  if (!Array.isArray(metrics)) return result
  for (const item of metrics) {
    const record = asRecord(item)
    const name = readString(record.name)
    const number = readNumber(record.value)
    if (name && number !== null) result.set(name, number)
  }
  return result
}

function metric(metrics: Map<string, number>, name: string): number | null {
  return metrics.get(name) ?? null
}

function secondsToMs(value: number | null): number | null {
  return value === null ? null : round(value * 1000, 3)
}

function nullableRound(value: number | null, places: number): number | null {
  return value === null ? null : round(value, places)
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
