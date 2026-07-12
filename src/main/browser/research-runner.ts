import { app, WebContentsView } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResearchProgress } from '../../shared/ipc.js'
import { browserPartition, chromeLikeUserAgent } from './browser-session.js'
import { buildPageExtractionProgram } from './browser-agent.js'
import { ResearchPruneGate, writeResearchPageArtifacts } from './research-artifacts.js'
import {
  normalizeResearchFocus,
  selectResearchEvidence,
  type ResearchEvidenceDocument,
  type ResearchFocus,
  type ResearchGap,
  type ResearchPassage
} from './research-evidence.js'
import { collectWithConcurrencyUntil, KeyedTaskScheduler } from './research-execution.js'
import { loadPageAndSettle, type PageNavigationResult } from './page-navigation.js'
import {
  assessExtractedPage,
  buildResearchQueryVariants,
  buildSerpExtractionProgram,
  googleSearchUrl,
  normalizeResearchUrls,
  rankSerpCandidates,
  type RankedSerpCandidate,
  type SerpCandidate
} from './research-utils.js'

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
const MAX_ARTIFACT_CHARS = 100_000
const MAX_HTML_CHARS = 2_000_000
const SEARCH_CACHE_TTL_MS = 10 * 60_000
const PAGE_CACHE_TTL_MS = 5 * 60_000
const MAX_PAGE_CACHE_ENTRIES = 12
const RESEARCH_PRUNE_COOLDOWN_MS = 30 * 60_000

export type ResearchRequest = {
  queries?: string[]
  urls?: string[]
  focus?: Array<{ id?: unknown; need?: unknown; minSources?: unknown }>
  maxResults?: number | null
  maxPages?: number | null
  maxAttempts?: number | null
  snippetChars?: number | null
}

export type ResearchPage = {
  sourceId: string
  rank: number
  url: string
  title: string
  observedAt: string
  status?: number
  cacheHit: boolean
  charCount: number
  wordCount: number
  artifactPath: string
  htmlPath: string
  sourceQuery?: string
  sourceKind: 'direct' | 'search'
  sourceTier?: string
  score?: number
  artifactTruncated: boolean
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
  pageCacheHits: number
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
  urls?: string[]
  focus?: ResearchFocus[]
  searchQueries?: string[]
  artifactDir?: string
  pages?: ResearchPage[]
  passages?: ResearchPassage[]
  gaps?: ResearchGap[]
  discoveredUrls?: string[]
  discoveredCount?: number
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
  page: ResearchPage
  content: string
}

type ExtractedResearchPage = {
  title: string
  url: string
  content: string
  wordCount: number
  status: number
  truncated: boolean
  html: string
  observedAt: string
}

type CachedResearchPage = ExtractedResearchPage & { expiresAt: number }

type ResearchCandidate = RankedSerpCandidate & { sourceKind: 'direct' | 'search' }

type ActiveResearchRun = {
  turnId: string
  controller: AbortController
}

type NavigationMetrics = ResearchMetrics['navigation']

/**
 * A compact, adaptive research pipeline. Work is serialized per thread with a
 * small global concurrency bound. Source lanes and page candidates stop as soon
 * as the requested page or focused-evidence target is satisfied.
 */
export class ResearchRunner {
  private readonly searchViews = new Set<WebContentsView>()
  private readonly activeRuns = new Map<string, ActiveResearchRun>()
  private readonly searchCache = new Map<string, { expiresAt: number; candidates: Array<Omit<SerpCandidate, 'query'>> }>()
  private readonly pageCache = new Map<string, CachedResearchPage>()
  private readonly scheduler = new KeyedTaskScheduler(MAX_CONCURRENT_RESEARCH_RUNS)
  private readonly pruneGate = new ResearchPruneGate(RESEARCH_PRUNE_COOLDOWN_MS)

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
    this.pageCache.clear()
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
    const queries = (request.queries ?? [])
      .filter((query): query is string => typeof query === 'string' && query.trim().length > 0)
      .map((query) => query.trim())
      .slice(0, 3)
    const urls = normalizeResearchUrls(request.urls ?? [])
    const focus = normalizeResearchFocus(request.focus)

    if (queries.length === 0 && urls.length === 0) {
      return { ok: false, error: 'research_web requires at least one non-empty query or public HTTP(S) URL' }
    }

