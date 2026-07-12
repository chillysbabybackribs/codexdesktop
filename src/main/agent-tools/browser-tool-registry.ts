import { z } from 'zod'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import { runUiReview } from '../codex/ui-review.js'

const optionalTab = z.string().min(1).optional()
const optionalTimeout = z.number().min(250).max(60_000).optional()
const optionalResultLimit = z.number().min(1_000).max(100_000).optional()

export const browserToolDefinitions = [
  {
    name: 'browser_screenshot',
    description: 'Capture the visible viewport of this thread\'s browser tab and view it directly. Returns the screenshot to the model as an image plus compact artifact metadata.',
    inputShape: {
      tab: optionalTab.describe('Optional tab id. Defaults to this thread\'s visible browser tab.')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: 'ui_review',
    description: 'Capture desktop, tablet, and mobile screenshots for model vision while auditing overflow, clipped content, headings, landmarks, touch targets, images, fonts, runtime exceptions, and failed requests. Restores normal viewport emulation afterward.',
    inputShape: {
      tab: optionalTab.describe('Optional tab id. Defaults to the active visible tab.'),
      viewports: z.array(z.enum(['desktop', 'tablet', 'mobile']))
        .min(1)
        .max(3)
        .optional()
        .describe('Responsive viewports to capture and audit. Defaults to desktop, tablet, and mobile.')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: 'browser_run',
    description: 'Run a batched JavaScript program in a visible browser target. Inspect, act, wait, and verify in one call. Use tab or frame all for parallel target/frame execution; return compact JSON. Page-origin CORS rules apply within each frame.',
    inputShape: {
      code: z.string().min(1).describe('JavaScript program. Top-level return and await are supported.'),
      tab: optionalTab.describe('Optional tab or popup target id. Defaults to the active visible tab; use all to run the program across every live target in parallel.'),
      frame: z.string().min(1).optional().describe('Optional frame target. Defaults to main; use all to run the same program across every live frame in parallel, or pass a frameId returned by browser_run.'),
      timeoutMs: optionalTimeout.describe('Optional timeout from 250 to 60000 milliseconds.'),
      maxResultChars: optionalResultLimit.describe('Optional serialized result limit from 1000 to 100000 characters.')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'browser_extract_page',
    description: 'Extract bounded useful text from one visible page after verifying it is real content rather than an empty shell, login wall, or challenge page.',
    inputShape: {
      tab: optionalTab.describe('Optional tab id. Defaults to the active visible tab.'),
      frame: z.string().min(1).optional().describe('Optional frame target: main, all, or a frameId returned by browser_run.'),
      timeoutMs: optionalTimeout.describe('Optional extraction timeout from 250 to 60000 milliseconds.'),
      maxResultChars: optionalResultLimit.describe('Optional extracted content limit from 1000 to 100000 characters.')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: 'browser_cdp',
    description: 'Use the live Chrome DevTools Protocol for a browser tab. Send a targeted command, inspect protocol capabilities, read a bounded event journal, prepare and wait for lifecycle/network/runtime/log events, save a streamed Chromium trace, or capture a raw DOM snapshot with a compact interaction model.',
    inputShape: {
      operation: z.enum(['command', 'capabilities', 'events', 'wait', 'traceStart', 'traceStop', 'snapshot', 'networkStart', 'network', 'networkBody', 'networkStop', 'performanceStart', 'performance', 'performanceStop'])
        .optional()
        .describe('Defaults to command. Use capabilities/events/wait for raw protocol inspection, traceStart/traceStop for a trace artifact, snapshot for a compact DOM model, networkStart/network/networkBody/networkStop for task-scoped network diagnostics, or performanceStart/performance/performanceStop for rated runtime, navigation, lifecycle, Web Vitals, interaction, long-task, and trace-escalation diagnostics.'),
      method: z.string().min(1).optional().describe('CDP command for operation command, or exact event name for events/wait, such as Page.captureScreenshot or Network.responseReceived.'),
      requestId: z.string().min(1).optional().describe('Network request id for operation networkBody. The request must still be present in the bounded journal.'),
      params: z.record(z.string(), z.unknown()).optional().describe('Operation parameters. For network, supports limit, urlContains, resourceType, statusMin, statusMax, and failedOnly. Trace, raw snapshot, and response-body output are artifact-backed.'),
      filter: z.record(z.string(), z.unknown()).optional().describe('Optional nested exact-match filter for events/wait, such as {"name":"networkIdle"}.'),
      contains: z.record(z.string(), z.string()).optional().describe('Optional dot-path substring filter for events/wait, such as {"response.url":"/api/"}.'),
      afterSequence: z.number().optional().describe('For events/wait, return only events newer than this journal sequence.'),
      limit: z.number().min(1).max(100).optional().describe('For events, maximum matching records from 1 to 100; defaults to 30.'),
      tab: optionalTab.describe('Optional tab id. Defaults to the active visible tab; pass an explicit id for deterministic network or performance diagnostics.'),
      timeoutMs: optionalTimeout.describe('Optional timeout from 250 to 60000 milliseconds.'),
      maxResultChars: optionalResultLimit.describe('Optional serialized result limit from 1000 to 100000 characters.')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'research_web',
    description: 'Discover, rank, verify, and save a bounded set of public web pages. Returns compact metadata and artifact paths without loading page bodies into model context.',
    inputShape: {
      queries: z.array(z.string().min(1)).min(1).max(3).describe('One to three focused discovery queries covering the strongest relevant source lanes.'),
      maxResults: z.number().min(1).max(10).optional().describe('Optional SERP candidates per query, from 1 to 10.'),
      maxPages: z.number().min(1).max(8).optional().describe('Optional verified pages to save, from 1 to 8. Defaults to 3.'),
      snippetChars: z.number().min(1_000).max(8_000).optional().describe('Optional cleaned text saved per page, from 1000 to 8000 characters.')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }
] as const satisfies readonly BrowserToolDefinition[]

export type BrowserToolName = typeof browserToolDefinitions[number]['name']

export type BrowserToolDependencies = {
  browserAgent: BrowserAgentController
  researchRunner: ResearchRunner
}

export type BrowserToolExecution = {
  result: { ok: boolean; [key: string]: unknown }
  imageUrls: string[]
}

type BrowserToolDefinition = {
  name: string
  description: string
  inputShape: z.ZodRawShape
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
}

export function browserToolInputSchema(definition: BrowserToolDefinition): z.ZodObject<z.ZodRawShape> {
  return z.object(definition.inputShape).strict()
}

export function findBrowserToolDefinition(name: string): BrowserToolDefinition | undefined {
  return browserToolDefinitions.find((definition) => definition.name === name)
}

export async function executeBrowserTool(
  name: string,
  rawArguments: unknown,
  dependencies: BrowserToolDependencies,
  context: { turnId?: string } = {}
): Promise<BrowserToolExecution> {
  const definition = findBrowserToolDefinition(name)
  if (!definition) {
    return { result: { ok: false, error: `unsupported browser tool: ${name}` }, imageUrls: [] }
  }

  const rawRecord = asRecord(rawArguments)
  if (name === 'browser_run' && !readString(rawRecord.code)) {
    return {
      result: { ok: false, error: 'browser_run requires a string "code" argument' },
      imageUrls: []
    }
  }

  const normalizedArguments = name === 'research_web'
    ? { ...rawRecord, queries: readStringArray(rawRecord.queries) }
    : rawArguments
  const parsed = browserToolInputSchema(definition).safeParse(normalizedArguments)
  if (!parsed.success) {
    return {
      result: { ok: false, error: `invalid ${name} arguments: ${z.prettifyError(parsed.error)}` },
      imageUrls: []
    }
  }

  const args = parsed.data
  let result: { ok: boolean; [key: string]: unknown }
  let imageUrls: string[] = []

  if (name === 'browser_screenshot') {
    result = await dependencies.browserAgent.captureScreenshot({ tabId: readString(args.tab) })
    const artifactPath = readString(asRecord(asRecord(result.result).screenshot).artifactPath)
    if (result.ok && artifactPath) {
      const imageUrl = await dependencies.browserAgent.readScreenshotDataUrl(artifactPath)
      if (imageUrl) imageUrls = [imageUrl]
      else result = { ...result, ok: false, error: 'captured screenshot could not be loaded for model vision' }
    }
  } else if (name === 'ui_review') {
    const review = await runUiReview(dependencies.browserAgent, args.viewports, readString(args.tab))
    result = review.result
    imageUrls = review.imageUrls
  } else if (name === 'browser_run') {
    result = await dependencies.browserAgent.run(readString(args.code)!, {
      tabId: readString(args.tab),
      frame: readString(args.frame),
      timeoutMs: readNumber(args.timeoutMs),
      maxResultChars: readNumber(args.maxResultChars)
    })
  } else if (name === 'browser_extract_page') {
    result = await dependencies.browserAgent.extractPage({
      tabId: readString(args.tab),
      frame: readString(args.frame),
      timeoutMs: readNumber(args.timeoutMs),
      maxResultChars: readNumber(args.maxResultChars)
    })
  } else if (name === 'browser_cdp') {
    result = await routeCdpOperation(args, dependencies.browserAgent)
  } else {
    result = await dependencies.researchRunner.run({
      queries: readStringArray(args.queries),
      maxResults: readNumber(args.maxResults),
      maxPages: readNumber(args.maxPages),
      snippetChars: readNumber(args.snippetChars)
    }, context.turnId ?? '')
  }

  return { result, imageUrls }
}

async function routeCdpOperation(
  args: Record<string, unknown>,
  browserAgent: BrowserAgentController
): Promise<{ ok: boolean; [key: string]: unknown }> {
  const operation = readString(args.operation) ?? 'command'
  const method = readString(args.method)
  const options = {
    tabId: readString(args.tab),
    timeoutMs: readNumber(args.timeoutMs),
    maxResultChars: readNumber(args.maxResultChars),
    afterSequence: readNumber(args.afterSequence),
    filter: asRecord(args.filter),
    contains: readStringRecord(args.contains),
    limit: readNumber(args.limit)
  }

  if (operation === 'capabilities') return browserAgent.cdpCapabilities(options)
  if (operation === 'events') return browserAgent.cdpEvents(options, method)
  if (operation === 'wait') return method
    ? browserAgent.waitForCdpEvent(method, options)
    : { ok: false, error: 'browser_cdp wait requires a string "method" event name' }
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
  if (operation === 'command') return method
    ? browserAgent.cdp(method, asRecord(args.params), options)
    : { ok: false, error: 'browser_cdp command requires a string "method" argument' }
  return { ok: false, error: `unsupported browser_cdp operation: ${operation}` }
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
