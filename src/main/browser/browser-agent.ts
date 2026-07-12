import type { WebContents, WebFrameMain } from 'electron'
import { cdpSessionFor, type CdpEventQuery, type CdpSession } from './cdp-session.js'
import type { CdpArtifactStore } from './cdp-artifact-store.js'
import { buildDomSnapshotModel } from './dom-snapshot.js'
import type { NetworkJournalQuery } from './network-journal.js'
import { assessExtractedPage } from './research-utils.js'
import type { TabManager } from './tab-manager.js'

export const DEFAULT_BROWSER_TIMEOUT_MS = 15_000
export const MAX_BROWSER_TIMEOUT_MS = 60_000
export const DEFAULT_BROWSER_RESULT_CHARS = 24_000
export const MAX_BROWSER_RESULT_CHARS = 100_000
export const MAX_PARALLEL_BROWSER_TARGETS = 8
export const MAX_PARALLEL_BROWSER_FRAMES = 12
export const PAGE_EXTRACTION_REMOVE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'img', 'picture',
  'video', 'audio', 'iframe', 'object', 'embed', 'source', 'track', 'form',
  'input', 'button', 'select', 'textarea', 'nav', 'footer', 'aside', '[hidden]',
  '[aria-hidden="true"]', '[role="navigation"]', '[role="banner"]',
  '[role="contentinfo"]', '[role="complementary"]', '[role="dialog"]',
  '[role="menu"]', '[role="toolbar"]'
] as const
export const PAGE_EXTRACTION_LOW_VALUE_PATTERN =
  '(^|[-_\\s])(advert|ad|banner|cookie|consent|modal|dialog|popup|newsletter|subscribe|social|share|related|recommend|breadcrumb|pagination|sidebar|toolbar|menu|promo|sponsor)([-_\\s]|$)'

export type BrowserFailureCode =
  | 'timeout'
  | 'targetClosed'
  | 'targetChanged'
  | 'frameDetached'
  | 'frameNotFound'
  | 'executionError'

export type BrowserAgentOptions = {
  tabId?: string | null
  timeoutMs?: number | null
  maxResultChars?: number | null
}

export type BrowserRunOptions = BrowserAgentOptions & {
  frame?: string | null
}

export type BrowserFrameDescriptor = {
  frameId: string
  parentFrameId: string | null
  name: string
  url: string
  origin: string
  isMainFrame: boolean
}

export type BrowserCdpEventOptions = BrowserAgentOptions & {
  afterSequence?: number | null
  filter?: Record<string, unknown> | null
  contains?: Record<string, string> | null
  limit?: number | null
}

type CdpOperationContext = {
  tabId: string
  url: string
  title: string
  webContents: WebContents
}

export type BrowserAgentResult = {
  ok: boolean
  result?: unknown
  error?: string
  tabId?: string
  url?: string
  title?: string
  durationMs?: number
  resultChars?: number
  truncated?: boolean
  errorCode?: BrowserFailureCode
  targetState?: { frames?: BrowserFrameDescriptor[]; targets?: ReturnType<TabManager['listTargets']> }
}

type BrowserAgentSuccess = BrowserAgentResult & {
  ok: true
  result: unknown
  tabId: string
  url: string
  title: string
  durationMs: number
  resultChars: number
  truncated: boolean
}

type BrowserAgentFailure = BrowserAgentResult & {
  ok: false
  error: string
}

type QueuedOperation<T> = Promise<T>

/**
 * Shared browser execution surface for Codex and the legacy Unix-socket API.
 * Operations on one tab are serialized; different tabs can still run in
 * parallel. A timed-out operation remains in the queue until Chromium settles
 * it, preventing the next program from racing a still-running page script.
 */
export class BrowserAgentController {
  private readonly tabQueues = new Map<string, Promise<void>>()
  private readonly getTabs: () => TabManager | null
  private readonly artifactStore?: CdpArtifactStore

  constructor(
    getTabs: () => TabManager | null,
    artifactStore?: CdpArtifactStore
  ) {
    this.getTabs = getTabs
    this.artifactStore = artifactStore
  }