    const executionStartedAt = Date.now()
    const maxResults = clamp(request.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_MAX_RESULTS)
    const focusTarget = focus.length > 0 ? Math.max(...focus.map(({ minSources }) => minSources)) : null
    const directTarget = queries.length === 0 && urls.length > 0 ? Math.min(urls.length, MAX_TARGET_PAGES) : null
    const targetPages = clamp(
      request.maxPages,
      focusTarget ?? directTarget ?? DEFAULT_TARGET_PAGES,
      1,
      MAX_TARGET_PAGES
    )
    const maxAttempts = clamp(request.maxAttempts, DEFAULT_MAX_ATTEMPTS, targetPages, MAX_MAX_ATTEMPTS)
    const passageChars = clamp(request.snippetChars, DEFAULT_SNIPPET_CHARS, 1_000, MAX_SNIPPET_CHARS)
    const researchId = crypto.randomUUID()
    const artifactRoot = join(app.getPath('userData'), 'research')
    const artifactDir = join(artifactRoot, researchId)
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
    await mkdir(artifactDir, { recursive: true })
    void this.pruneGate.schedule(artifactRoot)?.catch((error) => {
      console.warn('Failed to prune research artifacts', error)
    })
    setupMs = Date.now() - setupStartedAt

    const plannedQueries = buildResearchQueryVariants(queries)
    const searchQueries: string[] = []
    const discovered: SerpCandidate[] = []
    const discoveredUrls = new Set(urls)
    const attemptedUrls = new Set<string>()
    const errors: Array<{ url?: string; error: string }> = []
    const pages: ResearchPage[] = []
    const evidenceDocuments: ResearchEvidenceDocument[] = []
    let pageAttempts = 0
    let pageCacheHits = 0
    let evidenceRevision = -1
    let cachedEvidence: ReturnType<typeof selectResearchEvidence> = { passages: [], gaps: [] }

    const evidence = (): ReturnType<typeof selectResearchEvidence> => {
      if (evidenceRevision !== evidenceDocuments.length) {
        cachedEvidence = selectResearchEvidence(focus, evidenceDocuments, passageChars)
        evidenceRevision = evidenceDocuments.length
      }
      return cachedEvidence
    }
    const goalMet = (): boolean => focus.length > 0
      ? evidence().gaps.length === 0
      : pages.length >= targetPages
    const remainingSuccessTarget = (): number => {
      if (focus.length === 0) return Math.max(0, targetPages - pages.length)
      const gaps = evidence().gaps
      if (gaps.length === 0) return 0
      const shortfall = Math.max(...gaps.map((gap) => gap.requiredSources - gap.matchedSources), 1)
      return Math.min(Math.max(0, MAX_TARGET_PAGES - pages.length), shortfall)
    }

    const materializePage = async (
      candidate: ResearchCandidate,
      rank: number,
      sourceId: string,
      extracted: ExtractedResearchPage,
      cacheHit: boolean
    ): Promise<ResearchPageDraft> => {
      const title = extracted.title || candidate.title
      const url = extracted.url || candidate.url
      const paths = await writeResearchPageArtifacts(artifactDir, sourceId, extracted.content, extracted.html)
      return {
        page: {
          sourceId,
          rank,
          url,
          title,
          observedAt: extracted.observedAt,
          ...(extracted.status > 0 ? { status: extracted.status } : {}),
          cacheHit,
          charCount: extracted.content.length,
          wordCount: extracted.wordCount,
          ...paths,
          ...(candidate.sourceKind === 'search' ? { sourceQuery: candidate.query } : {}),
          sourceKind: candidate.sourceKind,
          sourceTier: candidate.sourceTier,
          score: candidate.score,
          artifactTruncated: extracted.truncated,
          verified: true
        },
        content: extracted.content
      }
    }

