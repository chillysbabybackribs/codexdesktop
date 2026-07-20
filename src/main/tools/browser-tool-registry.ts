import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner, SearchDiscoveryResult } from '../browser/research-runner.js'
import type { RankedSerpCandidate } from '../browser/research-utils.js'
import type { ResearchProgress } from '../../shared/ipc.js'
import { runUiReview } from '../codex/ui-review.js'
import { describeNavigationInput } from '../browser/url-utils.js'

// The provider-neutral browser tool dispatch (Claude-prep step 6): one
// implementation consumed by three transports — the Codex dynamic-tool
// adapter (dynamic-tool-router.ts), the unix-socket control server's generic
// POST /tool/<name> route, and (via the socket) the MCP stdio shim. Specs
// live in browser-tool-specs.ts.

export type BrowserToolOwner = { threadId: string; turnId: string; callId: string }

export type BrowserToolInvocation = {
  tool: string
  args: Record<string, unknown>
  /**
   * Codex turn ownership: enables per-turn queueing and post-turn blocking.
   * External transports (socket, MCP) pass null and get direct execution —
   * the same semantics the socket's bespoke routes have always had.
   */
  owner: BrowserToolOwner | null
  callId: string
}

export type BrowserToolDeps = {
  browserAgent: BrowserAgentController
  researchRunner?: ResearchRunner
  onResearchProgress?: (progress: ResearchProgress) => void
}

export type BrowserToolOutcome = {
  result: { ok: boolean } & Record<string, unknown>
  imageUrls: string[]
}

// Mutable holder for the early-navigation race: object properties keep their
// declared types across closure assignment, unlike captured `let` bindings.
type EarlyNavigationLane = {
  navigated: RankedSerpCandidate | null
  page: ReturnType<BrowserAgentController['snapshot']> | null
  background: ReturnType<ResearchRunner['run']> | null
  firstUrlMs: number | null
}