  listTabs(): ReturnType<TabManager['listTabs']> {
    return this.getTabs()?.listTabs() ?? []
  }

  listTargets(): ReturnType<TabManager['listTargets']> {
    return this.getTabs()?.listTargets() ?? []
  }

  async readScreenshotDataUrl(artifactPath: string): Promise<string | null> {
    return this.artifactStore?.readImageDataUrl(artifactPath) ?? null
  }

  async run(code: string, options: BrowserRunOptions = {}): Promise<BrowserAgentResult> {
    if (!code.trim()) {
      return { ok: false, error: 'browser.run requires non-empty JavaScript' } satisfies BrowserAgentFailure
    }

    const tabs = this.getTabs()
    if (!tabs) {
      return { ok: false, error: 'browser not ready (no window)' } satisfies BrowserAgentFailure
    }

    if (options.tabId === 'all') {
      return this.runAcrossTargets(code, options)
    }

    const tabId = options.tabId ?? tabs.getActiveTabId()
    if (!tabId) {
      return { ok: false, error: 'no active tab' } satisfies BrowserAgentFailure
    }

    const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_BROWSER_TIMEOUT_MS, 250, MAX_BROWSER_TIMEOUT_MS)
    const maxResultChars = clampNumber(
      options.maxResultChars,
      DEFAULT_BROWSER_RESULT_CHARS,
      1_000,
      MAX_BROWSER_RESULT_CHARS
    )

    const previous = this.tabQueues.get(tabId) ?? Promise.resolve()
    const operation: QueuedOperation<BrowserAgentResult> = previous.then(async () => {
      const webContents = tabs.resolveWebContents(tabId)
      if (!webContents) {
        return {
          ok: false,
          error: `no browser target with id ${tabId}`,
          errorCode: 'targetClosed',
          targetState: { targets: tabs.listTargets() }
        } satisfies BrowserAgentFailure
      }

      const startedAt = Date.now()
      const execution = executePageProgram(webContents, code, options.frame, maxResultChars)

      try {
        const rawResult = await withTimeout(
          execution,
          timeoutMs,
          () => cdpSessionFor(webContents).terminateExecution()
        )
        const bounded = boundResult(rawResult, maxResultChars)
        const rawMetadata = asRecord(rawResult)
        const nestedTruncated = rawMetadata.truncated === true
        const originalChars = typeof rawMetadata.originalChars === 'number' ? rawMetadata.originalChars : bounded.chars
        return {
          ok: true,
          result: bounded.value,
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt,
          resultChars: originalChars,
          truncated: bounded.truncated || nestedTruncated
        } satisfies BrowserAgentSuccess
      } catch (error) {
        const errorCode = classifyBrowserFailure(error)
        return {
          ok: false,
          error: errorMessage(error),
          errorCode,
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt,
          ...(isLifecycleFailure(errorCode) ? { targetState: { frames: frameInventory(webContents) } } : {})
        } satisfies BrowserAgentFailure
      }
    })

    const queueTail = operation.then(
      () => undefined,
      () => undefined
    )
    this.tabQueues.set(tabId, queueTail)
    void queueTail.then(() => {
      if (this.tabQueues.get(tabId) === queueTail) {
        this.tabQueues.delete(tabId)
      }
    })

