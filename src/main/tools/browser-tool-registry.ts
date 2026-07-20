import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import type { ResearchProgress } from '../../shared/ipc.js'
import { runUiReview } from '../codex/ui-review.js'
import { normalizeNavigationInput } from '../browser/url-utils.js'

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
      const query = readString(args.query)
      const objective = readString(args.objective)
      result = query && objective
        ? await runBrowserOperation((signal) => deps.browserAgent.snapshot({
            objective,
            url: normalizeNavigationInput(query),
            tabId: resolveAgentTab(readString(args.tab)),
            mode: 'task',
            maxItems: readNumber(args.maxItems) ?? 10,
            timeoutMs: readNumber(args.timeoutMs),
            signal
          }))
        : { ok: false, error: 'browser_live_search requires string "query" and "objective" arguments' }
    } else if (tool === 'browser_research_dual') {
      const query = readString(args.query)
      const objective = readString(args.objective)
      if (!query || !objective) {
        result = { ok: false, error: 'browser_research_dual requires string "query" and "objective" arguments' }
      } else if (!deps.researchRunner) {
        result = { ok: false, error: 'browser_research_dual background lane is not available on this transport' }
      } else {
        const [live, background] = await Promise.all([
          runBrowserOperation((signal) => deps.browserAgent.snapshot({
            objective,
            url: normalizeNavigationInput(query),
            tabId: resolveAgentTab(readString(args.tab)),
            mode: 'task',
            maxItems: readNumber(args.maxResults) ?? 6,
            timeoutMs: readNumber(args.timeoutMs),
            signal
          })),
          deps.researchRunner.run({
            queries: [query],
            focus: readResearchFocus(args.focus),
            maxResults: readNumber(args.maxResults),
            maxAttempts: readNumber(args.maxAttempts),
            snippetChars: readNumber(args.snippetChars)
          }, {
            runId: `${callId}:background`,
            threadId: owner?.threadId ?? 'external',
            turnId: owner?.turnId ?? callId,
            onProgress: deps.onResearchProgress
          })
        ])
        result = {
          ok: live.ok && background.ok,
          mode: 'dual',
          live,
          background,
          ...(live.ok && background.ok ? {} : { error: 'one or more dual research lanes failed' })
        }
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
      result = objective
        ? await runBrowserOperation((signal) => deps.browserAgent.snapshot({
            objective,
            url: readString(args.url),
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
      result = await runBrowserOperation((signal) => deps.browserAgent.captureNetwork({
        url: readString(args.url),
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
      result = url
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
