import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRequest, ResearchRunContext, ResearchRunner } from '../browser/research-runner.js'
import type { DynamicToolCallParams } from '../../shared/codex-protocol/v2/DynamicToolCallParams.js'
import { routeDynamicToolCall } from './dynamic-tool-router.js'

function params(tool: string, args: DynamicToolCallParams['arguments'], namespace: string | null = null): DynamicToolCallParams {
  return { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace, tool, arguments: args }
}

const unusedBrowser = {
  blockedTurnBrowserResult: () => null,
  blockTurnBrowserWork: () => {}
} as unknown as BrowserAgentController
const unusedResearch = {} as ResearchRunner

function withTurnRunner<T extends object>(browserAgent: T): T & Pick<BrowserAgentController, 'runForTurn'> {
  return {
    ...browserAgent,
    blockedTurnBrowserResult: () => null,
    blockTurnBrowserWork: () => {},
    runForTurn: async (_owner, execute) => execute(new AbortController().signal)
  } as T & Pick<BrowserAgentController, 'runForTurn'>
}

function textResult(response: Awaited<ReturnType<typeof routeDynamicToolCall>>): { ok: boolean; error?: string } {
  const item = response.contentItems[0]
  assert.equal(item?.type, 'inputText')
  if (item?.type !== 'inputText') assert.fail('expected inputText response')
  return JSON.parse(item.text) as { ok: boolean; error?: string }
}

test('dynamic tool router rejects provider namespaces', async () => {
  const response = await routeDynamicToolCall(params('browser_run', {}, 'provider'), {
    browserAgent: unusedBrowser,
    researchRunner: unusedResearch
  })

  assert.equal(response.success, false)
  assert.match(textResult(response).error ?? '', /unsupported dynamic tool namespace/)
})

test('dynamic tool router validates required browser_run code', async () => {
  const response = await routeDynamicToolCall(params('browser_run', { code: '   ' }), {
    browserAgent: unusedBrowser,
    researchRunner: unusedResearch
  })

  assert.equal(response.success, false)
  assert.match(textResult(response).error ?? '', /requires a string "code" argument/)
})

test('dynamic tool router validates and forwards navigation-aware browser flows', async () => {
  const rejected = await routeDynamicToolCall(params('browser_flow', {}), {
    browserAgent: unusedBrowser,
    researchRunner: unusedResearch
  })
  assert.equal(rejected.success, false)
  assert.match(textResult(rejected).error ?? '', /requires a non-empty "steps" array/)

  let received: unknown = null
  const browserAgent = withTurnRunner({
    flow: async (steps: unknown, options: unknown) => {
      received = { steps, options }
      return { ok: true, result: { outcome: 'not_found', completedSteps: 2 } }
    }
  }) as unknown as BrowserAgentController
  const steps = [
    { type: 'wait', selector: '.results' },
    { type: 'find', selector: 'a.target' }
  ]
  const response = await routeDynamicToolCall(params('browser_flow', {
    steps,
    tab: 'tab-1',
    timeoutMs: 4_000,
    maxResultChars: 6_000
  }), { browserAgent, researchRunner: unusedResearch })

  assert.equal(response.success, true)
  const receivedRecord = received as { steps: unknown; options: { signal?: AbortSignal } & Record<string, unknown> }
  assert.equal(receivedRecord.options.signal instanceof AbortSignal, true)
  assert.deepEqual({ steps: receivedRecord.steps, options: omitSignal(receivedRecord.options) }, {
    steps,
    options: { tabId: 'tab-1', timeoutMs: 4_000, maxResultChars: 6_000 }
  })
})

test('dynamic tool router validates and forwards the one-call browser snapshot', async () => {
  const rejected = await routeDynamicToolCall(params('browser_snapshot', { objective: '   ' }), {
    browserAgent: unusedBrowser,
    researchRunner: unusedResearch
  })
  assert.equal(rejected.success, false)
  assert.match(textResult(rejected).error ?? '', /requires a string "objective" argument/)

  let received: unknown = null
  const browserAgent = withTurnRunner({
    snapshot: async (options: unknown) => {
      received = options
      return { ok: true }
    }
  }) as unknown as BrowserAgentController
  const response = await routeDynamicToolCall(params('browser_snapshot', {
    objective: 'latest 3 notifications and whether each is read or unread',
    url: 'https://example.com/inbox',
    tab: 'tab-1',
    frame: 'main',
    mode: 'task',
    order: 'reverse-document',
    selector: 'notification-list',
    maxItems: 3,
    readySelector: 'notification-item',
    timeoutMs: 4_000,
    quietMs: 80,
    maxSettleMs: 500,
    maxResultChars: 6_000
  }), { browserAgent, researchRunner: unusedResearch })

  assert.equal(response.success, true)
  assert.equal((received as { signal?: AbortSignal }).signal instanceof AbortSignal, true)
  assert.deepEqual(omitSignal(received as Record<string, unknown>), {
    objective: 'latest 3 notifications and whether each is read or unread',
    url: 'https://example.com/inbox',
    tabId: 'tab-1',
    frame: 'main',
    mode: 'task',
    order: 'reverse-document',
    selector: 'notification-list',
    maxItems: 3,
    readySelector: 'notification-item',
    timeoutMs: 4_000,
    quietMs: 80,
    maxSettleMs: 500,
    maxResultChars: 6_000
  })
})