export async function runBrowserTool(
  invocation: BrowserToolInvocation,
  deps: BrowserToolDeps
): Promise<BrowserToolOutcome> {
  const { tool, args, owner, callId } = invocation
  try {
    // A lost Chromium tab blocks later tab-bound work in the same turn so it
    // cannot silently jump to a different tab. app_screenshot is deliberately
    // exempt: it captures the Electron window itself and remains valid even
    // when the previously targeted browser tab was closed or replaced.
    const isTargetBoundBrowserTool = tool !== 'research_web' && tool !== 'app_screenshot'
    const blockedResult = isTargetBoundBrowserTool && owner
      ? deps.browserAgent.blockedTurnBrowserResult(owner)
      : null
    if (blockedResult) return { result: blockedResult as BrowserToolOutcome['result'], imageUrls: [] }

    const runBrowserOperation = <T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T> =>
      owner ? deps.browserAgent.runForTurn(owner, execute) : execute(new AbortController().signal)

    let result: BrowserToolOutcome['result']
    let imageUrls: string[] = []

    if (tool === 'browser_live_search') {
      const queries = readSearchQueries(args)
      const objective = readString(args.objective)
      const includeBackground = args.background === true
      if (queries.length === 0 || !objective) {
        result = { ok: false, error: `${tool} requires "objective" and at least one search query` }
      } else if (!deps.researchRunner) {
        result = { ok: false, error: 'browser_live_search hidden discovery is not available on this transport' }
      } else {
        const startedAt = Date.now()
        result = await runBrowserOperation(async (signal) => {
          // Navigate the visible tab as soon as the earliest hidden search lane
          // yields a usable destination; remaining lanes keep filling alternates
          // in the background instead of gating the first page load.
          const lane: EarlyNavigationLane = { navigated: null, page: null, background: null, firstUrlMs: null }
          const focus = readResearchFocus(args.focus)
          const startWork = (candidates: RankedSerpCandidate[]): void => {
            const candidate = candidates[0]
            if (!candidate || lane.page) return
            lane.navigated = candidate
            lane.firstUrlMs = Date.now() - startedAt
            notifyNavigationStart(deps, candidate)
            lane.page = deps.browserAgent.snapshot({
              objective,
              url: candidate.url,
              tabId: resolveAgentTab(readString(args.tab)),
              mode: 'task',
              maxItems: readNumber(args.maxItems) ?? 10,
              timeoutMs: readNumber(args.timeoutMs),
              signal
            })
            if (includeBackground) {
              const urls = selectBackgroundUrls(candidates, candidate.url, focus)
              lane.background = deps.researchRunner!.run({
                queries,
                ...(urls.length > 0 ? { urls } : {}),
                focus,
                maxResults: readNumber(args.maxResults),
                maxAttempts: readNumber(args.maxAttempts),
                snippetChars: readNumber(args.snippetChars)
              }, {
                runId: `${callId}:background`,
                threadId: owner?.threadId ?? 'external',
                turnId: owner?.turnId ?? callId,
                onProgress: deps.onResearchProgress
              })
            }
          }
          const discovery = await deps.researchRunner!.discover({
            queries,
            maxResults: readNumber(args.maxResults),
            maxCandidates: 10
          }, {
            signal,
            onProgress: deps.onResearchProgress,
            // Generous tail: the destination page snapshot runs concurrently
            // and usually takes longer than the remaining lanes, so letting
            // them finish costs no wall time — a 750ms cutoff was starving
            // the merged ranking that alternates and betterAlternate need.
            tailMsAfterFirstCandidates: 3500,
            onFirstCandidates: (candidates) => {
              startWork(candidates)
            }
          })
          if (!lane.page) {
            if (!discovery.ok || !discovery.candidates[0]) return discovery
            startWork(discovery.candidates)
          }
          const [firstPage, background] = await Promise.all([
            lane.page!,
            lane.background ?? Promise.resolve(null)
          ])
          let page = firstPage
          let destination = lane.navigated!
          // Early navigation commits to the FIRST lane's best candidate for
          // latency; the merged ranking across all lanes lands afterwards.
          // A failed early page retries once on the merged best; a successful
          // one that the merged ranking clearly beat is flagged instead of
          // silently presented as the final word (live-caught: navigated to a
          // score-71 brand page while a score-126 source sat in alternates).
          const mergedTop = discovery.candidates[0]
          if (!page.ok && mergedTop && mergedTop.url !== destination.url) {
            notifyNavigationStart(deps, mergedTop)
            page = await deps.browserAgent.snapshot({
              objective,
              url: mergedTop.url,
              tabId: resolveAgentTab(readString(args.tab)),
              mode: 'task',
              maxItems: readNumber(args.maxItems) ?? 10,
              timeoutMs: readNumber(args.timeoutMs),
              signal
            })
            destination = mergedTop
          }
          const betterAlternate =
            page.ok && mergedTop && mergedTop.url !== destination.url &&
            mergedTop.score >= destination.score + 15
              ? mergedTop
              : null
          // Background corroboration is additive. A readable visible result
          // must not be turned into a failed search because the optional
          // research lane exhausted its candidates or retained coverage gaps.
          const ok = page.ok || background?.ok === true
          return {
            ok,
            mode: includeBackground
              ? 'hidden-discovery-direct-navigation-plus-research'
              : 'hidden-discovery-direct-navigation',
            destination: compactDestination(destination),
            ...(betterAlternate
              ? {
                  betterAlternate: {
                    ...compactDestination(betterAlternate),
                    note: 'The merged ranking across all search lanes scored this source higher than the auto-navigated destination. Navigate to it directly if it serves the objective better.'
                  }
                }
              : {}),
            alternates: discovery.candidates.filter((candidate) => candidate.url !== destination.url).map(compactDestination),
            discovery: compactDiscovery(discovery),
            page,
            ...(background ? { background } : {}),
            timings: {
              firstUrlMs: lane.firstUrlMs,
              totalMs: Date.now() - startedAt
            },
            ...(ok
              ? {}
              : { error: includeBackground ? 'one or more search lanes failed' : 'Hidden discovery succeeded, but the destination page snapshot failed' }),
          }
        })
      }
    } else if (tool === 'browser_screenshot') {
      const tabId = resolveAgentTab(readString(args.tab))
      result = await runBrowserOperation((signal) => deps.browserAgent.captureScreenshot({ tabId, signal }))
      const screenshot = asRecord(asRecord(result.result).screenshot)
      const artifactPath = readString(screenshot.artifactPath)
      if (result.ok && artifactPath) {
        const imageUrl = await deps.browserAgent.readScreenshotDataUrl(artifactPath)
        if (imageUrl) imageUrls = [imageUrl]
        else {
          result = { ...result, ok: false, error: 'captured screenshot could not be loaded for model vision' }
        }
      }
    } else if (tool === 'app_screenshot') {
      result = await runBrowserOperation((signal) => deps.browserAgent.captureAppScreenshot({ signal }))
      const screenshot = asRecord(asRecord(result.result).screenshot)
      const artifactPath = readString(screenshot.artifactPath)
      if (result.ok && artifactPath) {
        const imageUrl = await deps.browserAgent.readScreenshotDataUrl(artifactPath)
        if (imageUrl) imageUrls = [imageUrl]
        else {
          result = { ...result, ok: false, error: 'captured app screenshot could not be loaded for model vision' }
        }
      }
    } else if (tool === 'ui_review') {
      const review = await runBrowserOperation((signal) => runUiReview(
        deps.browserAgent,
        args.viewports,
        { tabId: resolveAgentTab(readString(args.tab)) ?? undefined, signal }
      ))
      result = review.result
      imageUrls = review.imageUrls
    } else if (tool === 'browser_snapshot') {
      const objective = readString(args.objective)
      const url = readString(args.url)
      result = url && !isDirectAgentNavigation(url)
        ? directNavigationRequired(tool)
        : objective
        ? await runBrowserOperation((signal) => deps.browserAgent.snapshot({
            objective,
            url,
            tabId: resolveAgentTab(readString(args.tab)),
            frame: readString(args.frame),
            mode: readSnapshotMode(args.mode),
            order: readSnapshotOrder(args.order),
            selector: readString(args.selector),
            maxItems: readNumber(args.maxItems),
            readySelector: readString(args.readySelector),
            timeoutMs: readNumber(args.timeoutMs),
            quietMs: readNumber(args.quietMs),
            maxSettleMs: readNumber(args.maxSettleMs),
            maxResultChars: readNumber(args.maxResultChars),
            signal
          }))
        : { ok: false, error: 'browser_snapshot requires a string "objective" argument' }
    } else if (tool === 'browser_flow') {
      result = Array.isArray(args.steps)
        ? await runBrowserOperation((signal) => deps.browserAgent.flow(args.steps, {
            tabId: resolveAgentTab(readString(args.tab)),
            timeoutMs: readNumber(args.timeoutMs),
            maxResultChars: readNumber(args.maxResultChars),
            signal
          }))
        : { ok: false, error: 'browser_flow requires a non-empty "steps" array' }
    } else if (tool === 'browser_network') {
      const url = readString(args.url)
      result = url && !isDirectAgentNavigation(url)
        ? directNavigationRequired(tool)
        : await runBrowserOperation((signal) => deps.browserAgent.captureNetwork({
            url,
            steps: args.steps,
            match: readNetworkMatch(args.match),
            captureBody: typeof args.captureBody === 'boolean' ? args.captureBody : null,
            download: args.download === true,
            stream: readNetworkStream(args.stream),
            readySelector: readString(args.readySelector),
            quietMs: readNumber(args.quietMs),
            maxSettleMs: readNumber(args.maxSettleMs)
          }, {
            tabId: resolveAgentTab(readString(args.tab)),
            timeoutMs: readNumber(args.timeoutMs),
            maxResultChars: readNumber(args.maxResultChars),
            signal
          }))
    } else if (tool === 'browser_run') {
      const code = readString(args.code)
      result = code
        ? await runBrowserOperation((signal) => deps.browserAgent.run(code, {
            tabId: resolveAgentTab(readString(args.tab)),
            frame: readString(args.frame),
            timeoutMs: readNumber(args.timeoutMs),
            maxResultChars: readNumber(args.maxResultChars),
            signal
          }))
        : { ok: false, error: 'browser_run requires a string "code" argument' }
    } else if (tool === 'browser_navigate') {
      const url = readString(args.url)
      result = url && !isDirectAgentNavigation(url)
        ? directNavigationRequired(tool)
        : url
        ? await runBrowserOperation((signal) => deps.browserAgent.navigate(url, {
            tabId: resolveAgentTab(readString(args.tab)),
            readySelector: readString(args.readySelector),
            timeoutMs: readNumber(args.timeoutMs),
            quietMs: readNumber(args.quietMs),
            maxSettleMs: readNumber(args.maxSettleMs),
            signal
          }))
        : { ok: false, error: 'browser_navigate requires a string "url" argument' }
    } else if (tool === 'browser_extract_page') {
      result = await runBrowserOperation((signal) => deps.browserAgent.extractPage({
        tabId: resolveAgentTab(readString(args.tab)),
        frame: readString(args.frame),
        objective: readString(args.objective),
        mode: readSnapshotMode(args.mode),
        order: readSnapshotOrder(args.order),
        selector: readString(args.selector),
        maxItems: readNumber(args.maxItems),
        timeoutMs: readNumber(args.timeoutMs),
        maxResultChars: readNumber(args.maxResultChars),
        signal
      }))
    } else if (tool === 'browser_cdp') {
      result = await runBrowserOperation((signal) => routeCdpOperation(args, deps.browserAgent, signal))
    } else if (tool === 'research_web') {
      result = deps.researchRunner
        ? await deps.researchRunner.run({
            queries: readStringArray(args.queries),
            urls: readStringArray(args.urls),
            focus: readResearchFocus(args.focus),
            maxResults: readNumber(args.maxResults),
            maxAttempts: readNumber(args.maxAttempts),
            snippetChars: readNumber(args.snippetChars)
          }, {
            runId: callId,
            threadId: owner?.threadId ?? 'external',
            turnId: owner?.turnId ?? callId,
            onProgress: deps.onResearchProgress
          })
        : { ok: false, error: 'research_web is not available on this transport' }
    } else {
      result = { ok: false, error: `unsupported browser tool: ${tool}` }
    }

    if (isTargetBoundBrowserTool && owner) deps.browserAgent.blockTurnBrowserWork(owner, result)
    return { result: result as BrowserToolOutcome['result'], imageUrls }
  } catch (error) {
    return {
      result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      imageUrls: []
    }
  }
}

