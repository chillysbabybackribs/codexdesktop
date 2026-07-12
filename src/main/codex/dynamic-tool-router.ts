import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import type { DynamicToolCallParams } from '../../shared/codex-protocol/v2/DynamicToolCallParams.js'
import type { DynamicToolCallResponse } from '../../shared/codex-protocol/v2/DynamicToolCallResponse.js'
import { runUiReview } from './ui-review.js'

export async function routeDynamicToolCall(
  params: DynamicToolCallParams,
  dependencies: { browserAgent: BrowserAgentController; researchRunner: ResearchRunner }
): Promise<DynamicToolCallResponse> {
  try {
    const args = asRecord(params.arguments)
    let result
    let imageUrls: string[] = []

    if (params.namespace !== null) {
      result = { ok: false, error: `unsupported dynamic tool namespace: ${params.namespace}` }
    } else if (params.tool === 'browser_screenshot') {
      const tabId = resolveAgentTab(readString(args.tab))
      result = await dependencies.browserAgent.captureScreenshot({ tabId })
      const screenshot = asRecord(asRecord(result.result).screenshot)
      const artifactPath = readString(screenshot.artifactPath)
      if (result.ok && artifactPath) {
        const imageUrl = await dependencies.browserAgent.readScreenshotDataUrl(artifactPath)
        if (imageUrl) imageUrls = [imageUrl]
        else {
          result = { ...result, ok: false, error: 'captured screenshot could not be loaded for model vision' }
        }
      }
    } else if (params.tool === 'ui_review') {
      const review = await runUiReview(
        dependencies.browserAgent,
        args.viewports,
        resolveAgentTab(readString(args.tab)) ?? undefined
      )
      result = review.result
      imageUrls = review.imageUrls
    } else if (params.tool === 'browser_run') {
      const code = readString(args.code)
      result = code
        ? await dependencies.browserAgent.run(code, {
            tabId: resolveAgentTab(readString(args.tab)),
            frame: readString(args.frame),
            timeoutMs: readNumber(args.timeoutMs),
            maxResultChars: readNumber(args.maxResultChars)
          })
        : { ok: false, error: 'browser_run requires a string "code" argument' }
    } else if (params.tool === 'browser_extract_page') {
      result = await dependencies.browserAgent.extractPage({
        tabId: resolveAgentTab(readString(args.tab)),
        frame: readString(args.frame),
        timeoutMs: readNumber(args.timeoutMs),
        maxResultChars: readNumber(args.maxResultChars)
      })
    } else if (params.tool === 'browser_cdp') {
      result = await routeCdpOperation(args, dependencies.browserAgent)
    } else if (params.tool === 'research_web') {
      result = await dependencies.researchRunner.run({
        queries: readStringArray(args.queries),
        maxResults: readNumber(args.maxResults),
        maxPages: readNumber(args.maxPages),
        snippetChars: readNumber(args.snippetChars)
      }, params.turnId)
    } else {
      result = { ok: false, error: `unsupported browser tool: ${params.tool}` }
    }

    return {
      success: result.ok,
      contentItems: [
        { type: 'inputText', text: JSON.stringify(result) },
        ...imageUrls.map((imageUrl) => ({ type: 'inputImage' as const, imageUrl }))
      ]
    }
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

async function routeCdpOperation(
  args: Record<string, unknown>,
  browserAgent: BrowserAgentController
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
    limit: readNumber(args.limit)
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readStringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}
