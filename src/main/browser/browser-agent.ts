import type { WebContents } from 'electron'
import { cdpSessionFor, type CdpEventQuery, type CdpSession } from './cdp-session.js'
import type { CdpArtifactStore, CdpFileArtifact } from './cdp-artifact-store.js'
import { runBrowserFlow } from './browser-flow.js'
import { executePageJavaScript } from './page-execution.js'
import { buildDomSnapshotModel } from './dom-snapshot.js'
import type { NetworkJournalQuery, NetworkStreamTransport } from './network-journal.js'
import { buildPageSnapshotProgram, type PageSnapshotMode, type PageSnapshotOrder } from './page-snapshot.js'
import { assessExtractedPage } from './research-utils.js'
import { captureAppWindowImage } from './app-window-screenshot.js'
import { browserDownloadCaptureBroker } from './browser-download-capture.js'
import type { TabManager } from './tab-manager.js'
import {
  KeyedOperationQueue,
  assertTargetLeaseCurrent,
  boundResult,
  browserFailureFields,
  browserFailureFor,
  cancelledResult,
  captureTargetLease,
  createBoundedSuccessResult,
  createFailureResult,
  describeFrame,
  frameInventory,
  isLifecycleFailure,
  liveFrames,
  operationError,
  safeTitle,
  safeUrl,
  withTimeout,
  type BrowserAgentFailure,
  type BrowserAgentResult,
  type BrowserAgentSuccess,
  type BrowserFailure,
  type BrowserFailureCode,
  type BrowserSnapshotCompletion
} from './browser-operation.js'

export type {
  BrowserAgentResult,
  BrowserFailure,
  BrowserFailureCode,
  BrowserFailurePhase,
  BrowserFrameDescriptor,
  BrowserSnapshotCompletion
} from './browser-operation.js'

export const DEFAULT_BROWSER_TIMEOUT_MS = 15_000
export const MAX_BROWSER_TIMEOUT_MS = 60_000
// Tool transcripts are model context. Keep the ordinary path compact; callers
// can request a larger explicit budget and oversized raw results are saved as
// artifacts when storage is available.
export const DEFAULT_BROWSER_RESULT_CHARS = 8_000
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

export type BrowserOperationOwner = {
  threadId: string
  turnId: string
  callId?: string
}

export type BrowserAgentOptions = {
  tabId?: string | null
  timeoutMs?: number | null
  maxResultChars?: number | null
  /** Internal turn-lifetime signal. Socket and UI callers intentionally omit it. */
  signal?: AbortSignal
  /** Internal guard for observational operations that must not return stale page data. */
  requireStableTarget?: boolean
}

export type BrowserRunOptions = BrowserAgentOptions & {
  frame?: string | null
}

export type BrowserFlowOptions = BrowserAgentOptions

export type BrowserNavigateOptions = BrowserAgentOptions & {
  readySelector?: string | null
  quietMs?: number | null
  maxSettleMs?: number | null
}

export type BrowserNetworkCaptureParams = {
  url?: string | null
  steps?: unknown
  match?: NetworkJournalQuery | null
  captureBody?: boolean | null
  download?: boolean | null
  stream?: {
    transport?: NetworkStreamTransport | null
    maxMessages?: number | null
    idleMs?: number | null
  } | null
  readySelector?: string | null
  quietMs?: number | null
  maxSettleMs?: number | null
}