async function routeCdpOperation(
  args: Record<string, unknown>,
  browserAgent: BrowserAgentController,
  signal: AbortSignal
): Promise<Awaited<ReturnType<BrowserAgentController['cdp']>>> {
  const operation = readString(args.operation) ?? 'command'
  const method = readString(args.method)
  const options = {
    tabId: resolveAgentTab(readString(args.tab)),
    timeoutMs: readNumber(args.timeoutMs),
    maxResultChars: readNumber(args.maxResultChars),
    afterSequence: readNumber(args.afterSequence),
    filter: asRecord(args.filter),
    contains: readStringRecord(args.contains),
    limit: readNumber(args.limit),
    signal
  }

  if (operation === 'capabilities') return browserAgent.cdpCapabilities(options)
  if (operation === 'events') return browserAgent.cdpEvents(options, method)
  if (operation === 'wait') {
    return method
      ? browserAgent.waitForCdpEvent(method, options)
      : { ok: false, error: 'browser_cdp wait requires a string "method" event name' }
  }
  if (operation === 'traceStart') return browserAgent.startCdpTrace(asRecord(args.params), options)
  if (operation === 'traceStop') return browserAgent.stopCdpTrace(options)
  if (operation === 'snapshot') return browserAgent.captureDomSnapshot(asRecord(args.params), options)
  if (operation === 'networkStart') return browserAgent.startNetworkJournal(options)
  if (operation === 'network') return browserAgent.readNetworkJournal(asRecord(args.params), options)
  if (operation === 'networkBody') {
    const requestId = readString(args.requestId)
    return requestId
      ? browserAgent.captureNetworkResponseBody(requestId, options)
      : { ok: false, error: 'browser_cdp networkBody requires a string "requestId"' }
  }
  if (operation === 'networkStop') return browserAgent.stopNetworkJournal(options)
  if (operation === 'performanceStart') return browserAgent.startPerformanceDiagnostics(options)
  if (operation === 'performance') return browserAgent.readPerformanceDiagnostics(options)
  if (operation === 'performanceStop') return browserAgent.stopPerformanceDiagnostics(options)
  if (operation === 'command') {
    return method
      ? browserAgent.cdp(method, asRecord(args.params), options)
      : { ok: false, error: 'browser_cdp command requires a string "method" argument' }
  }
  return { ok: false, error: `unsupported browser_cdp operation: ${operation}` }
}