    return operation
  }

  private async runAcrossTargets(code: string, options: BrowserRunOptions): Promise<BrowserAgentResult> {
    const targets = this.listTargets()
    if (targets.length === 0) {
      return { ok: false, error: 'no browser targets are available' } satisfies BrowserAgentFailure
    }
    const startedAt = Date.now()
    const maxResultChars = clampNumber(
      options.maxResultChars,
      DEFAULT_BROWSER_RESULT_CHARS,
      1_000,
      MAX_BROWSER_RESULT_CHARS
    )
    const perTargetBudget = fanoutItemBudget(maxResultChars, targets.length, 700)
    const results = await mapWithConcurrency(targets, MAX_PARALLEL_BROWSER_TARGETS, async (target) => {
      const result = await this.run(code, { ...options, tabId: target.id, maxResultChars: perTargetBudget })
      return {
        target,
        ok: result.ok,
        ...(result.ok
          ? { result: result.result, resultChars: result.resultChars ?? 0 }
          : { error: result.error, errorCode: result.errorCode }),
        durationMs: result.durationMs ?? 0,
        truncated: result.truncated === true
      }
    })
    const governed = fitFanoutEnvelope('targets', results, {
      targetCount: results.length,
      succeeded: results.filter(({ ok }) => ok).length,
      failed: results.filter(({ ok }) => !ok).length,
      maxConcurrency: Math.min(MAX_PARALLEL_BROWSER_TARGETS, results.length)
    }, maxResultChars)
    return {
      ok: true,
      result: governed.value,
      tabId: 'all',
      url: '',
      title: 'All browser targets',
      durationMs: Date.now() - startedAt,
      resultChars: governed.originalChars,
      truncated: governed.truncated
    } satisfies BrowserAgentSuccess
  }

  async cdp(
    method: string,
    params: object = {},
    options: BrowserAgentOptions = {}
  ): Promise<BrowserAgentResult> {
    if (!method.trim()) {
      return { ok: false, error: 'browser.cdp requires a method' } satisfies BrowserAgentFailure
    }

    return this.runCdpOperation(options, async (session, timeoutMs, context) => {
      let result: unknown
      try {
        result = await withTimeout(session.send(method, params), timeoutMs)
      } catch (error) {
        if (method !== 'Page.printToPDF' || !isUnsupportedCdpCommand(error)) throw error
        const pdf = await withTimeout(
          context.webContents.printToPDF(params as Parameters<WebContents['printToPDF']>[0]),
          timeoutMs
        )
        result = { data: pdf.toString('base64') }
      }
      return this.materializeCdpResult(method, params, result, context)
    })
  }

  async captureScreenshot(options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    const artifactStore = this.artifactStore
    if (!artifactStore) {
      return { ok: false, error: 'screenshot artifact storage is not available' } satisfies BrowserAgentFailure
    }

    return this.runCdpOperation(options, async (_session, timeoutMs, context) => {
      // This is intentionally Electron-native rather than Page.captureScreenshot:
      // the app owns the WebContents, so no debugger attachment is necessary.
      const image = await withTimeout(context.webContents.capturePage(), timeoutMs)
      const buffer = image.toPNG()
      const screenshot = await artifactStore.persistScreenshot(buffer.toString('base64'), 'png')
      return {
        screenshot: {
          ...screenshot,
          tabId: context.tabId,
          url: context.url,
          title: context.title
        }
      }
    })
  }

  async cdpCapabilities(options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    return this.runCdpOperation(options, (session) => session.capabilities())
  }

  async cdpEvents(options: BrowserCdpEventOptions = {}, method?: string | null): Promise<BrowserAgentResult> {
    return this.runCdpOperation(options, async (session) => {
      await session.capabilities()
      return session.eventPage(toEventQuery(options, method))
    })
  }

  async waitForCdpEvent(method: string, options: BrowserCdpEventOptions = {}): Promise<BrowserAgentResult> {
    if (!method.trim()) {
      return { ok: false, error: 'browser.cdp wait requires an event method' } satisfies BrowserAgentFailure
    }

    return this.runCdpOperation(options, async (session, timeoutMs) => {
      await session.prepareForEvent(method)
      return session.waitForEvent(toEventQuery(options, method), timeoutMs)
    })
  }

  async startCdpTrace(params: object = {}, options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    if (!this.artifactStore) {
      return { ok: false, error: 'CDP artifact storage is not available' } satisfies BrowserAgentFailure
    }
    return this.runCdpOperation(options, async (session, timeoutMs) => {
      const traceParams = { ...asRecord(params), transferMode: 'ReturnAsStream' }
      await withTimeout(session.send('Tracing.start', traceParams), timeoutMs)
      return { tracing: 'started', transferMode: 'ReturnAsStream' }
    })
  }

  async stopCdpTrace(options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    const artifactStore = this.artifactStore
    if (!artifactStore) {
      return { ok: false, error: 'CDP artifact storage is not available' } satisfies BrowserAgentFailure
    }
    return this.runCdpOperation(options, async (session, timeoutMs, context) => {
      const afterSequence = session.eventPage({ limit: 1 }).latestSequence
      await withTimeout(session.send('Tracing.end'), timeoutMs)
      const completed = await session.waitForEvent({
        method: 'Tracing.tracingComplete',
        afterSequence
      }, timeoutMs)
      const stream = asRecord(completed.params).stream
      if (typeof stream !== 'string' || !stream) throw new Error('Tracing completed without a stream handle')

      try {
        const trace = await artifactStore.persistTraceStream(async () => {
          const response = asRecord(await withTimeout(session.send('IO.read', { handle: stream, size: 1_000_000 }), timeoutMs))
          return {
            data: typeof response.data === 'string' ? response.data : '',
            base64Encoded: response.base64Encoded === true,
            eof: response.eof === true
          }
        })
        return { trace: { ...trace, tabId: context.tabId, url: context.url, title: context.title } }
      } finally {
        try {
          await session.send('IO.close', { handle: stream })
        } catch {
          // Chromium may close the stream automatically after EOF.
        }
      }
    })
  }

  async captureDomSnapshot(params: object = {}, options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    const artifactStore = this.artifactStore
    if (!artifactStore) {
      return { ok: false, error: 'CDP artifact storage is not available' } satisfies BrowserAgentFailure
    }
    return this.runCdpOperation(options, async (session, timeoutMs, context) => {
      const { maxNodes: requestedMaxNodes, ...provided } = asRecord(params)
      const computedStyles = Array.isArray(provided.computedStyles)
        ? provided.computedStyles.filter((value): value is string => typeof value === 'string')
        : []
      const snapshot = await withTimeout(session.send('DOMSnapshot.captureSnapshot', {
        ...provided,
        computedStyles,
        includeDOMRects: provided.includeDOMRects !== false,
        includePaintOrder: provided.includePaintOrder === true
      }), timeoutMs)
      const artifact = await artifactStore.persistSnapshot(snapshot)
      const maxNodes = typeof requestedMaxNodes === 'number' ? requestedMaxNodes : 100
      return {
        snapshot: {
          ...artifact,
          model: buildDomSnapshotModel(snapshot, maxNodes),
          tabId: context.tabId,
          url: context.url,
          title: context.title
        }
      }
    })
  }

  async startNetworkJournal(options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    return this.runCdpOperation(options, async (session) => {
      await session.startNetworkJournal()
      return { network: { active: true, startedAt: session.networkJournalPage().startedAt } }
    })
  }

  async readNetworkJournal(params: object = {}, options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    return this.runCdpOperation(options, async (session) => {
      await session.capabilities()
      return { network: session.networkJournalPage(toNetworkJournalQuery(params)) }
    })
  }

  async stopNetworkJournal(options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    return this.runCdpOperation(options, async (session) => ({ network: session.stopNetworkJournal() }))
  }

  async startPerformanceDiagnostics(options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    return this.runCdpOperation(options, async (session) => ({
      performance: await session.startPerformanceDiagnostics()
    }))
  }

  async readPerformanceDiagnostics(options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    return this.runCdpOperation(options, async (session) => ({
      performance: await session.readPerformanceDiagnostics()
    }))
  }

  async stopPerformanceDiagnostics(options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    return this.runCdpOperation(options, async (session) => ({
      performance: await session.stopPerformanceDiagnostics()
    }))
  }

  async captureNetworkResponseBody(requestId: string, options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    const artifactStore = this.artifactStore
    if (!artifactStore) {
      return { ok: false, error: 'CDP artifact storage is not available' } satisfies BrowserAgentFailure
    }
    if (!requestId.trim()) {
      return { ok: false, error: 'browser.cdp networkBody requires a requestId' } satisfies BrowserAgentFailure
    }
    return this.runCdpOperation(options, async (session, timeoutMs, context) => {
      const request = session.networkRequest(requestId)
      if (!request) throw new Error(`network journal has no request with id ${requestId}`)
      const response = asRecord(await withTimeout(session.send('Network.getResponseBody', { requestId }), timeoutMs))
      const body = response.body
      if (typeof body !== 'string') throw new Error('Network.getResponseBody returned no body')
      const artifact = await artifactStore.persistResponseBody(
        body,
        response.base64Encoded === true,
        request.mimeType,
        request.url
      )
      return {
        responseBody: {
          ...artifact,
          requestId,
          requestUrl: request.url,
          status: request.status,
          tabId: context.tabId,
          pageUrl: context.url,
          title: context.title
        }
      }
    })
  }

  private async runCdpOperation(
    options: BrowserAgentOptions,
    execute: (session: CdpSession, timeoutMs: number, context: CdpOperationContext) => Promise<unknown>
  ): Promise<BrowserAgentResult> {
    const tabs = this.getTabs()
    const tabId = options.tabId ?? tabs?.getActiveTabId()
    if (!tabs || !tabId) {
      return { ok: false, error: tabs ? 'no active tab' : 'browser not ready (no window)' } satisfies BrowserAgentFailure
    }

    const timeoutMs = clampNumber(options.timeoutMs, DEFAULT_BROWSER_TIMEOUT_MS, 250, MAX_BROWSER_TIMEOUT_MS)
    const maxResultChars = clampNumber(
      options.maxResultChars,
      DEFAULT_BROWSER_RESULT_CHARS,
      1_000,
      MAX_BROWSER_RESULT_CHARS
    )
    const previous = this.tabQueues.get(tabId) ?? Promise.resolve()
    const operation = previous.then(async (): Promise<BrowserAgentResult> => {
      const webContents = tabs.resolveWebContents(tabId)
      if (!webContents) {
        return { ok: false, error: `no tab with id ${tabId}` } satisfies BrowserAgentFailure
      }

      const startedAt = Date.now()
      try {
        const context = { tabId, url: safeUrl(webContents), title: safeTitle(webContents), webContents }
        const rawResult = await execute(cdpSessionFor(webContents), timeoutMs, context)
        const bounded = boundResult(rawResult, maxResultChars)
        return {
          ok: true,
          result: bounded.value,
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt,
          resultChars: bounded.chars,
          truncated: bounded.truncated
        } satisfies BrowserAgentSuccess
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt
        } satisfies BrowserAgentFailure
      }
    })

    const queueTail = operation.then(
      () => undefined,
      () => undefined
    )
    this.tabQueues.set(tabId, queueTail)
    void queueTail.then(() => {
      if (this.tabQueues.get(tabId) === queueTail) this.tabQueues.delete(tabId)
    })

    return operation
  }

  private async materializeCdpResult(
    method: string,
    params: object,
    result: unknown,
    context: CdpOperationContext
  ): Promise<unknown> {
    if (!this.artifactStore) return result
    const data = asRecord(result).data
    if (typeof data !== 'string') return result

    if (method === 'Page.printToPDF') {
      const pdf = await this.artifactStore.persistPdf(data)
      return { pdf: { ...pdf, tabId: context.tabId, url: context.url, title: context.title } }
    }
    if (method !== 'Page.captureScreenshot') return result

    const format = asRecord(params).format
    const requestedFormat = typeof format === 'string' ? format : null
    const screenshot = await this.artifactStore.persistScreenshot(data, requestedFormat)
    return {
      screenshot: {
        ...screenshot,
        tabId: context.tabId,
        url: context.url,
        title: context.title
      }
    }
  }

  async extractPage(options: BrowserRunOptions = {}): Promise<BrowserAgentResult> {
    const maxResultChars = clampNumber(
      options.maxResultChars,
      DEFAULT_BROWSER_RESULT_CHARS,
      1_000,
      MAX_BROWSER_RESULT_CHARS
    )

    // Leave room for the structured extraction envelope when bounding the
    // page body, so the result remains JSON rather than becoming a partial
    // serialization of the whole envelope.
    const contentMaxChars = Math.max(1_000, maxResultChars - 1_000)

    const result = await this.run(buildPageExtractionProgram(contentMaxChars), {
      ...options,
      maxResultChars
    })
    if (!result.ok) return result

    const page = asRecord(result.result)
    const assessment = assessExtractedPage({
      title: typeof page.title === 'string' ? page.title : '',
      url: typeof page.url === 'string' ? page.url : '',
      content: typeof page.content === 'string' ? page.content : '',
      wordCount: typeof page.wordCount === 'number' ? page.wordCount : 0,
      status: typeof page.status === 'number' ? page.status : undefined
    })
    if (assessment.verified) return result
    return {
      ...result,
      ok: false,
      error: `page verification failed: ${assessment.reason ?? 'unknown'}`,
      errorCode: 'executionError'
    }
  }
}

