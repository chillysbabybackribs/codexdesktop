import { app, WebContentsView } from 'electron'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResearchProgress } from '../../shared/ipc.js'
import { browserPartition, chromeLikeUserAgent } from './browser-session.js'
import { buildPageExtractionProgram } from './browser-agent.js'
import { collectWithConcurrencyUntil, KeyedTaskScheduler } from './research-execution.js'
import { loadPageAndSettle, type PageNavigationResult } from './page-navigation.js'
import {
  assessExtractedPage,
  buildResearchQueryVariants,
  buildSerpExtractionProgram,
  googleSearchUrl,
  rankSerpCandidates,
  type RankedSerpCandidate,
  type SerpCandidate
} from './research-utils.js'
import type { TabManager } from './tab-manager.js'

const DEFAULT_MAX_RESULTS = 5
const MAX_MAX_RESULTS = 10
const DEFAULT_TARGET_PAGES = 3
const MAX_TARGET_PAGES = 3
const DEFAULT_MAX_ATTEMPTS = 6
const MAX_MAX_ATTEMPTS = 8
const DEFAULT_SNIPPET_CHARS = 3_500
const MAX_SNIPPET_CHARS = 8_000
const PAGE_TIMEOUT_MS = 15_000
const PAGE_WORKER_CONCURRENCY = 2
const MAX_CONCURRENT_RESEARCH_RUNS = 2
const MAX_HTML_CHARS = 2_000_000
const SEARCH_CACHE_TTL_MS = 10 * 60_000
const RESEARCH_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const RESEARCH_MAX_BYTES = 250 * 1024 * 1024

export type ResearchRequest = {
  queries: string[]
  maxResults?: number | null
  maxPages?: number | null
  maxAttempts?: number | null
  snippetChars?: number | null
}

export type ResearchPage = {
  rank: number
  url: string
  title: string
  wordCount: number
  artifactPath: string
  htmlPath: string
  visibleTabId?: string
  sourceQuery?: string
  sourceTier?: string
  score?: number
  verified: true
}

export type ResearchMetrics = {
  queueMs: number
  setupMs: number
  discoveryMs: number
  pageMs: number
  finalizationMs: number
  executionMs: number
  totalMs: number
  targetPages: number
  maxAttempts: number
  queriesAttempted: number
  pagesAttempted: number
  pagesVerified: number
  targetMet: boolean
  navigation: {
    count: number
    domReadyMs: number
    settleMs: number
    settleReasons: Record<string, number>
  }
}

export type ResearchResult = {
  ok: boolean
  researchId?: string
  queries?: string[]
  searchQueries?: string[]
  artifactDir?: string
  pages?: ResearchPage[]
  discoveredUrls?: string[]
  discoveredCount?: number
  visibleTabId?: string
  metrics?: ResearchMetrics
  errors?: Array<{ url?: string; error: string }>
  error?: string
}

export type ResearchRunContext = {
  runId?: string
  threadId?: string
  turnId?: string
  onProgress?: (progress: ResearchProgress) => void
}

type ResearchPageDraft = {
  rank: number
  candidate: RankedSerpCandidate
  title: string
  url: string
  content: string
  wordCount: number
  html: string
}

type ActiveResearchRun = {
  turnId: string
  controller: AbortController
}

type NavigationMetrics = ResearchMetrics['navigation']

/**
 * A compact, adaptive research pipeline. Work is serialized per thread with a
 * small global concurrency bound. Source lanes and page candidates stop as soon
 * as the verified-page target is satisfied.
 */
export class ResearchRunner {
  private readonly searchViews = new Set<WebContentsView>()
  private readonly activeRuns = new Map<string, ActiveResearchRun>()
  private readonly searchCache = new Map<string, { expiresAt: number; candidates: Array<Omit<SerpCandidate, 'query'>> }>()
  private readonly scheduler = new KeyedTaskScheduler(MAX_CONCURRENT_RESEARCH_RUNS)
  private stagingTabId: string | null = null

  constructor(private readonly getTabs: () => TabManager | null) {}

  run(request: ResearchRequest, context: ResearchRunContext = {}): Promise<ResearchResult> {
    const runId = context.runId ?? crypto.randomUUID()
    const turnId = context.turnId ?? runId
    const queueKey = context.threadId ?? turnId
    const controller = new AbortController()
    this.activeRuns.set(runId, { turnId, controller })
    notifyProgress(context.onProgress, {
      stage: 'queued',
      message: 'Queued for web research…'
    })

    const operation = this.scheduler.run(queueKey, async (queueMs) => {
      throwIfAborted(controller.signal)
      return this.execute(request, controller.signal, queueMs, context.onProgress)
    })

    return operation.finally(() => {
      if (this.activeRuns.get(runId)?.controller === controller) this.activeRuns.delete(runId)
    })
  }