function resolveAgentTab(explicitTab: string | undefined): string | null {
  return explicitTab || null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readSnapshotMode(value: unknown): 'task' | 'content' | 'interactive' | undefined {
  return value === 'task' || value === 'content' || value === 'interactive' ? value : undefined
}

function readSnapshotOrder(value: unknown): 'document' | 'reverse-document' | undefined {
  return value === 'document' || value === 'reverse-document' ? value : undefined
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readSearchQueries(args: Record<string, unknown>): string[] {
  const primary = readString(args.query)
  const variants = readStringArray(args.queries)
  return [...new Set([...(primary ? [primary] : []), ...variants].map((query) => query.trim()).filter(Boolean))]
}

function notifyNavigationStart(deps: BrowserToolDeps, candidate: RankedSerpCandidate): void {
  try {
    deps.onResearchProgress?.({
      stage: 'discovering',
      message: `Opening ${candidate.domain} while remaining search lanes finish…`
    })
  } catch {
    // Progress is observational and must never fail the navigation.
  }
}

function compactDestination(candidate: RankedSerpCandidate): Record<string, unknown> {
  return {
    url: candidate.url,
    title: candidate.title,
    domain: candidate.domain,
    sourceTier: candidate.sourceTier,
    score: candidate.score
  }
}

function compactDiscovery(discovery: SearchDiscoveryResult): Record<string, unknown> {
  return {
    queries: discovery.queries,
    discoveredCount: discovery.discoveredCount,
    metrics: discovery.metrics,
    ...(discovery.errors ? { errors: discovery.errors } : {})
  }
}

function selectBackgroundUrls(
  candidates: RankedSerpCandidate[],
  visibleUrl: string,
  focus: Array<{ id: string; need: string; minSources?: number }>
): string[] {
  // An unfocused background lane needs one independent source. Focused work
  // receives enough early candidates to cover its explicit source demand; the
  // research runner can still use `queries` as fallback when those pages fail.
  const target = focus.length > 0
    ? Math.min(6, focus.reduce((sum, item) => sum + Math.max(1, item.minSources ?? 1), 0))
    : 1
  return candidates
    .filter((candidate) => candidate.url !== visibleUrl)
    .slice(0, target)
    .map((candidate) => candidate.url)
}

function isDirectAgentNavigation(input: string): boolean {
  const interpretation = describeNavigationInput(input)
  if (interpretation.kind !== 'navigate') return false
  try {
    const url = new URL(interpretation.url)
    const host = url.hostname.toLowerCase()
    const path = url.pathname.toLowerCase()
    if (/(^|\.)google\./.test(host) && path === '/search') return false
    if (/(^|\.)bing\.com$/.test(host) && path === '/search') return false
    if (/(^|\.)duckduckgo\.com$/.test(host) && (path === '/' || path === '/html/')) return !url.searchParams.has('q')
    if (host === 'search.yahoo.com') return false
    return true
  } catch {
    return false
  }
}

function directNavigationRequired(tool: string): BrowserToolOutcome['result'] {
  return {
    ok: false,
    error: `${tool} accepts only a direct destination URL; use browser_live_search for hidden search discovery`
  }
}

function readResearchFocus(value: unknown): Array<{ id: string; need: string; minSources?: number }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const record = asRecord(item)
    const id = readString(record.id)
    const need = readString(record.need)
    if (!id || !need) return []
    const minSources = readNumber(record.minSources)
    return [{ id, need, ...(minSources === undefined ? {} : { minSources }) }]
  })
}

function readNetworkMatch(value: unknown): {
  urlContains?: string
  method?: string
  resourceType?: string
  mimeType?: string
  statusMin?: number
  statusMax?: number
} {
  const match = asRecord(value)
  return {
    urlContains: readString(match.urlContains),
    method: readString(match.method),
    resourceType: readString(match.resourceType),
    mimeType: readString(match.mimeType),
    statusMin: readNumber(match.statusMin),
    statusMax: readNumber(match.statusMax)
  }
}

function readNetworkStream(value: unknown): {
  transport?: 'sse' | 'websocket'
  maxMessages?: number
  idleMs?: number
} | null {
  const stream = asRecord(value)
  const transport = stream.transport === 'sse' || stream.transport === 'websocket' ? stream.transport : undefined
  if (!transport && Object.keys(stream).length === 0) return null
  return {
    transport,
    maxMessages: readNumber(stream.maxMessages),
    idleMs: readNumber(stream.idleMs)
  }
}

function readStringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}