export type BrowserSnapshotOptions = BrowserRunOptions & {
  url?: string | null
  objective?: string | null
  mode?: PageSnapshotMode | null
  selector?: string | null
  maxItems?: number | null
  order?: PageSnapshotOrder | null
  readySelector?: string | null
  quietMs?: number | null
  maxSettleMs?: number | null
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

/**
 * Shared browser execution surface for Codex and the legacy Unix-socket API.
 * Operations on one tab are serialized; different tabs can still run in
 * parallel. A timed-out operation remains in the queue until Chromium settles
 * it, preventing the next program from racing a still-running page script.
 */
export class BrowserAgentController {
  private readonly tabOperations = new KeyedOperationQueue()
  private readonly turnOperations = new Map<string, Set<AbortController>>()
  private readonly blockedTurnBrowserWork = new Map<string, BrowserFailure>()
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

  /**
   * Associates an operation with the app-server turn that requested it. The
   * browser remains shared and fully capable; this only prevents stopped work
   * from continuing to mutate or read a page after its owning turn is gone.
   */
  async runForTurn<T>(owner: BrowserOperationOwner, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = turnOperationKey(owner.threadId, owner.turnId)
    const controller = new AbortController()
    const operations = this.turnOperations.get(key) ?? new Set<AbortController>()
    operations.add(controller)
    this.turnOperations.set(key, operations)
    try {
      return await execute(controller.signal)
    } finally {
      operations.delete(controller)
      if (operations.size === 0 && this.turnOperations.get(key) === operations) {
        this.turnOperations.delete(key)
      }
    }
  }

  /**
   * Records that this turn lost its browser target. A later tool call in the
   * same turn must not silently select whatever tab happens to become active.
   */
  blockTurnBrowserWork(owner: BrowserOperationOwner, result: BrowserAgentResult): void {
    if (result.ok || (result.errorCode !== 'targetClosed' && result.errorCode !== 'targetChanged')) return
    const failure = result.failure ?? {
      code: result.errorCode,
      phase: 'targetLifecycle' as const,
      message: result.error ?? 'browser target is no longer available'
    }
    this.blockedTurnBrowserWork.set(turnOperationKey(owner.threadId, owner.turnId), failure)
  }

  /** Returns the terminal browser result for a turn whose target was lost. */
  blockedTurnBrowserResult(owner: BrowserOperationOwner): BrowserAgentResult | null {
    const failure = this.blockedTurnBrowserWork.get(turnOperationKey(owner.threadId, owner.turnId))
    if (!failure) return null
    return {
      ok: false,
      error: `${failure.message}. Browser work for this turn has stopped; start a new user request before using another tab.`,
      errorCode: failure.code,
      failure
    }
  }

  completeTurn(threadId: string, turnId: string): void {
    this.blockedTurnBrowserWork.delete(turnOperationKey(threadId, turnId))
  }

  cancelTurn(threadId: string, turnId: string): void {
    const key = turnOperationKey(threadId, turnId)
    this.blockedTurnBrowserWork.delete(key)
    const operations = this.turnOperations.get(key)
    if (!operations) return
    for (const controller of operations) controller.abort()
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

    const timeoutMs = operationTimeoutMs(options)
    const maxResultChars = operationResultChars(options)

    return this.tabOperations.run(tabId, async () => {
      if (options.signal?.aborted) return cancelledResult()
      const lease = captureTargetLease(tabs, tabId)
      if (!lease) {
        return {
          ok: false,
          error: `no browser target with id ${tabId}`,
          errorCode: 'targetClosed',
          targetState: { targets: tabs.listTargets() }
        } satisfies BrowserAgentFailure
      }

      const { webContents } = lease

      const startedAt = Date.now()
      const execution = executePageProgram(webContents, code, options.frame, maxResultChars)

      try {
        const rawResult = await withTimeout(
          execution,
          timeoutMs,
          () => cdpSessionFor(webContents).terminateExecution(),
          options.signal
        )
        assertTargetLeaseCurrent(tabs, lease)
        const bounded = boundResult(rawResult, maxResultChars)
        const rawMetadata = asRecord(rawResult)
        const nestedTruncated = rawMetadata.truncated === true
        const originalChars = typeof rawMetadata.originalChars === 'number' ? rawMetadata.originalChars : bounded.chars
        let artifact: CdpFileArtifact | undefined
        if (bounded.truncated && this.artifactStore) {
          try {
            artifact = await this.artifactStore.persistBrowserResult(JSON.stringify(rawResult))
          } catch (error) {
            console.warn('Could not persist oversized browser result artifact', error)
          }
        }
        return {
          ok: true,
          result: bounded.value,
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt,
          resultChars: originalChars,
          truncated: bounded.truncated || nestedTruncated,
          ...(artifact ? { artifact } : {})
        } satisfies BrowserAgentSuccess
      } catch (error) {
        const failureFields = browserFailureFields(error, 'pageScriptError', 'pageScript')
        return {
          ok: false,
          ...failureFields,
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt,
          ...(isLifecycleFailure(failureFields.errorCode) ? { targetState: { frames: frameInventory(webContents) } } : {})
        } satisfies BrowserAgentFailure
      }
    })
  }

  /**
   * Execute a declarative main-frame interaction flow. Each step is evaluated
   * in the currently live document, so waits and finds survive full-document
   * and SPA navigation. A find with no matches is successful `not_found` data
   * unless the caller explicitly marks it as required.
   */
  async flow(steps: unknown, options: BrowserFlowOptions = {}): Promise<BrowserAgentResult> {
    const tabs = this.getTabs()
    if (!tabs) {
      return { ok: false, error: 'browser not ready (no window)' } satisfies BrowserAgentFailure
    }
    if (options.tabId === 'all') {
      return { ok: false, error: 'browser.flow requires one existing tab, not "all"' } satisfies BrowserAgentFailure
    }

    const tabId = options.tabId ?? tabs.getActiveTabId()
    if (!tabId) {
      return { ok: false, error: 'no active tab' } satisfies BrowserAgentFailure
    }
    const timeoutMs = operationTimeoutMs(options)
    const maxResultChars = operationResultChars(options)

    return this.tabOperations.run(tabId, async () => {
      if (options.signal?.aborted) return cancelledResult()
      const webContents = tabs.resolveWebContents(tabId)
      if (!webContents) {
        const failure = browserFailureFor(
          operationError('targetClosed', 'targetLifecycle', `no browser target with id ${tabId}`)
        )
        return {
          ok: false,
          error: failure.message,
          errorCode: failure.code,
          failure,
          targetState: { targets: tabs.listTargets() }
        } satisfies BrowserAgentFailure
      }

      const startedAt = Date.now()
      try {
        const rawResult = await withTimeout(
          runBrowserFlow(webContents, steps, { timeoutMs }),
          timeoutMs,
          () => cdpSessionFor(webContents).terminateExecution(),
          options.signal
        )
        const bounded = boundResult(rawResult, maxResultChars)
        let artifact: CdpFileArtifact | undefined
        if (bounded.truncated && this.artifactStore) {
          try {
            artifact = await this.artifactStore.persistBrowserResult(JSON.stringify(rawResult))
          } catch (error) {
            console.warn('Could not persist oversized browser flow result artifact', error)
          }
        }
        return {
          ok: true,
          result: bounded.value,
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt,
          resultChars: bounded.chars,
          truncated: bounded.truncated,
          ...(artifact ? { artifact } : {})
        } satisfies BrowserAgentSuccess
      } catch (error) {
        const failureFields = browserFailureFields(error)
        return {
          ok: false,
          ...failureFields,
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt,
          ...(isLifecycleFailure(failureFields.errorCode)
            ? { targetState: { frames: frameInventory(webContents), targets: tabs.listTargets() } }
            : {})
        } satisfies BrowserAgentFailure
      }
    })
  }

  /**
   * Navigate the visible tab until the requested DOM state is usable. This
   * deliberately uses DOM readiness and a short settle window, never network
   * idleness: modern applications commonly retain background connections long
   * after the requested content is ready.
   */
  async navigate(url: string, options: BrowserNavigateOptions = {}): Promise<BrowserAgentResult> {
    if (!url.trim()) {
      return { ok: false, error: 'browser.navigate requires a non-empty URL or input' } satisfies BrowserAgentFailure
    }

    const tabs = this.getTabs()
    if (!tabs) {
      return { ok: false, error: 'browser not ready (no window)' } satisfies BrowserAgentFailure
    }

    if (options.tabId === 'all') {
      return { ok: false, error: 'browser.navigate requires one existing tab, not "all"' } satisfies BrowserAgentFailure
    }

    const tabId = options.tabId ?? tabs.getActiveTabId()
    if (!tabId) {
      return { ok: false, error: 'no active tab' } satisfies BrowserAgentFailure
    }

    const timeoutMs = operationTimeoutMs(options)
    return this.tabOperations.run(tabId, async () => {
      if (options.signal?.aborted) return cancelledResult()
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
      try {
        const result = await tabs.navigateAndWait(tabId, url, {
          timeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.readySelector?.trim() ? { readySelector: options.readySelector.trim() } : {}),
          ...(options.quietMs === null || options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
          ...(options.maxSettleMs === null || options.maxSettleMs === undefined ? {} : { maxSettleMs: options.maxSettleMs })
        })
        if (options.readySelector?.trim() && result.settleReason !== 'selector-ready') {
          throw operationError(
            'conditionTimeout',
            'navigationReadiness',
            `navigation readiness failed: ${result.settleReason}`
          )
        }
        return {
          ok: true,
          result,
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt,
          resultChars: JSON.stringify(result).length,
          truncated: false
        } satisfies BrowserAgentSuccess
      } catch (error) {
        const failureFields = browserFailureFields(error)
        return {
          ok: false,
          ...failureFields,
          tabId,
          url: safeUrl(webContents),
          title: safeTitle(webContents),
          durationMs: Date.now() - startedAt,
          ...(isLifecycleFailure(failureFields.errorCode) ? { targetState: { frames: frameInventory(webContents) } } : {})
        } satisfies BrowserAgentFailure
      }
    })
  }

  /**
   * Optionally navigate one existing tab and produce a compact, objective-aware
   * page snapshot in a single queued operation. This is the ordinary fast path
   * for read-only browser tasks: one model round, one composed-tree traversal,
   * and structured state evidence instead of a full DOM serialization.
   */
  async snapshot(options: BrowserSnapshotOptions = {}): Promise<BrowserAgentResult> {
    const tabs = this.getTabs()
    if (!tabs) {
      return { ok: false, error: 'browser not ready (no window)' } satisfies BrowserAgentFailure
    }
    if (options.tabId === 'all') {
      return { ok: false, error: 'browser.snapshot requires one existing tab, not "all"' } satisfies BrowserAgentFailure
    }

    const tabId = options.tabId ?? tabs.getActiveTabId()
    if (!tabId) {
      return { ok: false, error: 'no active tab' } satisfies BrowserAgentFailure
    }
    const requestedUrl = options.url?.trim() ?? ''
    const timeoutMs = operationTimeoutMs(options)
    const maxResultChars = operationResultChars(options)
    const program = buildPageSnapshotProgram({
      objective: options.objective,
      mode: options.mode,
      selector: options.selector,
      maxItems: options.maxItems,
      order: options.order,
      maxChars: maxResultChars
    })

    return this.tabOperations.run(tabId, async () => {
      if (options.signal?.aborted) return cancelledResult()
      let lease = captureTargetLease(tabs, tabId)
      if (!lease) {
        return {
          ok: false,
          error: `no browser target with id ${tabId}`,
          errorCode: 'targetClosed',
          targetState: { targets: tabs.listTargets() }
        } satisfies BrowserAgentFailure
      }

      let webContents = lease.webContents
      let readiness: BrowserAgentResult['readiness']

      const startedAt = Date.now()
      try {
        if (requestedUrl) {
          const navigation = await tabs.navigateAndWait(tabId, requestedUrl, {
            timeoutMs,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.readySelector?.trim() ? { readySelector: options.readySelector.trim() } : {}),
            ...(options.quietMs === null || options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
            ...(options.maxSettleMs === null || options.maxSettleMs === undefined ? {} : { maxSettleMs: options.maxSettleMs })
          })
          const readySelector = options.readySelector?.trim()
          if (readySelector) {
            readiness = {
              selector: readySelector,
              settleReason: navigation.settleReason,
              matched: navigation.settleReason === 'selector-ready'
            }
          }
          lease = captureTargetLease(tabs, tabId)
          if (!lease) {
            throw operationError('targetClosed', 'targetLifecycle', `browser target ${tabId} closed during navigation`)
          }
          webContents = lease.webContents
        }

        const targetContents = webContents
        const remainingMs = Math.max(250, timeoutMs - (Date.now() - startedAt))
        let rawResult = await withTimeout(
          executePageProgram(targetContents, program, options.frame, maxResultChars),
          remainingMs,
          () => cdpSessionFor(targetContents).terminateExecution(),
          options.signal
        )
        assertTargetLeaseCurrent(tabs, lease)
        let assessment = assessBrowserExtractionResult(rawResult)
        // Hydrated applications can expose a small, plausible loading shell at
        // DOM-ready. Retry once only for that recognizable state, waiting on
        // mutations instead of adding delay to ordinary completed pages.
        if (!assessment.verified && isLikelyLoadingSnapshot(rawResult)) {
          const retryBudgetMs = Math.min(1_500, Math.max(250, timeoutMs - (Date.now() - startedAt)))
          const contentReady = await withTimeout(
            waitForSnapshotContent(targetContents, retryBudgetMs),
            retryBudgetMs,
            () => cdpSessionFor(targetContents).terminateExecution(),
            options.signal
          )
          assertTargetLeaseCurrent(tabs, lease)
          if (contentReady) {
            const remainingRetryMs = Math.max(250, timeoutMs - (Date.now() - startedAt))
            rawResult = await withTimeout(
              executePageProgram(targetContents, program, options.frame, maxResultChars),
              remainingRetryMs,
              () => cdpSessionFor(targetContents).terminateExecution(),
              options.signal
            )
            assertTargetLeaseCurrent(tabs, lease)
            assessment = assessBrowserExtractionResult(rawResult)
          }
        }
        const bounded = boundResult(rawResult, maxResultChars)
        const rawMetadata = asRecord(rawResult)
        const nestedTruncated = rawMetadata.truncated === true
        if (!assessment.verified) {
          const reason = assessment.reason ?? 'unknown'
          const code: BrowserFailureCode = reason.startsWith('invalid selector:')
            ? 'invalidSelector'
            : reason === 'selector-not-found'
              ? 'selectorNotFound'
              : 'conditionNotMet'
          const failure: BrowserFailure = {
            code,
            phase: 'snapshotVerification',
            message: `page snapshot verification failed: ${reason}`
          }
          return {
            ok: false,
            result: bounded.value,
            error: failure.message,
            errorCode: failure.code,
            failure,
            tabId,
            url: safeUrl(targetContents),
            title: safeTitle(targetContents),
            durationMs: Date.now() - startedAt,
            resultChars: bounded.chars,
            truncated: bounded.truncated || nestedTruncated,
            completion: snapshotCompletion(rawResult, bounded.truncated || nestedTruncated),
            ...(readiness ? { readiness } : {})
          } satisfies BrowserAgentFailure
        }

        let artifact: CdpFileArtifact | undefined
        if (bounded.truncated && this.artifactStore) {
          try {
            artifact = await this.artifactStore.persistBrowserResult(JSON.stringify(rawResult))
          } catch (error) {
            console.warn('Could not persist oversized browser snapshot artifact', error)
          }
        }
        return {
          ok: true,
          result: bounded.value,
          tabId,
          url: safeUrl(targetContents),
          title: safeTitle(targetContents),
          durationMs: Date.now() - startedAt,
          resultChars: bounded.chars,
          truncated: bounded.truncated || nestedTruncated,
          completion: snapshotCompletion(rawResult, bounded.truncated || nestedTruncated),
          ...(readiness ? { readiness } : {}),
          ...(artifact ? { artifact } : {})
        } satisfies BrowserAgentSuccess
      } catch (error) {
        const failureFields = browserFailureFields(error, 'pageScriptError', 'pageScript')
        const failureContents = webContents ?? tabs.resolveWebContents(tabId)
        return {
          ok: false,
          ...failureFields,
          tabId,
          url: failureContents ? safeUrl(failureContents) : '',
          title: failureContents ? safeTitle(failureContents) : '',
          durationMs: Date.now() - startedAt,
          ...(isLifecycleFailure(failureFields.errorCode) && failureContents
            ? { targetState: { frames: frameInventory(failureContents) } }
            : {})
        } satisfies BrowserAgentFailure
      }
    })
  }

  private async runAcrossTargets(code: string, options: BrowserRunOptions): Promise<BrowserAgentResult> {
    const targets = this.listTargets()
    if (targets.length === 0) {
      return { ok: false, error: 'no browser targets are available' } satisfies BrowserAgentFailure
    }
    const startedAt = Date.now()
    const maxResultChars = operationResultChars(options)
    const perTargetBudget = fanoutItemBudget(maxResultChars, targets.length, 700)
    const results = await mapWithConcurrency(targets, MAX_PARALLEL_BROWSER_TARGETS, async (target) => {
      const result = await this.run(code, { ...options, tabId: target.id, maxResultChars: perTargetBudget })
      return {
        target,
        ok: result.ok,
        ...(result.ok
          ? { result: result.result, resultChars: result.resultChars ?? 0 }
          : { error: result.error, errorCode: result.errorCode, failure: result.failure }),
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

    return this.runCdpOperation({
      ...options,
      requireStableTarget: options.requireStableTarget ?? isObservationalCdpMethod(method)
    }, async (session, timeoutMs, context) => {
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

    return this.runCdpOperation({ ...options, requireStableTarget: true }, async (_session, timeoutMs, context) => {
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

  async captureAppScreenshot(options: BrowserAgentOptions = {}): Promise<BrowserAgentResult> {
    const artifactStore = this.artifactStore
    if (!artifactStore) {
      return { ok: false, error: 'screenshot artifact storage is not available' } satisfies BrowserAgentFailure
    }

    const tabs = this.getTabs()
    if (!tabs) {
      return { ok: false, error: 'browser not ready (no window)' } satisfies BrowserAgentFailure
    }

    const timeoutMs = operationTimeoutMs(options)
    if (options.signal?.aborted) return cancelledResult()

    try {
      const window = tabs.getWindow()
      const browser = tabs.getVisibleBrowserCaptureTarget()
      const image = await captureAppWindowImage({ window, browser }, timeoutMs)
      const buffer = image.toPNG()
      const screenshot = await artifactStore.persistScreenshot(buffer.toString('base64'), 'png')
      const [contentWidth, contentHeight] = window.getContentSize()
      return {
        ok: true,
        result: {
          screenshot: {
            ...screenshot,
            scope: 'appWindow',
            contentWidth,
            contentHeight,
            browserVisible: Boolean(browser),
            ...(browser ? { tabId: tabs.getActiveTabId(), bounds: browser.bounds } : {})
          }
        }
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      } satisfies BrowserAgentFailure
    }
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

    // Passive waits deliberately do not occupy the per-tab mutation queue.
    // This lets a wait and the navigation/action that will satisfy it be issued
    // together without the action sitting behind its own waiter until timeout.
    const tabs = this.getTabs()
    const tabId = options.tabId ?? tabs?.getActiveTabId()
    if (!tabs || !tabId) {
      return { ok: false, error: tabs ? 'no active tab' : 'browser not ready (no window)' } satisfies BrowserAgentFailure
    }
    const lease = captureTargetLease(tabs, tabId)
    if (!lease) {
      return { ok: false, error: `no tab with id ${tabId}` } satisfies BrowserAgentFailure
    }
    const { webContents } = lease
    const timeoutMs = operationTimeoutMs(options)
    const maxResultChars = operationResultChars(options)
    const startedAt = Date.now()
    try {
      if (options.signal?.aborted) return cancelledResult()
      const session = cdpSessionFor(webContents)
      await session.prepareForEvent(method)
      const rawResult = await withTimeout(
        session.waitForEvent(toEventQuery(options, method), timeoutMs),
        timeoutMs,
        undefined,
        options.signal
      )
      assertTargetLeaseCurrent(tabs, lease)
      return createBoundedSuccessResult(rawResult, maxResultChars, { tabId, webContents, startedAt })
    } catch (error) {
      return createFailureResult(error, { tabId, webContents, startedAt })
    }
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
    return this.runCdpOperation({ ...options, requireStableTarget: true }, async (session, timeoutMs, context) => {
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

  async captureNetwork(
    params: BrowserNetworkCaptureParams,
    options: BrowserAgentOptions = {}
  ): Promise<BrowserAgentResult> {
    const requestedUrl = params.url?.trim() ?? ''
    const hasSteps = Array.isArray(params.steps) && params.steps.length > 0
    if (Boolean(requestedUrl) === hasSteps) {
      return { ok: false, error: 'browser_network requires exactly one trigger: "url" or non-empty "steps"' } satisfies BrowserAgentFailure
    }
    const match = params.match ?? {}
    if (!match.urlContains?.trim()) {
      return { ok: false, error: 'browser_network requires match.urlContains' } satisfies BrowserAgentFailure
    }
    const streamTransport = params.stream?.transport
    if (params.stream && streamTransport !== 'sse' && streamTransport !== 'websocket') {
      return { ok: false, error: 'browser_network stream.transport must be "sse" or "websocket"' } satisfies BrowserAgentFailure
    }
    if (streamTransport === 'websocket' && (match.method || match.resourceType || match.mimeType)) {
      return { ok: false, error: 'browser_network WebSocket matching supports urlContains and optional status bounds, not HTTP method/resourceType/mimeType' } satisfies BrowserAgentFailure
    }
    if (params.stream && params.captureBody === true) {
      return { ok: false, error: 'browser_network cannot combine stream capture with captureBody: true' } satisfies BrowserAgentFailure
    }
    if (params.download && params.stream) {
      return { ok: false, error: 'browser_network cannot combine download and stream capture' } satisfies BrowserAgentFailure
    }
    if (params.download && params.captureBody === true) {
      return { ok: false, error: 'browser_network cannot combine download capture with captureBody: true' } satisfies BrowserAgentFailure
    }
    const captureBody = !params.stream && !params.download && params.captureBody !== false
    const artifactStore = this.artifactStore
    if ((captureBody || params.stream || params.download) && !artifactStore) {
      return { ok: false, error: 'network artifact storage is not available' } satisfies BrowserAgentFailure
    }

    const tabs = this.getTabs()
    if (!tabs) return { ok: false, error: 'browser not ready (no window)' } satisfies BrowserAgentFailure
    if (options.tabId === 'all') {
      return { ok: false, error: 'browser_network requires one existing tab, not "all"' } satisfies BrowserAgentFailure
    }
    const tabId = options.tabId ?? tabs.getActiveTabId()
    if (!tabId) return { ok: false, error: 'no active tab' } satisfies BrowserAgentFailure

    const timeoutMs = operationTimeoutMs(options)
    const maxResultChars = operationResultChars(options)
    return this.tabOperations.run(tabId, async () => {
      if (options.signal?.aborted) return cancelledResult()
      const lease = captureTargetLease(tabs, tabId)
      if (!lease) {
        return { ok: false, error: `no tab with id ${tabId}`, errorCode: 'targetClosed' } satisfies BrowserAgentFailure
      }
      const { webContents } = lease
      const session = cdpSessionFor(webContents)
      const captureController = new AbortController()
      const startedAt = Date.now()

      const executeCapture = async (): Promise<unknown> => {
        await session.startNetworkJournal()
        try {
          const normalizedMatch = { ...match, urlContains: match.urlContains?.trim() }
          const preparedDownload = params.download && artifactStore
            ? await browserDownloadCaptureBroker.prepareDownload(
                webContents,
                normalizedMatch.urlContains ?? '',
                artifactStore,
                timeoutMs,
                captureController.signal
              )
            : null
          const waiting = (preparedDownload
            ? preparedDownload.capture.then((download) => ({ kind: 'download' as const, download }))
            : streamTransport
              ? session.waitForNetworkStream(
                streamTransport,
                normalizedMatch,
                clampNumber(params.stream?.maxMessages, 50, 1, 1_000),
                clampNumber(params.stream?.idleMs, 500, 50, 10_000),
                timeoutMs,
                captureController.signal
              ).then((stream) => ({ kind: 'stream' as const, stream }))
              : session.waitForNetworkRequest(
                { ...normalizedMatch, completedOnly: true },
                timeoutMs,
                captureController.signal
              ).then((request) => ({ kind: 'request' as const, request })))
          .then(
            (capture) => ({ ok: true as const, capture }),
            (error) => ({ ok: false as const, error })
          )

          let actionResult: unknown
          try {
            actionResult = requestedUrl
              ? await tabs.navigateAndWait(tabId, requestedUrl, {
                  timeoutMs,
                  signal: captureController.signal,
                  ...(params.readySelector?.trim() ? { readySelector: params.readySelector.trim() } : {}),
                  ...(params.quietMs === null || params.quietMs === undefined ? {} : { quietMs: params.quietMs }),
                  ...(params.maxSettleMs === null || params.maxSettleMs === undefined ? {} : { maxSettleMs: params.maxSettleMs })
                })
              : await runBrowserFlow(webContents, params.steps, { timeoutMs })
          } catch (error) {
            captureController.abort()
            await waiting
            throw error
          }

          const matched = await waiting
          if (!matched.ok) throw matched.error
          let responseBody: Record<string, unknown> | undefined
          let streamCapture: Record<string, unknown> | undefined
          let downloadCapture: Record<string, unknown> | undefined
          let request: unknown
          if (matched.capture.kind === 'request') {
            request = matched.capture.request
            if (matched.capture.request.failed) {
              throw new Error(`matched network request failed: ${matched.capture.request.errorText ?? matched.capture.request.blockedReason ?? matched.capture.request.url}`)
            }
          }
          if (captureBody && artifactStore && matched.capture.kind === 'request') {
            const capturedRequest = matched.capture.request
            const response = asRecord(await session.send('Network.getResponseBody', { requestId: capturedRequest.requestId }))
            if (typeof response.body !== 'string') throw new Error('Network.getResponseBody returned no body')
            responseBody = await artifactStore.persistResponseBody(
              response.body,
              response.base64Encoded === true,
              capturedRequest.mimeType,
              capturedRequest.url
            )
          }
          if (artifactStore && matched.capture.kind === 'stream') {
            const { messages, ...summary } = matched.capture.stream
            const serialized = [
              JSON.stringify({ type: 'network-stream', ...summary }),
              ...messages.map((message) => JSON.stringify({ type: 'message', ...message }))
            ].join('\n')
            const artifact = await artifactStore.persistNetworkStream(`${serialized}\n`)
            streamCapture = {
              ...summary,
              artifact,
              messages: messages.slice(0, 10),
              omittedMessages: Math.max(0, messages.length - 10)
            }
          }
          if (matched.capture.kind === 'download') {
            downloadCapture = matched.capture.download
          }

          return {
            network: {
              trigger: requestedUrl ? 'navigate' : 'flow',
              ...(request ? { request } : {}),
              ...(responseBody ? { responseBody } : {}),
              ...(streamCapture ? { stream: streamCapture } : {}),
              ...(downloadCapture ? { download: downloadCapture } : {}),
              action: boundResult(actionResult, Math.min(3_000, Math.max(1_000, Math.floor(maxResultChars / 2)))).value
            }
          }
        } finally {
          session.stopNetworkJournal()
        }
      }

      try {
        const rawResult = await withTimeout(
          executeCapture(),
          timeoutMs,
          () => {
            captureController.abort()
            session.terminateExecution()
          },
          options.signal
        )
        assertTargetLeaseCurrent(tabs, lease)
        captureController.abort()
        return createBoundedSuccessResult(rawResult, maxResultChars, { tabId, webContents, startedAt })
      } catch (error) {
        captureController.abort()
        return createFailureResult(error, { tabId, webContents, startedAt })
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

    const timeoutMs = operationTimeoutMs(options)
    const maxResultChars = operationResultChars(options)
    return this.tabOperations.run(tabId, async (): Promise<BrowserAgentResult> => {
      if (options.signal?.aborted) return cancelledResult()
      const lease = options.requireStableTarget ? captureTargetLease(tabs, tabId) : null
      const webContents = lease?.webContents ?? tabs.resolveWebContents(tabId)
      if (!webContents) {
        return { ok: false, error: `no tab with id ${tabId}` } satisfies BrowserAgentFailure
      }

      const startedAt = Date.now()
      try {
        const context = { tabId, url: safeUrl(webContents), title: safeTitle(webContents), webContents }
        const session = cdpSessionFor(webContents)
        const rawResult = await withTimeout(
          execute(session, timeoutMs, context),
          timeoutMs,
          () => session.terminateExecution(),
          options.signal
        )
        if (lease) assertTargetLeaseCurrent(tabs, lease)
        return createBoundedSuccessResult(rawResult, maxResultChars, { tabId, webContents, startedAt })
      } catch (error) {
        return createFailureResult(error, { tabId, webContents, startedAt })
      }
    })
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

  async extractPage(options: BrowserSnapshotOptions = {}): Promise<BrowserAgentResult> {
    return this.snapshot({ ...options, mode: options.mode ?? 'content' })
  }
}

export function assessBrowserExtractionResult(value: unknown): { verified: boolean; reason?: string } {
  return assessBrowserExtractionValue(value, 0)
}

function assessBrowserExtractionValue(value: unknown, depth: number): { verified: boolean; reason?: string } {
  if (depth > 3) return { verified: false, reason: 'invalid extraction envelope' }
  const page = asRecord(value)
  if (Array.isArray(page.items) && typeof page.content === 'string') {
    const metadata = asRecord(page.page)
    const scope = asRecord(page.scope)
    if (typeof scope.selector === 'string' && scope.selector && scope.matched !== true) {
      return { verified: false, reason: typeof scope.error === 'string' ? scope.error : 'selector-not-found' }
    }
    const title = typeof metadata.title === 'string' ? metadata.title : ''
    const url = typeof metadata.url === 'string' ? metadata.url : ''
    const content = page.content
    const meaningfulItems = page.items.filter((item) => {
      const record = asRecord(item)
      return [record.text, record.name, record.href].some((field) => typeof field === 'string' && field.trim().length > 0)
    })
    const itemEvidence = meaningfulItems.map((item) => {
      const record = asRecord(item)
      return `${String(record.text ?? '')} ${String(record.name ?? '')}`
    }).join(' ')
    const coverage = asRecord(page.coverage)
    const objectiveTerms = Array.isArray(coverage.objectiveTerms)
      ? coverage.objectiveTerms.filter((term): term is string => typeof term === 'string')
      : []
    const contentAssessment = assessExtractedPage({
      title,
      url,
      content,
      wordCount: content.trim() ? content.trim().split(/\s+/).length : 0
    })
    if (page.mode === 'content') return contentAssessment
    const taskWallText = `${title} ${itemEvidence} ${meaningfulItems.length === 0 ? content : ''}`
    if (/\b(?:just a moment|checking your browser|verify you are human|access denied|captcha)\b/i.test(taskWallText)) {
      return { verified: false, reason: 'challenge-page' }
    }
    const explicitlyRequestsAuth = objectiveTerms.some((term) => /^(?:auth|authenticate|authentication|login|signin|sign)$/.test(term))
    const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const loginShell = /^(?:log[ -]?in|sign[ -]?in|login|authentication required|session expired)\b/.test(normalizedTitle) ||
      /\/(?:login|log-in|signin|sign-in|auth)(?:[/?#]|$)/i.test(url)
    if (!explicitlyRequestsAuth && loginShell) return { verified: false, reason: 'login-wall' }
    if (meaningfulItems.length > 0) {
      if (objectiveTerms.length > 0 && coverage.complete !== true) {
        const gaps = Array.isArray(coverage.gaps)
          ? coverage.gaps.filter((gap): gap is string => typeof gap === 'string').slice(0, 4)
          : []
        const structuralGap = gaps.find((gap) => /^(?:item-count-missing:|read-state-mismatch:|traversal-truncated$|result-budget$)/.test(gap))
        if (structuralGap) return { verified: false, reason: `coverage-incomplete:${structuralGap}` }
      }
      return { verified: true }
    }
    return contentAssessment
  }
  if (typeof page.content === 'string' || typeof page.url === 'string') {
    return assessExtractedPage({
      title: typeof page.title === 'string' ? page.title : '',
      url: typeof page.url === 'string' ? page.url : '',
      content: typeof page.content === 'string' ? page.content : '',
      wordCount: typeof page.wordCount === 'number' ? page.wordCount : 0,
      status: typeof page.status === 'number' ? page.status : undefined
    })
  }

  if ('result' in page) {
    const nested = assessBrowserExtractionValue(page.result, depth + 1)
    if (nested.verified) return nested
  }
  for (const key of ['frames', 'targets']) {
    const entries = page[key]
    if (!Array.isArray(entries)) continue
    let lastReason = 'no verified extraction result'
    for (const entry of entries) {
      const record = asRecord(entry)
      if (record.ok === false) continue
      const nested = assessBrowserExtractionValue(record.result, depth + 1)
      if (nested.verified) return nested
      if (nested.reason) lastReason = nested.reason
    }
    return { verified: false, reason: lastReason }
  }
  return { verified: false, reason: 'invalid extraction envelope' }
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
  const title = document.title.trim().slice(0, 300);
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
  const wrapped = buildWrappedPageProgram(code)
  const selector = frameSelector?.trim()
  if (!selector || selector === 'main') {
    return requirePageProgramResult(unwrapPageProgramResult(await executePageJavaScript(webContents, wrapped, true)))
  }

  const mainFrame = webContents.mainFrame
  const frames = liveFrames(mainFrame)
  if (selector === 'all') {
    const perFrameBudget = fanoutItemBudget(maxResultChars, frames.length, 550)
    const results = await mapWithConcurrency(frames, MAX_PARALLEL_BROWSER_FRAMES, async (frame) => {
      const descriptor = describeFrame(frame, mainFrame)
      try {
        const result = requirePageProgramResult(unwrapPageProgramResult(await executePageJavaScript(frame, wrapped, true)))
        const bounded = boundResult(result, perFrameBudget)
        return {
          frame: descriptor,
          ok: true,
          result: bounded.value,
          resultChars: bounded.chars,
          truncated: bounded.truncated
        }
      } catch (error) {
        const failure = browserFailureFor(error, 'pageScriptError', 'pageScript')
        return {
          frame: descriptor,
          ok: false,
          error: failure.message,
          errorCode: failure.code,
          failure,
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
    result: requirePageProgramResult(unwrapPageProgramResult(await executePageJavaScript(frame, wrapped, true)))
  }
}

const PAGE_PROGRAM_ENVELOPE_KEY = '__codexBrowserRunV1'
const PAGE_SIGNAL_CODES = new Set<BrowserFailureCode>([
  'conditionNotMet',
  'conditionTimeout',
  'selectorNotFound',
  'invalidSelector'
])

function buildWrappedPageProgram(code: string): string {
  return `(async () => {
    const normalizeError = (error) => {
      const safeRead = (read, fallback = '') => { try { return read(); } catch { return fallback; } };
      const rawMessage = safeRead(() => error && typeof error.message === 'string' ? error.message : '');
      const fallbackMessage = safeRead(() => typeof error === 'string' ? error : String(error), 'unknown page script error');
      const name = safeRead(() => error && typeof error.name === 'string' ? error.name : typeof error, 'Error');
      const stack = safeRead(() => error && typeof error.stack === 'string' ? error.stack : '', '');
      const code = safeRead(() => error && typeof error.codexBrowserFailureCode === 'string' ? error.codexBrowserFailureCode : '', '');
      return {
        name: String(name || 'Error').slice(0, 120),
        message: String(rawMessage || fallbackMessage || 'unknown page script error').slice(0, 2000),
        ...(stack ? { stack: String(stack).slice(0, 4000) } : {}),
        ...(code ? { code: String(code).slice(0, 80) } : {})
      };
    };
    try {
      const value = await (async () => { ${code}\n})();
      return { ${PAGE_PROGRAM_ENVELOPE_KEY}: true, ok: true, value };
    } catch (error) {
      return { ${PAGE_PROGRAM_ENVELOPE_KEY}: true, ok: false, error: normalizeError(error) };
    }
  })()`
}

function unwrapPageProgramResult(value: unknown): unknown {
  const envelope = asRecord(value)
  if (envelope[PAGE_PROGRAM_ENVELOPE_KEY] !== true) return value
  if (envelope.ok === true) return envelope.value

  const pageError = asRecord(envelope.error)
  const message = typeof pageError.message === 'string' && pageError.message
    ? pageError.message
    : 'page script failed'
  const requestedCode = typeof pageError.code === 'string' ? pageError.code as BrowserFailureCode : undefined
  const code = requestedCode && PAGE_SIGNAL_CODES.has(requestedCode) ? requestedCode : 'pageScriptError'
  throw operationError(code, 'pageScript', message, {
    ...(typeof pageError.name === 'string' && pageError.name ? { name: pageError.name } : {}),
    ...(typeof pageError.stack === 'string' && pageError.stack ? { stack: pageError.stack } : {})
  })
}

function requirePageProgramResult(value: unknown): unknown {
  if (value !== undefined) return value
  throw operationError(
    'noResult',
    'pageScript',
    'browser_run completed without a result; return the value explicitly from the top-level program'
  )
}

function turnOperationKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`
}

function snapshotCompletion(value: unknown, truncated: boolean): BrowserSnapshotCompletion {
  const snapshot = asRecord(value)
  const coverage = asRecord(snapshot.coverage)
  const gaps = Array.isArray(coverage.gaps)
    ? coverage.gaps.filter((gap): gap is string => typeof gap === 'string' && gap.trim().length > 0).slice(0, 12)
    : []

  if (!truncated && coverage.complete === true) {
    return {
      status: 'complete',
      nextAction: 'answer',
      reason: 'requested snapshot coverage is complete',
      gaps: []
    }
  }

  const unresolved = truncated && !gaps.includes('result-truncated')
    ? [...gaps, 'result-truncated']
    : gaps
  return {
    status: 'incomplete',
    nextAction: 'targeted-gap-fill',
    reason: unresolved.length > 0
      ? 'snapshot has named evidence gaps'
      : 'snapshot coverage is not complete',
    gaps: unresolved
  }
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
    method: typeof params.method === 'string' ? params.method : null,
    resourceType: typeof params.resourceType === 'string' ? params.resourceType : null,
    mimeType: typeof params.mimeType === 'string' ? params.mimeType : null,
    statusMin: typeof params.statusMin === 'number' ? params.statusMin : null,
    statusMax: typeof params.statusMax === 'number' ? params.statusMax : null,
    failedOnly: params.failedOnly === true,
    completedOnly: params.completedOnly === true
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isUnsupportedCdpCommand(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /wasn't found|method not found|not supported/i.test(message)
}

function isObservationalCdpMethod(method: string): boolean {
  return /^(?:Page\.captureScreenshot|DOMSnapshot\.captureSnapshot|Accessibility\.get|(?:Browser|DOM|Network|Performance|Target)\.get)/.test(method)
}

function clampNumber(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function operationTimeoutMs(options: BrowserAgentOptions): number {
  return clampNumber(options.timeoutMs, DEFAULT_BROWSER_TIMEOUT_MS, 250, MAX_BROWSER_TIMEOUT_MS)
}

function operationResultChars(options: BrowserAgentOptions): number {
  return clampNumber(options.maxResultChars, DEFAULT_BROWSER_RESULT_CHARS, 1_000, MAX_BROWSER_RESULT_CHARS)
}

function isLikelyLoadingSnapshot(value: unknown): boolean {
  const result = asRecord(value)
  const page = asRecord(result.page)
  const text = `${String(page.title ?? '')}\n${String(result.content ?? '')}`.trim().toLowerCase()
  return /^(?:loading(?:\.{1,3})?|please wait(?:\.{1,3})?|fetching|initializing|preparing|content is loading|skeleton|shimmer)/.test(text)
}

function waitForSnapshotContent(webContents: WebContents, maxWaitMs: number): Promise<boolean> {
  const maxWait = Math.max(100, Math.min(1_500, Math.round(maxWaitMs)))
  return executePageJavaScript(webContents, `new Promise((resolve) => {
    const startedAt = performance.now();
    let observer;
    let timer;
    let finished = false;
    const finish = (ready) => {
      if (finished) return;
      finished = true;
      observer?.disconnect();
      clearInterval(timer);
      resolve(ready);
    };
    const loadingShell = (value) => /^(?:loading(?:\\.{1,3})?|please wait(?:\\.{1,3})?|fetching|initializing|preparing|content is loading|skeleton|shimmer)/i.test(value.trim());
    const useful = () => {
      const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
      const busy = document.querySelector('[aria-busy="true"], [role="progressbar"], [data-loading="true"]');
      return text.length >= 240 && !loadingShell(text) && !busy;
    };
    const tick = () => {
      if (useful()) return finish(true);
      if (performance.now() - startedAt >= ${maxWait}) finish(false);
    };
    observer = new MutationObserver(tick);
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    timer = setInterval(tick, 50);
    tick();
  })`) as Promise<boolean>
}
