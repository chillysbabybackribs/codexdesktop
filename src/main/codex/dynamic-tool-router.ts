import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import type { ResearchProgress } from '../../shared/ipc.js'
import type { DynamicToolCallParams } from '../../shared/codex-protocol/v2/DynamicToolCallParams.js'
import type { DynamicToolCallResponse } from '../../shared/codex-protocol/v2/DynamicToolCallResponse.js'
import { runUiReview } from './ui-review.js'

export async function routeDynamicToolCall(
  params: DynamicToolCallParams,
  dependencies: {
    browserAgent: BrowserAgentController
    researchRunner: ResearchRunner
    onResearchProgress?: (progress: ResearchProgress) => void
  }
): Promise<DynamicToolCallResponse> {
  try {
    const args = asRecord(params.arguments)
    const owner = {
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId
    }
    const isBrowserTool = params.namespace === null && params.tool !== 'research_web'
    const blockedResult = isBrowserTool ? dependencies.browserAgent.blockedTurnBrowserResult(owner) : null
    if (blockedResult) return dynamicToolResponse(blockedResult)
    const runBrowserOperation = <T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T> =>
      dependencies.browserAgent.runForTurn(owner, execute)
    let result
    let imageUrls: string[] = []

    if (params.namespace !== null) {
      result = { ok: false, error: `unsupported dynamic tool namespace: ${params.namespace}` }
    } else if (params.tool === 'browser_screenshot') {
      const tabId = resolveAgentTab(readString(args.tab))
      result = await runBrowserOperation((signal) => dependencies.browserAgent.captureScreenshot({ tabId, signal }))
      const screenshot = asRecord(asRecord(result.result).screenshot)
      const artifactPath = readString(screenshot.artifactPath)
      if (result.ok && artifactPath) {
        const imageUrl = await dependencies.browserAgent.readScreenshotDataUrl(artifactPath)
        if (imageUrl) imageUrls = [imageUrl]
        else {
          result = { ...result, ok: false, error: 'captured screenshot could not be loaded for model vision' }
        }
      }
    } else if (params.tool === 'app_screenshot') {
      result = await runBrowserOperation((signal) => dependencies.browserAgent.captureAppScreenshot({ signal }))
      const screenshot = asRecord(asRecord(result.result).screenshot)
      const artifactPath = readString(screenshot.artifactPath)
      if (result.ok && artifactPath) {
        const imageUrl = await dependencies.browserAgent.readScreenshotDataUrl(artifactPath)
        if (imageUrl) imageUrls = [imageUrl]
        else {
          result = { ...result, ok: false, error: 'captured app screenshot could not be loaded for model vision' }
        }
      }
    } else if (params.tool === 'ui_review') {
      const review = await runBrowserOperation((signal) => runUiReview(
        dependencies.browserAgent,
        args.viewports,
        { tabId: resolveAgentTab(readString(args.tab)) ?? undefined, signal }
      ))
      result = review.result
      imageUrls = review.imageUrls
    } else if (params.tool === 'browser_snapshot') {
      const objective = readString(args.objective)
      result = objective
        ? await runBrowserOperation((signal) => dependencies.browserAgent.snapshot({
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
    } else if (params.tool === 'browser_flow') {
      result = Array.isArray(args.steps)
        ? await runBrowserOperation((signal) => dependencies.browserAgent.flow(args.steps, {
            tabId: resolveAgentTab(readString(args.tab)),
            timeoutMs: readNumber(args.timeoutMs),
            maxResultChars: readNumber(args.maxResultChars),
            signal
          }))
        : { ok: false, error: 'browser_flow requires a non-empty "steps" array' }
    } else if (params.tool === 'browser_run') {
      const code = readString(args.code)
      result = code
        ? await runBrowserOperation((signal) => dependencies.browserAgent.run(code, {
            tabId: resolveAgentTab(readString(args.tab)),
            frame: readString(args.frame),
            timeoutMs: readNumber(args.timeoutMs),
            maxResultChars: readNumber(args.maxResultChars),
            signal
          }))
        : { ok: false, error: 'browser_run requires a string "code" argument' }
    } else if (params.tool === 'browser_navigate') {
      const url = readString(args.url)
      result = url
        ? await runBrowserOperation((signal) => dependencies.browserAgent.navigate(url, {
            tabId: resolveAgentTab(readString(args.tab)),
            readySelector: readString(args.readySelector),
            timeoutMs: readNumber(args.timeoutMs),
            quietMs: readNumber(args.quietMs),
            maxSettleMs: readNumber(args.maxSettleMs),
            signal
          }))
        : { ok: false, error: 'browser_navigate requires a string "url" argument' }
    } else if (params.tool === 'browser_extract_page') {
      result = await runBrowserOperation((signal) => dependencies.browserAgent.extractPage({
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
    } else if (params.tool === 'browser_cdp') {
      result = await runBrowserOperation((signal) => routeCdpOperation(args, dependencies.browserAgent, signal))
    } else if (params.tool === 'research_web') {
      result = await dependencies.researchRunner.run({
        queries: readStringArray(args.queries),
        urls: readStringArray(args.urls),
        focus: readResearchFocus(args.focus),
        maxResults: readNumber(args.maxResults),
        maxAttempts: readNumber(args.maxAttempts),
        snippetChars: readNumber(args.snippetChars)
      }, {
        runId: params.callId,
        threadId: params.threadId,
        turnId: params.turnId,
        onProgress: dependencies.onResearchProgress
      })
    } else {
      result = { ok: false, error: `unsupported browser tool: ${params.tool}` }
    }

    if (isBrowserTool) dependencies.browserAgent.blockTurnBrowserWork(owner, result)
    return dynamicToolResponse(result, imageUrls)
  } catch (error) {
    return {
      success: false,
      contentItems: [{
        type: 'inputText',
        text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }]
    }
  }
}

function dynamicToolResponse(result: { ok: boolean }, imageUrls: string[] = []): DynamicToolCallResponse {
  return {
    success: result.ok,
    contentItems: [
      { type: 'inputText', text: JSON.stringify(result) },
      ...imageUrls.map((imageUrl) => ({ type: 'inputImage' as const, imageUrl }))
    ]
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

function readStringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}