    const verifyCandidateBatch = async (candidates: ResearchCandidate[]): Promise<void> => {
      const available = candidates.filter((candidate) => !attemptedUrls.has(candidate.url))
      const attemptsRemaining = maxAttempts - pageAttempts
      const successTarget = remainingSuccessTarget()
      if (available.length === 0 || attemptsRemaining <= 0 || successTarget <= 0) return

      const pageBatchStartedAt = Date.now()
      const attemptsBeforeBatch = pageAttempts
      const batch = await collectWithConcurrencyUntil(
        available,
        {
          concurrency: PAGE_WORKER_CONCURRENCY,
          target: successTarget,
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
          const sourceId = `page-${String(rank).padStart(2, '0')}`
          attemptedUrls.add(candidate.url)
          const cached = this.readPageCache(candidate.url)
          if (cached) {
            try {
              pageCacheHits += 1
              return await materializePage(candidate, rank, sourceId, cached, true)
            } catch (error) {
              errors.push({ url: candidate.url, error: `cached artifact write failed: ${formatError(error)}` })
              return null
            }
          }

          const view = this.createHiddenView()
          const linked = linkAbortSignals(signal, stopSignal)
          try {
            const navigationResult = await loadPage(view.webContents, candidate.url, linked.signal)
            recordNavigation(navigation, navigationResult)
            const result = await evaluate<Omit<ExtractedResearchPage, 'observedAt'>>(
              view.webContents,
              buildPageExtractionProgram(MAX_ARTIFACT_CHARS, MAX_HTML_CHARS)
            )
            const assessment = assessExtractedPage(result)
            if (!assessment.verified) {
              throw new Error(`page verification failed: ${assessment.reason}`)
            }

            const extracted: ExtractedResearchPage = { ...result, observedAt: new Date().toISOString() }
            this.cachePage(candidate.url, extracted)
            if (extracted.url !== candidate.url) this.cachePage(extracted.url, extracted)
            return materializePage(candidate, rank, sourceId, extracted, false)
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
        pages.push(draft.page)
        evidenceDocuments.push({
          sourceId: draft.page.sourceId,
          title: draft.page.title,
          url: draft.page.url,
          artifactPath: draft.page.artifactPath,
          content: draft.content,
          observedAt: draft.page.observedAt,
          ...(draft.page.sourceTier ? { sourceTier: draft.page.sourceTier } : {})
        })
      }
      pageMs += Date.now() - pageBatchStartedAt
    }

    const drainCandidates = async (candidates: ResearchCandidate[]): Promise<void> => {
      while (!goalMet() && pageAttempts < maxAttempts && pages.length < MAX_TARGET_PAGES) {
        const remaining = candidates.filter((candidate) => !attemptedUrls.has(candidate.url))
        if (remaining.length === 0) return
        const attemptsBefore = pageAttempts
        await verifyCandidateBatch(remaining)
        if (pageAttempts === attemptsBefore) return
      }
    }

    if (urls.length > 0) {
      notifyProgress(onProgress, {
        stage: 'verifying',
        message: `Checking ${urls.length} direct ${urls.length === 1 ? 'source' : 'sources'}…`,
        pagesAttempted: pageAttempts,
        pagesVerified: pages.length,
        targetPages
      })
      const rankingQueries = [...queries, ...focus.map(({ need }) => need)]
      const directQuery = focus[0]?.need ?? queries[0] ?? 'direct source'
      const directCandidates = rankSerpCandidates(
        urls.map((url, index) => ({
          url,
          title: url,
          snippet: '',
          rank: index + 1,
          query: directQuery
        })),
        rankingQueries.length > 0 ? rankingQueries : [directQuery],
        urls.length
      ).map((candidate): ResearchCandidate => ({ ...candidate, sourceKind: 'direct' }))
      await drainCandidates(directCandidates)
    }

    if (!goalMet() && plannedQueries.length > 0 && pageAttempts < maxAttempts && pages.length < MAX_TARGET_PAGES) {
      const searchView = this.createHiddenView()
      try {
        for (const [queryIndex, query] of plannedQueries.entries()) {
          if (goalMet() || pageAttempts >= maxAttempts || pages.length >= MAX_TARGET_PAGES) break
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
            const queryResults = serp.map((result) => ({ ...result, query }))
            discovered.push(...queryResults)
            for (const result of queryResults) discoveredUrls.add(result.url)
          } catch (error) {
            if (signal.aborted) throw error
            errors.push({ error: `SERP query failed for "${query}": ${formatError(error)}` })
          } finally {
            discoveryMs += Date.now() - discoveryStartedAt
          }

          const candidates = rankSerpCandidates(discovered, searchQueries, maxAttempts)
            .map((candidate): ResearchCandidate => ({ ...candidate, sourceKind: 'search' }))
          await drainCandidates(candidates)
        }
      } finally {
        this.closeHiddenView(searchView)
      }
    }

    notifyProgress(onProgress, {
      stage: 'finalizing',
      message: `Finalizing ${pages.length} verified ${pages.length === 1 ? 'page' : 'pages'}…`,
      pagesAttempted: pageAttempts,
      pagesVerified: pages.length,
      pageCacheHits,
      targetPages
    })
    const finalizationStartedAt = Date.now()
    const evidencePacket = evidence()
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
      targetMet: goalMet(),
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
      urls,
      ...(focus.length > 0 ? { focus } : {}),
      searchQueries,
      artifactDir,
      discoveredUrls: [...discoveredUrls],
      discoveredCount: discoveredUrls.size,
      pages,
      ...(focus.length > 0 ? { passages: evidencePacket.passages, gaps: evidencePacket.gaps } : {}),
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