export function buildPageExtractionProgram(maxChars: number, htmlMaxChars = 0): string {
  const safeMaxChars = clampNumber(maxChars, DEFAULT_BROWSER_RESULT_CHARS, 1_000, MAX_BROWSER_RESULT_CHARS)
  const safeHtmlMaxChars = clampNumber(htmlMaxChars, 0, 0, 2_000_000)
  const htmlField = safeHtmlMaxChars > 0 ? ',\n    html: rawHtml' : ''

  // This is deliberately a deterministic, page-local extraction pipeline:
  // choose the most article-like root, remove non-content components, render
  // semantic blocks, then deduplicate and bound the returned text.
  return `
  const maxChars = ${safeMaxChars};
  const pageUrl = location.href;
  const title = document.title.trim();
  const navigationEntry = globalThis.performance?.getEntriesByType?.('navigation')?.[0];
  const status = Number.isFinite(navigationEntry?.responseStatus) ? navigationEntry.responseStatus : 0;
  const rawHtml = ${safeHtmlMaxChars > 0 ? `(document.documentElement?.outerHTML || '').slice(0, ${safeHtmlMaxChars})` : "''"};
  const body = document.body;
  if (!body) return { title, url: pageUrl, status, content: '', wordCount: 0, truncated: false, reason: 'page has no body'${htmlField} };

  const clone = body.cloneNode(true);
  const removeSelectors = ${JSON.stringify(PAGE_EXTRACTION_REMOVE_SELECTORS)};
  clone.querySelectorAll(removeSelectors.join(',')).forEach((node) => node.remove());

  const lowValuePattern = new RegExp(${JSON.stringify(PAGE_EXTRACTION_LOW_VALUE_PATTERN)}, 'i');
  clone.querySelectorAll('*').forEach((node) => {
    const label = ((node.id || '') + ' ' + (typeof node.className === 'string' ? node.className : '')).trim();
    if (label && lowValuePattern.test(label)) node.remove();
  });

  const candidates = [
    ...clone.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]'),
    clone
  ];
  const score = (node) => {
    const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text.length < 160) return -1;
    const links = [...node.querySelectorAll('a')].reduce((total, link) => total + (link.textContent || '').length, 0);
    const paragraphs = node.querySelectorAll('p').length;
    return text.length + paragraphs * 220 - links * 1.8;
  };
  const root = candidates.reduce((best, node) => score(node) > score(best) ? node : best, clone);

  const blockTags = new Set(['ADDRESS', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL']);
  const headingTags = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const render = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node;
    if (element.matches('img, picture, svg, canvas, video, audio, iframe, object, embed')) return '';
    const children = [...element.childNodes].map(render).join('');
    const text = children.replace(/[ \\t]+/g, ' ').trim();
    if (!text) return '';
    if (headingTags.has(element.tagName)) return '\\n\\n' + '#'.repeat(Number(element.tagName.slice(1))) + ' ' + text + '\\n\\n';
    if (element.tagName === 'LI') return '\\n- ' + text + '\\n';
    if (element.tagName === 'TR') return '\\n' + text.replace(/\\s*\\n\\s*/g, ' | ') + '\\n';
    return blockTags.has(element.tagName) ? '\\n' + text + '\\n' : text;
  };

  const rawLines = render(root)
    .split(/\\n+/)
    .map((line) => line.replace(/\\s+/g, ' ').trim())
    .filter(Boolean);
  const lines = [];
  for (const line of rawLines) {
    if (line.length < 3) continue;
    if (/^(accept cookies|reject cookies|skip to content|advertisement|sign in|log in|subscribe|share)$/i.test(line)) continue;
    if (line !== lines[lines.length - 1]) lines.push(line);
  }
  const content = lines.join('\\n\\n');
  const bounded = content.length > maxChars ? content.slice(0, maxChars).replace(/\\s+\\S*$/, '') : content;
  return {
    title,
    url: pageUrl,
    status,
    content: bounded,
    wordCount: bounded ? bounded.split(/\\s+/).length : 0,
    truncated: bounded.length < content.length,
    removedImages: true,
    removedComponents: true${htmlField}
  };
`
}