  cancel(runIdOrTurnId: string): void {
    for (const [runId, active] of this.activeRuns) {
      if (runId === runIdOrTurnId || active.turnId === runIdOrTurnId) {
        active.controller.abort()
      }
    }
  }

  dispose(): void {
    for (const active of this.activeRuns.values()) active.controller.abort()
    this.activeRuns.clear()
    for (const view of this.searchViews) {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    this.searchViews.clear()
  }

  private async execute(
    request: ResearchRequest,
    signal: AbortSignal,
    queueMs: number,
    onProgress?: (progress: ResearchProgress) => void
  ): Promise<ResearchResult> {
    const queries = request.queries
      .filter((query): query is string => typeof query === 'string' && query.trim().length > 0)
      .map((query) => query.trim())
      .slice(0, 3)

    if (queries.length === 0) {
      return { ok: false, error: 'research_web requires at least one non-empty query' }
    }

    const executionStartedAt = Date.now()
    const maxResults = clamp(request.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_MAX_RESULTS)
    const targetPages = clamp(request.maxPages, DEFAULT_TARGET_PAGES, 1, MAX_TARGET_PAGES)
    const maxAttempts = clamp(request.maxAttempts, DEFAULT_MAX_ATTEMPTS, targetPages, MAX_MAX_ATTEMPTS)
    const snippetChars = clamp(request.snippetChars, DEFAULT_SNIPPET_CHARS, 1_000, MAX_SNIPPET_CHARS)
    const researchId = crypto.randomUUID()
    const artifactDir = join(app.getPath('userData'), 'research', researchId)
    const navigation = createNavigationMetrics()
    let setupMs = 0
    let discoveryMs = 0
    let pageMs = 0

    notifyProgress(onProgress, {
      stage: 'preparing',
      message: queueMs >= 100 ? `Starting research after ${formatDuration(queueMs)} queued…` : 'Preparing research artifacts…',
      targetPages
    })
    const setupStartedAt = Date.now()
    await pruneResearchArtifacts(join(app.getPath('userData'), 'research'))
    await mkdir(artifactDir, { recursive: true })
    setupMs = Date.now() - setupStartedAt

    const plannedQueries = buildResearchQueryVariants(queries)
    const searchQueries: string[] = []
    const discovered: SerpCandidate[] = []
    const attemptedUrls = new Set<string>()
    const errors: Array<{ url?: string; error: string }> = []
    const pages: ResearchPage[] = []
    let pageAttempts = 0

    const searchView = this.createHiddenView()
    try {
      for (const [queryIndex, query] of plannedQueries.entries()) {
        if (pages.length >= targetPages || pageAttempts >= maxAttempts) break
        throwIfAborted(signal)
        searchQueries.push(query)
        notifyProgress(onProgress, {
          stage: 'discovering',
          message: `Searching source lane ${queryIndex + 1}/${plannedQueries.length}…`,
          queryIndex: queryIndex + 1,
          queryCount: plannedQueries.length,
          pagesAttempted: pageAttempts,
          pagesVerified: pages.length,
          targetPages
        })

        const discoveryStartedAt = Date.now()
        try {
          const cacheKey = `${maxResults}:${query.toLowerCase()}`
          const cached = this.searchCache.get(cacheKey)
          let serp: Array<Omit<SerpCandidate, 'query'>>

          if (cached && cached.expiresAt > Date.now()) {
            serp = cached.candidates
          } else {
            const result = await loadSearchPage(searchView.webContents, googleSearchUrl(query, maxResults), signal)
            recordNavigation(navigation, result)
            serp = await evaluate<Array<Omit<SerpCandidate, 'query'>>>(
              searchView.webContents,
              buildSerpExtractionProgram(maxResults)
            )
            this.searchCache.set(cacheKey, {
              expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
              candidates: serp
            })
          }
          discovered.push(...serp.map((result) => ({ ...result, query })))
        } catch (error) {
          if (signal.aborted) throw error
          errors.push({ error: `SERP query failed for "${query}": ${formatError(error)}` })
        } finally {
          discoveryMs += Date.now() - discoveryStartedAt
        }

        const candidates = rankSerpCandidates(discovered, searchQueries, maxAttempts)
          .filter((candidate) => !attemptedUrls.has(candidate.url))
        const attemptsRemaining = maxAttempts - pageAttempts
        const targetRemaining = targetPages - pages.length
        if (candidates.length === 0 || attemptsRemaining <= 0 || targetRemaining <= 0) continue

        const pageBatchStartedAt = Date.now()
        const attemptsBeforeBatch = pageAttempts
        const batch = await collectWithConcurrencyUntil(
          candidates,
          {
            concurrency: PAGE_WORKER_CONCURRENCY,
            target: targetRemaining,
            maxAttempts: attemptsRemaining,
            onStarted: ({ attempted, succeeded }) => {
              notifyVerificationProgress(
                onProgress,
                attemptsBeforeBatch + attempted,
                pages.length + succeeded,
                maxAttempts,
                targetPages
              )
            },
            onSettled: ({ attempted, succeeded }) => {
              notifyVerificationProgress(
                onProgress,
                attemptsBeforeBatch + attempted,
                pages.length + succeeded,
                maxAttempts,
                targetPages
              )
            }
          },
          async (candidate, index, stopSignal): Promise<ResearchPageDraft | null> => {
            const rank = attemptsBeforeBatch + index + 1
            attemptedUrls.add(candidate.url)
            const view = this.createHiddenView()
            const linked = linkAbortSignals(signal, stopSignal)
            try {
              const navigationResult = await loadPage(view.webContents, candidate.url, linked.signal)
              recordNavigation(navigation, navigationResult)
              const extracted = await evaluate<{
                title: string
                url: string
                content: string
                wordCount: number
                truncated: boolean
              }>(view.webContents, buildPageExtractionProgram(snippetChars))
              const assessment = assessExtractedPage(extracted)
              if (!assessment.verified) {
                throw new Error(`page verification failed: ${assessment.reason}`)
              }
              const html = await evaluate<string>(
                view.webContents,
                `return (document.documentElement?.outerHTML || '').slice(0, ${MAX_HTML_CHARS})`
              )
              return {
                rank,
                candidate,
                title: extracted.title || candidate.title,
                url: extracted.url || candidate.url,
                content: extracted.content,
                wordCount: extracted.wordCount,
                html
              }
            } catch (error) {
              if (signal.aborted) throw error
              if (stopSignal.aborted) return null
              errors.push({ url: candidate.url, error: formatError(error) })
              return null
            } finally {
              linked.dispose()
              this.closeHiddenView(view)
            }
          }
        )
        pageAttempts += batch.attempted

        for (const { value: draft } of batch.values) {
          const baseName = `page-${String(draft.rank).padStart(2, '0')}`
          const artifactPath = join(artifactDir, `${baseName}.txt`)
          const htmlPath = join(artifactDir, `${baseName}.html`)
          try {
            await writeFile(artifactPath, `${draft.content}\n`, 'utf8')
            await writeFile(htmlPath, draft.html, 'utf8')
            pages.push({
              rank: draft.rank,
              url: draft.url,
              title: draft.title,
              wordCount: draft.wordCount,
              artifactPath,
              htmlPath,
              sourceQuery: draft.candidate.query,
              sourceTier: draft.candidate.sourceTier,
              score: draft.candidate.score,
              verified: true
            })
          } catch (error) {
            errors.push({ url: draft.url, error: `artifact write failed: ${formatError(error)}` })
          }
        }
        pageMs += Date.now() - pageBatchStartedAt
      }
    } finally {
      this.closeHiddenView(searchView)
    }

    notifyProgress(onProgress, {
      stage: 'finalizing',
      message: `Finalizing ${pages.length} verified ${pages.length === 1 ? 'page' : 'pages'}…`,
      pagesAttempted: pageAttempts,
      pagesVerified: pages.length,
      targetPages
    })
    const finalizationStartedAt = Date.now()
    const tabs = this.getTabs()
    const visibleTabId = pages.length > 0 && tabs
      ? this.stageBestPage(tabs, pages[0].url)
      : undefined

    if (visibleTabId) {
      for (const page of pages) page.visibleTabId = visibleTabId
    }

    const finalizationMs = Date.now() - finalizationStartedAt
    const executionMs = Date.now() - executionStartedAt
    const metrics: ResearchMetrics = {
      queueMs,
      setupMs,
      discoveryMs,
      pageMs,
      finalizationMs,
      executionMs,
      totalMs: queueMs + executionMs,
      targetPages,
      maxAttempts,
      queriesAttempted: searchQueries.length,
      pagesAttempted: pageAttempts,
      pagesVerified: pages.length,
      targetMet: pages.length >= targetPages,
      navigation
    }

    notifyProgress(onProgress, {
      stage: 'complete',
      message: `Saved ${pages.length}/${targetPages} verified ${targetPages === 1 ? 'page' : 'pages'} in ${formatDuration(metrics.totalMs)}.`,
      pagesAttempted: pageAttempts,
      pagesVerified: pages.length,
      targetPages
    })

    return {
      ok: pages.length > 0,
      researchId,
      queries,
      searchQueries,
      artifactDir,
      discoveredUrls: [...new Set(discovered.map((candidate) => candidate.url))],
      discoveredCount: new Set(discovered.map((candidate) => candidate.url)).size,
      pages,
      ...(visibleTabId ? { visibleTabId } : {}),
      metrics,
      ...(errors.length > 0 ? { errors } : {}),
      ...(pages.length === 0 && errors.length === 0 ? { error: 'No qualifying pages found' } : {})
    }
  }

  private createHiddenView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: browserPartition
      }
    })
    view.webContents.setUserAgent(chromeLikeUserAgent())
    this.searchViews.add(view)
    return view
  }

  private closeHiddenView(view: WebContentsView): void {
    this.searchViews.delete(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private stageBestPage(tabs: TabManager, url: string): string {
    if (this.stagingTabId && tabs.resolveWebContents(this.stagingTabId)) {
      tabs.navigate(this.stagingTabId, url)
      tabs.activateTab(this.stagingTabId)
      return this.stagingTabId
    }

    this.stagingTabId = tabs.createTab(url)
    return this.stagingTabId
  }
}

async function loadSearchPage(
  webContents: Electron.WebContents,
  url: string,
  signal: AbortSignal
): Promise<PageNavigationResult> {
  return loadPageAndSettle(webContents, url, {
    timeoutMs: PAGE_TIMEOUT_MS,
    userAgent: chromeLikeUserAgent(),
    signal,
    readySelector: 'a[href] h3',
    quietMs: 100,
    maxSettleMs: 750
  })
}

async function loadPage(
  webContents: Electron.WebContents,
  url: string,
  signal: AbortSignal
): Promise<PageNavigationResult> {
  return loadPageAndSettle(webContents, url, {
    timeoutMs: PAGE_TIMEOUT_MS,
    userAgent: chromeLikeUserAgent(),
    signal
  })
}

async function evaluate<T>(webContents: Electron.WebContents, code: string): Promise<T> {
  return webContents.executeJavaScript(`(async () => { ${code}\n})()`, true) as Promise<T>
}

function clamp(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('research run aborted')
}

function notifyProgress(onProgress: ((progress: ResearchProgress) => void) | undefined, progress: ResearchProgress): void {
  try {
    onProgress?.(progress)
  } catch {
    // Progress is observational and must never fail the research run.
  }
}

function notifyVerificationProgress(
  onProgress: ((progress: ResearchProgress) => void) | undefined,
  attempted: number,
  verified: number,
  maxAttempts: number,
  targetPages: number
): void {
  notifyProgress(onProgress, {
    stage: 'verifying',
    message: `Verifying pages — ${verified}/${targetPages} verified, ${attempted}/${maxAttempts} attempted…`,
    pagesAttempted: attempted,
    pagesVerified: verified,
    targetPages
  })
}

function createNavigationMetrics(): NavigationMetrics {
  return { count: 0, domReadyMs: 0, settleMs: 0, settleReasons: {} }
}

function recordNavigation(metrics: NavigationMetrics, result: PageNavigationResult): void {
  metrics.count += 1
  metrics.domReadyMs += result.domReadyMs
  metrics.settleMs += result.settleMs
  metrics.settleReasons[result.settleReason] = (metrics.settleReasons[result.settleReason] ?? 0) + 1
}

function linkAbortSignals(...signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  for (const signal of signals) {
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) controller.abort()
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) signal.removeEventListener('abort', onAbort)
    }
  }
}

async function pruneResearchArtifacts(root: string): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const directories = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(root, entry.name)
        const info = await stat(path)
        const children = await readdir(path, { withFileTypes: true })
        const sizes = await Promise.all(children
          .filter((child) => child.isFile())
          .map(async (child) => (await stat(join(path, child.name))).size))
        return { path, modifiedAt: info.mtimeMs, size: sizes.reduce((sum, size) => sum + size, 0) }
      }))

    directories.sort((left, right) => right.modifiedAt - left.modifiedAt)
    let retainedBytes = 0
    const now = Date.now()

    for (const directory of directories) {
      retainedBytes += directory.size
      if (now - directory.modifiedAt > RESEARCH_MAX_AGE_MS || retainedBytes > RESEARCH_MAX_BYTES) {
        await rm(directory.path, { recursive: true, force: true })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to prune research artifacts', error)
    }
  }
}