test('dynamic tool router forwards selector-ready navigation', async () => {
  let received: unknown = null
  const browserAgent = withTurnRunner({
    navigate: async (url: string, options: unknown) => {
      received = { url, options }
      return { ok: true }
    }
  }) as unknown as BrowserAgentController
  const response = await routeDynamicToolCall(params('browser_navigate', {
    url: 'https://example.com/inbox',
    tab: 'tab-1',
    readySelector: '[data-testid="inbox-row"]',
    timeoutMs: 4_000,
    quietMs: 200,
    maxSettleMs: 1_000
  }), { browserAgent, researchRunner: unusedResearch })

  assert.equal(response.success, true)
  const receivedRecord = received as { url: string; options: { signal?: AbortSignal } & Record<string, unknown> }
  assert.equal(receivedRecord.options.signal instanceof AbortSignal, true)
  assert.deepEqual({ url: receivedRecord.url, options: omitSignal(receivedRecord.options) }, {
    url: 'https://example.com/inbox',
    options: {
      tabId: 'tab-1',
      readySelector: '[data-testid="inbox-row"]',
      timeoutMs: 4_000,
      quietMs: 200,
      maxSettleMs: 1_000
    }
  })
})

test('dynamic tool router returns app screenshot image content', async () => {
  const browserAgent = withTurnRunner({
    captureAppScreenshot: async () => ({
      ok: true,
      result: {
        screenshot: {
          artifactPath: '/tmp/app-window.png',
          fileName: 'app-window.png',
          mediaType: 'image/png',
          bytes: 42,
          width: 800,
          height: 600
        }
      }
    }),
    readScreenshotDataUrl: async () => 'data:image/png;base64,abc'
  }) as unknown as BrowserAgentController
  const response = await routeDynamicToolCall(params('app_screenshot', {}), {
    browserAgent,
    researchRunner: unusedResearch
  })

  assert.equal(response.success, true)
  assert.equal(response.contentItems.length, 2)
  assert.equal(response.contentItems[1]?.type, 'inputImage')
  if (response.contentItems[1]?.type === 'inputImage') {
    assert.equal(response.contentItems[1].imageUrl, 'data:image/png;base64,abc')
  }
})

test('dynamic browser calls carry their exact owning turn', async () => {
  let owner: unknown = null
  const browserAgent = {
    blockedTurnBrowserResult: () => null,
    blockTurnBrowserWork: () => {},
    runForTurn: async (nextOwner: unknown, execute: (signal: AbortSignal) => Promise<unknown>) => {
      owner = nextOwner
      return execute(new AbortController().signal)
    },
    run: async () => ({ ok: true })
  } as unknown as BrowserAgentController

  const response = await routeDynamicToolCall(params('browser_run', { code: 'return 1' }), {
    browserAgent,
    researchRunner: unusedResearch
  })

  assert.equal(response.success, true)
  assert.deepEqual(owner, { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' })
})

function omitSignal(value: Record<string, unknown>): Record<string, unknown> {
  const { signal: _signal, ...rest } = value
  return rest
}

test('dynamic tool router normalizes research arguments and forwards run context and progress', async () => {
  let request: ResearchRequest | null = null
  const contexts: ResearchRunContext[] = []
  let progressMessage: string | null = null
  const researchRunner = {
    run: async (next: ResearchRequest, nextContext: ResearchRunContext) => {
      request = next
      contexts.push(nextContext)
      nextContext.onProgress?.({ stage: 'discovering', message: 'Searching source lane 1/1…' })
      return { ok: true }
    }
  } as ResearchRunner
  const response = await routeDynamicToolCall(params('research_web', {
    queries: ['one', 2, 'two'],
    urls: ['https://example.com/docs', false],
    focus: [
      { id: 'official', need: 'official behavior', minSources: 2 },
      { id: 'bad', need: '   ' },
      { id: 'current', need: 'current version', minSources: Number.NaN }
    ],
    maxResults: 4,
    maxAttempts: 3,
    snippetChars: 1200
  }), {
    browserAgent: unusedBrowser,
    researchRunner,
    onResearchProgress: (progress) => { progressMessage = progress.message }
  })

  assert.equal(response.success, true)
  assert.deepEqual(request, {
    queries: ['one', 'two'],
    urls: ['https://example.com/docs'],
    focus: [
      { id: 'official', need: 'official behavior', minSources: 2 },
      { id: 'current', need: 'current version' }
    ],
    maxResults: 4,
    maxAttempts: 3,
    snippetChars: 1200
  })
  const context = contexts[0]
  assert.ok(context)
  assert.equal(context?.runId, 'call-1')
  assert.equal(context?.threadId, 'thread-1')
  assert.equal(context?.turnId, 'turn-1')
  assert.equal(progressMessage, 'Searching source lane 1/1…')
})