async function executePageProgram(
  webContents: WebContents,
  code: string,
  frameSelector: string | null | undefined,
  maxResultChars: number
): Promise<unknown> {
  const wrapped = `(async () => { ${code}\n})()`
  const selector = frameSelector?.trim()
  if (!selector || selector === 'main') return webContents.executeJavaScript(wrapped, true)

  const mainFrame = webContents.mainFrame
  const frames = liveFrames(mainFrame)
  if (selector === 'all') {
    const perFrameBudget = fanoutItemBudget(maxResultChars, frames.length, 550)
    const results = await mapWithConcurrency(frames, MAX_PARALLEL_BROWSER_FRAMES, async (frame) => {
      const descriptor = describeFrame(frame, mainFrame)
      try {
        const result = await frame.executeJavaScript(wrapped, true)
        const bounded = boundResult(result, perFrameBudget)
        return {
          frame: descriptor,
          ok: true,
          result: bounded.value,
          resultChars: bounded.chars,
          truncated: bounded.truncated
        }
      } catch (error) {
        return {
          frame: descriptor,
          ok: false,
          error: errorMessage(error),
          errorCode: classifyBrowserFailure(error),
          truncated: false
        }
      }
    })
    const hasLifecycleFailure = results.some((result) => !result.ok && isLifecycleFailure(result.errorCode))
    return fitFanoutEnvelope('frames', results, {
      frameCount: results.length,
      succeeded: results.filter(({ ok }) => ok).length,
      failed: results.filter(({ ok }) => !ok).length,
      maxConcurrency: Math.min(MAX_PARALLEL_BROWSER_FRAMES, results.length),
      ...(hasLifecycleFailure ? { frameInventory: frameInventory(webContents) } : {})
    }, maxResultChars).value
  }

  const frame = frames.find((candidate) => String(candidate.frameTreeNodeId) === selector)
  if (!frame) throw new Error(`no live frame with id ${selector}`)
  return {
    frame: describeFrame(frame, mainFrame),
    result: await frame.executeJavaScript(wrapped, true)
  }
}

function liveFrames(mainFrame: WebFrameMain): WebFrameMain[] {
  try {
    return mainFrame.framesInSubtree.filter((frame) => !frame.isDestroyed() && !frame.detached)
  } catch {
    return mainFrame.isDestroyed() || mainFrame.detached ? [] : [mainFrame]
  }
}

function describeFrame(frame: WebFrameMain, mainFrame: WebFrameMain): BrowserFrameDescriptor {
  return {
    frameId: String(frame.frameTreeNodeId),
    parentFrameId: frame.parent ? String(frame.parent.frameTreeNodeId) : null,
    name: frame.name,
    url: frame.url,
    origin: frame.origin,
    isMainFrame: frame === mainFrame
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classifyBrowserFailure(error: unknown): BrowserFailureCode {
  const message = errorMessage(error)
  if (/timed out/i.test(message)) return 'timeout'
  if (/no live frame with id/i.test(message)) return 'frameNotFound'
  if (/frame.*(?:disposed|detached|destroyed)|render frame was disposed/i.test(message)) return 'frameDetached'
  if (/execution context was destroyed|cannot find context|navigat(?:e|ed|ion)|target changed/i.test(message)) return 'targetChanged'
  if (/target.*(?:closed|destroyed)|webcontents.*destroyed/i.test(message)) return 'targetClosed'
  return 'executionError'
}

function isLifecycleFailure(code: BrowserFailureCode | undefined): boolean {
  return code === 'timeout' || code === 'targetClosed' || code === 'targetChanged' || code === 'frameDetached' || code === 'frameNotFound'
}

function frameInventory(webContents: WebContents): BrowserFrameDescriptor[] {
  try {
    const mainFrame = webContents.mainFrame
    return liveFrames(mainFrame).map((frame) => describeFrame(frame, mainFrame))
  } catch {
    return []
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void | Promise<void>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(onTimeout?.()).finally(() => {
        reject(new Error(`browser operation timed out after ${timeoutMs}ms`))
      })
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function boundResult(value: unknown, maxChars: number): { value: unknown; chars: number; truncated: boolean } {
  let serialized: string

  try {
    serialized = JSON.stringify(value) ?? 'null'
  } catch (error) {
    throw new Error(`browser result is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (serialized.length <= maxChars) {
    return { value, chars: serialized.length, truncated: false }
  }

  return {
    value: structuredPreview(serialized, maxChars),
    chars: serialized.length,
    truncated: true
  }
}

function structuredPreview(serialized: string, maxChars: number): { truncated: true; originalChars: number; preview: string } {
  const originalChars = serialized.length
  const empty = { truncated: true as const, originalChars, preview: '' }
  const overhead = JSON.stringify(empty).length
  let preview = serialized.slice(0, Math.max(0, maxChars - overhead - 4))
  let value = { ...empty, preview }
  while (preview.length > 0 && JSON.stringify(value).length > maxChars) {
    const excess = JSON.stringify(value).length - maxChars
    preview = preview.slice(0, Math.max(0, preview.length - Math.max(1, excess)))
    value = { ...empty, preview }
  }
  return value
}

function fanoutItemBudget(maxChars: number, itemCount: number, metadataAllowance: number): number {
  const available = Math.max(256, maxChars - 600)
  return Math.max(256, Math.floor(available / Math.max(1, itemCount)) - metadataAllowance)
}

function fitFanoutEnvelope<T>(
  key: 'targets' | 'frames',
  items: T[],
  summary: Record<string, unknown>,
  maxChars: number
): { value: Record<string, unknown>; originalChars: number; truncated: boolean } {
  const original = { ...summary, [key]: items }
  const originalChars = JSON.stringify(original).length
  const visible: T[] = []
  let omitted = 0

  for (const item of items) {
    const candidate = {
      ...summary,
      [key]: [...visible, item],
      omittedItems: items.length - visible.length - 1,
      truncated: items.some((entry) => asRecord(entry).truncated === true) || items.length - visible.length - 1 > 0,
      originalChars
    }
    if (JSON.stringify(candidate).length <= maxChars) {
      visible.push(item)
    } else {
      omitted += 1
    }
  }

  const childTruncated = items.some((item) => asRecord(item).truncated === true)
  const value = {
    ...summary,
    [key]: visible,
    omittedItems: omitted,
    truncated: childTruncated || omitted > 0,
    originalChars
  }
  const bounded = boundResult(value, maxChars)
  return {
    value: asRecord(bounded.value),
    originalChars,
    truncated: childTruncated || omitted > 0 || bounded.truncated
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function toEventQuery(options: BrowserCdpEventOptions, method?: string | null): CdpEventQuery {
  return {
    ...(method?.trim() ? { method } : {}),
    ...(options.afterSequence === null || options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.contains ? { contains: options.contains } : {}),
    ...(options.limit === null || options.limit === undefined ? {} : { limit: options.limit })
  }
}

function toNetworkJournalQuery(value: object): NetworkJournalQuery {
  const params = asRecord(value)
  return {
    limit: typeof params.limit === 'number' ? params.limit : null,
    urlContains: typeof params.urlContains === 'string' ? params.urlContains : null,
    resourceType: typeof params.resourceType === 'string' ? params.resourceType : null,
    statusMin: typeof params.statusMin === 'number' ? params.statusMin : null,
    statusMax: typeof params.statusMax === 'number' ? params.statusMax : null,
    failedOnly: params.failedOnly === true
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isUnsupportedCdpCommand(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /wasn't found|method not found|not supported/i.test(message)
}

function clampNumber(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function safeUrl(webContents: WebContents): string {
  try {
    return webContents.getURL()
  } catch {
    return ''
  }
}

function safeTitle(webContents: WebContents): string {
  try {
    return webContents.getTitle()
  } catch {
    return ''
  }
}
