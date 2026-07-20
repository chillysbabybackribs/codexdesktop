import { app, session, WebContentsView } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResearchProgress } from '../../shared/ipc.js'
import { researchPartition } from './browser-session.js'
import { executePageJavaScript } from './page-execution.js'
import { buildPageExtractionProgram } from './browser-agent.js'
import { ResearchMemoryCache, ResearchPruneGate, writeResearchPageArtifacts } from './research-artifacts.js'
import {
  normalizeResearchFocus,
  selectResearchEvidence,
  type ResearchEvidenceDocument,
  type ResearchFocus,
  type ResearchGap,
  type ResearchPassage
} from './research-evidence.js'
import {
  collectWithConcurrencyUntil,
  KeyedTaskScheduler,
  retainValuesReducingDeficit
} from './research-execution.js'
import { loadPageAndSettle, type PageNavigationResult } from './page-navigation.js'
import { ResearchOriginRouter, type ResearchOriginRouteOutcome } from './research-origin-router.js'
import { fetchStaticResearchPage } from './research-static-fetch.js'
import {
  assessExtractedPage,
  buildResearchQueryVariants,
  buildSerpExtractionProgram,
  extractSameHostNavLinks,
  googleSearchUrl,
  isCrossHostLanding,
  isPublicResearchAddress,
  normalizeResearchUrls,
  preferExtractableHost,
  rankSerpCandidates,
  type RankedSerpCandidate,
  type SerpCandidate
} from './research-utils.js'

const DEFAULT_MAX_RESULTS = 5
const MAX_MAX_RESULTS = 10
const DEFAULT_UNFOCUSED_SOURCE_TARGET = 1
const MIN_CANDIDATE_ATTEMPTS = 3
const CANDIDATE_ATTEMPTS_PER_SOURCE = 2
const MAX_CANDIDATE_ATTEMPTS = 24
const DEFAULT_SNIPPET_CHARS = 3_500
const MAX_SNIPPET_CHARS = 8_000
const PAGE_TIMEOUT_MS = 15_000
const PAGE_WORKER_CONCURRENCY = 3
const MAX_CONCURRENT_RESEARCH_RUNS = 2
const STATIC_PREFLIGHT_MAX_BYTES = 750_000
const MAX_ARTIFACT_CHARS = 100_000
const MAX_HTML_CHARS = 2_000_000
const REDIRECT_HUB_LINK_LIMIT = 8
const MAX_REDIRECT_FOLLOW_UPS = 16
const MAX_DISCOVERY_QUERIES = 6
const SEARCH_WORKER_CONCURRENCY = 4
const SEARCH_CACHE_TTL_MS = 10 * 60_000
const PAGE_CACHE_TTL_MS = 5 * 60_000
const MAX_PAGE_CACHE_ENTRIES = 12
const RESEARCH_PRUNE_COOLDOWN_MS = 30 * 60_000

export type ResearchRequest = {
  queries?: string[]
  urls?: string[]
  focus?: Array<{ id?: unknown; need?: unknown; minSources?: unknown }>
  maxResults?: number | null
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
  mediaType?: string
  extractionPath?: 'static-html' | 'network-response' | 'browser-dom'
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
  staticFetchAttempts: number
  staticFetchHits: number
  staticFetchSkipped: number
  staticFetchTimeouts: number
  staticFetchMs: number
  browserPageLoads: number
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
  discoveredTruncated?: boolean
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

export type SearchDiscoveryRequest = {
  queries?: string[]
  maxResults?: number | null
  maxCandidates?: number | null
}

export type SearchDiscoveryContext = {
  signal?: AbortSignal
  onProgress?: (progress: ResearchProgress) => void
  /**
   * Fires at most once, as soon as the earliest search lane yields ranked
   * candidates, so callers can begin visible navigation immediately instead of
   * waiting behind the slowest lane. The final ranking may order candidates
   * differently; callers that navigate early keep the full ranked list as
   * alternates.
   */
  onFirstCandidates?: (candidates: RankedSerpCandidate[]) => void
}

export type SearchDiscoveryResult = {
  ok: boolean
  queries: string[]
  candidates: RankedSerpCandidate[]
  discoveredCount: number
  metrics: {
    durationMs: number
    searchesAttempted: number
    cacheHits: number
    navigation: NavigationMetrics
  }
  errors?: Array<{ error: string }>
  error?: string
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
  mediaType?: string
  extractionPath?: 'static-html' | 'network-response' | 'browser-dom'
}

type ResearchCandidate = RankedSerpCandidate & { sourceKind: 'direct' | 'search' }

type ActiveResearchRun = {
  turnId: string
  controller: AbortController
}

type NavigationMetrics = ResearchMetrics['navigation']

type SearchLaneOutcome = {
  query: string
  candidates: SerpCandidate[]
  cacheHit: boolean
  navigation?: PageNavigationResult
  error?: string
}

/**
 * A compact, adaptive research pipeline. Work is serialized per thread with a
 * small global concurrency bound. The model's evidence needs determine how
 * many sources to keep; source lanes stop as soon as those needs are covered.
 */
export class ResearchRunner {
  private readonly searchViews = new Set<WebContentsView>()
  private readonly activeRuns = new Map<string, ActiveResearchRun>()
  private readonly searchCache = new Map<string, { expiresAt: number; candidates: Array<Omit<SerpCandidate, 'query'>> }>()
  private readonly pageCache = new ResearchMemoryCache<ExtractedResearchPage>(PAGE_CACHE_TTL_MS, MAX_PAGE_CACHE_ENTRIES)
  private readonly originRouter = new ResearchOriginRouter()
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

  /**
   * Discover and rank destination URLs without ever attaching a SERP to the
   * visible browser window. Model-authored semantic variants are searched in
   * bounded parallel hidden Chromium workers; a lone query receives a small
   * compatibility expansion so older callers still get useful breadth.
   */
  async discover(
    request: SearchDiscoveryRequest,
    context: SearchDiscoveryContext = {}
  ): Promise<SearchDiscoveryResult> {
    const suppliedQueries = (request.queries ?? [])
      .filter((query): query is string => typeof query === 'string' && query.trim().length > 0)
      .map((query) => query.trim().slice(0, 500))
      .slice(0, MAX_DISCOVERY_QUERIES)
    const queries = buildResearchQueryVariants(suppliedQueries, MAX_DISCOVERY_QUERIES)
    const navigation = createNavigationMetrics()

    if (queries.length === 0) {
      return {
        ok: false,
        queries: [],
        candidates: [],
        discoveredCount: 0,
        metrics: { durationMs: 0, searchesAttempted: 0, cacheHits: 0, navigation },
        error: 'hidden search discovery requires at least one non-empty query'
      }
    }

    const signal = context.signal ?? new AbortController().signal
    const maxResults = clamp(request.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_MAX_RESULTS)
    const maxCandidates = clamp(request.maxCandidates, Math.max(6, maxResults), 1, MAX_CANDIDATE_ATTEMPTS)
    let firstCandidatesFired = false
    const onLaneCandidates = context.onFirstCandidates
      ? (laneCandidates: SerpCandidate[]): void => {
          if (firstCandidatesFired || laneCandidates.length === 0) return
          const ranked = rankSerpCandidates(laneCandidates, queries, maxCandidates)
          if (ranked.length === 0) return
          firstCandidatesFired = true
          context.onFirstCandidates!(ranked)
        }
      : undefined
    const discovery = await this.searchHiddenInParallel(queries, maxResults, signal, context.onProgress, onLaneCandidates)
    const candidates = rankSerpCandidates(discovery.candidates, queries, maxCandidates)

    return {
      ok: candidates.length > 0,
      queries,
      candidates,
      discoveredCount: new Set(discovery.candidates.map(({ url }) => url)).size,
      metrics: {
        durationMs: discovery.durationMs,
        searchesAttempted: discovery.searchesAttempted,
        cacheHits: discovery.cacheHits,
        navigation: discovery.navigation
      },
      ...(discovery.errors.length > 0 ? { errors: discovery.errors.map((error) => ({ error })) } : {}),
      ...(candidates.length === 0 ? { error: 'No destination URLs found in hidden search results' } : {})
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
      .map((query) => query.trim().slice(0, 500))
      .slice(0, MAX_DISCOVERY_QUERIES)
    const urls = normalizeResearchUrls(request.urls ?? [])
    const focus = normalizeResearchFocus(request.focus)

    if (queries.length === 0 && urls.length === 0) {
      return { ok: false, error: 'research_web requires at least one non-empty query or public HTTP(S) URL' }
    }

    const executionStartedAt = Date.now()
    const maxResults = clamp(request.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_MAX_RESULTS)
    // Do not impose a fixed verified-page count. Focus is the model-authored
    // research contract: each item asks for a number of distinct sources. A
    // page can satisfy several items, so coverage still stops earlier when it
    // can. When no focus is supplied, one discovered source is the deliberately
    // conservative default; explicitly supplied direct URLs are all in scope.
    const targetPages = focus.length > 0
      ? focus.reduce((total, { minSources }) => total + minSources, 0)
      : urls.length > 0
        ? urls.length
        : DEFAULT_UNFOCUSED_SOURCE_TARGET
    const defaultMaxAttempts = Math.min(
      MAX_CANDIDATE_ATTEMPTS,
      Math.max(MIN_CANDIDATE_ATTEMPTS, targetPages * CANDIDATE_ATTEMPTS_PER_SOURCE)
    )
    const maxAttempts = clamp(request.maxAttempts, defaultMaxAttempts, MIN_CANDIDATE_ATTEMPTS, MAX_CANDIDATE_ATTEMPTS)
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
    let staticFetchAttempts = 0
    let staticFetchHits = 0
    let staticFetchSkipped = 0
    let staticFetchTimeouts = 0
    let staticFetchMs = 0
    let browserPageLoads = 0
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
    const remainingSuccessTarget = (): number => Math.max(0, targetPages - pages.length)
    const draftEvidenceDocument = (draft: ResearchPageDraft): ResearchEvidenceDocument => ({
      sourceId: draft.page.sourceId,
      title: draft.page.title,
      url: draft.page.url,
      content: draft.content,
      observedAt: draft.page.observedAt,
      ...(draft.page.sourceTier ? { sourceTier: draft.page.sourceTier } : {})
    })
    const focusCoverageDeficit = (drafts: readonly ResearchPageDraft[] = []): number => {
      if (focus.length === 0) return 0
      const packet = selectResearchEvidence(
        focus,
        [...evidenceDocuments, ...drafts.map(draftEvidenceDocument)],
        passageChars
      )
      return packet.gaps.reduce(
        (total, gap) => total + Math.max(0, gap.requiredSources - gap.matchedSources),
        0
      )
    }
    // Direct URLs that redirect onto a different host frequently land on a
    // navigation hub (docs sites migrating domains). Harvest the hub's own
    // same-host links so they can be attempted one hop deep instead of the
    // run ending with "the requested page had nothing."
    const redirectFollowUps: SerpCandidate[] = []
    const harvestRedirectHubLinks = (candidate: ResearchCandidate, extracted: { url: string; html: string }): void => {
      if (candidate.sourceKind !== 'direct') return
      if (redirectFollowUps.length >= MAX_REDIRECT_FOLLOW_UPS) return
      const landedUrl = extracted.url || candidate.url
      if (!isCrossHostLanding(candidate.url, landedUrl)) return
      for (const link of extractSameHostNavLinks(extracted.html, landedUrl, REDIRECT_HUB_LINK_LIMIT)) {
        if (redirectFollowUps.length >= MAX_REDIRECT_FOLLOW_UPS) break
        if (attemptedUrls.has(link.url) || discoveredUrls.has(link.url)) continue
        discoveredUrls.add(link.url)
        redirectFollowUps.push({
          url: link.url,
          title: link.title,
          snippet: '',
          rank: redirectFollowUps.length + 1,
          query: candidate.query
        })
      }
    }
    const coversUnresolvedFocus = (
      candidate: ResearchCandidate,
      sourceId: string,
      extracted: ExtractedResearchPage
    ): boolean => {
      if (focus.length === 0) return true
      const unresolved = new Set(evidence().gaps.map(({ focusId }) => focusId))
      if (unresolved.size === 0) return true
      const packet = selectResearchEvidence(
        focus.filter(({ id }) => unresolved.has(id)),
        [{
          sourceId,
          title: extracted.title || candidate.title,
          url: extracted.url || candidate.url,
          content: extracted.content,
          observedAt: extracted.observedAt,
          ...(candidate.sourceTier ? { sourceTier: candidate.sourceTier } : {})
        }],
        passageChars
      )
      return packet.passages.length > 0
    }

    const materializePage = async (
      candidate: ResearchCandidate,
      rank: number,
      sourceId: string,
      extracted: ExtractedResearchPage,
      cacheHit: boolean,
      operationSignal: AbortSignal
    ): Promise<ResearchPageDraft> => {
      throwIfAborted(operationSignal)
      const title = extracted.title || candidate.title
      const url = extracted.url || candidate.url
      const paths = await writeResearchPageArtifacts(
        artifactDir,
        sourceId,
        extracted.content,
        extracted.html,
        operationSignal
      )
      throwIfAborted(operationSignal)
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
          ...(extracted.mediaType ? { mediaType: extracted.mediaType } : {}),
          extractionPath: extracted.extractionPath ?? 'browser-dom',
          verified: true
        },
        content: extracted.content
      }
    }

    const verifyCandidateBatch = async (candidates: ResearchCandidate[]): Promise<void> => {
      const available = candidates.filter((candidate) => !attemptedUrls.has(candidate.url))
      const attemptsRemaining = maxAttempts - pageAttempts
      // Focused runs cannot stop on a raw page count: the first successful
      // page may cover only one of several distinct evidence needs. Let the
      // coverage predicate stop the batch once all focus deficits are filled.
      const successTarget = focus.length > 0 ? attemptsRemaining : remainingSuccessTarget()
      if (available.length === 0 || attemptsRemaining <= 0 || successTarget <= 0) return

      const pageBatchStartedAt = Date.now()
      const attemptsBeforeBatch = pageAttempts
      const batch = await collectWithConcurrencyUntil<ResearchCandidate, ResearchPageDraft>(
        available,
        {
          concurrency: PAGE_WORKER_CONCURRENCY,
          target: successTarget,
          maxAttempts: attemptsRemaining,
          ...(focus.length > 0
            ? {
                shouldStop: (values: readonly { value: ResearchPageDraft }[]) =>
                  focusCoverageDeficit(values.map(({ value }) => value)) === 0
              }
            : {}),
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
              if (stopSignal.aborted) return null
              if (!coversUnresolvedFocus(candidate, sourceId, cached)) {
                recordFocusMismatch(errors, candidate.url)
                return null
              }
              const draft = await materializePage(candidate, rank, sourceId, cached, true, stopSignal)
              pageCacheHits += 1
              return draft
            } catch (error) {
              if (stopSignal.aborted) return null
              recordResearchError(errors, { url: candidate.url, error: `cached artifact write failed: ${formatError(error)}` })
              return null
            }
          }

          const fetchUrl = preferExtractableHost(candidate.url)
          const route = this.originRouter.begin(fetchUrl)
          const staticTimeout = new AbortController()
          const staticStartedAt = Date.now()
          const staticTimer = route.mode === 'static'
            ? setTimeout(() => staticTimeout.abort(), route.timeoutMs)
            : undefined
          const preflight = linkAbortSignals(signal, stopSignal, staticTimeout.signal)
          let staticResult: Awaited<ReturnType<typeof fetchStaticResearchPage>>
          let routeOutcome: ResearchOriginRouteOutcome = { kind: 'cancelled' }
          if (route.mode === 'browser') {
            staticFetchSkipped += 1
            staticResult = {
              kind: 'fallback',
              reason: `adaptive route selected Chromium: ${route.reason}`,
              durationMs: 0,
              bytes: 0,
              redirects: 0,
              finalUrl: fetchUrl
            }
          } else {
            try {
              staticFetchAttempts += 1
              staticResult = await fetchStaticResearchPage(fetchUrl, {
                fetch: (url, init) => session.fromPartition(researchPartition).fetch(url, init),
                validateUrl: assertPublicResearchUrl,
                signal: preflight.signal,
                maxBytes: STATIC_PREFLIGHT_MAX_BYTES
              })
              routeOutcome = { kind: staticResult.kind, durationMs: staticResult.durationMs }
            } catch (error) {
              if (signal.aborted) {
                preflight.dispose()
                throw error
              }
              if (stopSignal.aborted) {
                preflight.dispose()
                return null
              }
              if (staticTimeout.signal.aborted) {
                staticFetchTimeouts += 1
                const durationMs = Date.now() - staticStartedAt
                routeOutcome = { kind: 'timeout', durationMs }
                staticResult = {
                  kind: 'fallback',
                  reason: `static preflight timed out after ${route.timeoutMs}ms`,
                  durationMs,
                  bytes: 0,
                  redirects: 0,
                  finalUrl: fetchUrl
                }
              } else {
                preflight.dispose()
                recordResearchError(errors, { url: candidate.url, error: formatError(error) })
                return null
              }
            } finally {
              if (staticTimer !== undefined) clearTimeout(staticTimer)
              route.finish(routeOutcome)
            }
          }
          staticFetchMs += staticResult.durationMs
          if (staticResult.kind === 'blocked') {
            preflight.dispose()
            recordResearchError(errors, { url: candidate.url, error: staticResult.reason ?? 'static source blocked' })
            return null
          }
          if (staticResult.kind === 'accepted' && staticResult.page) {
            const extracted: ExtractedResearchPage = {
              ...staticResult.page,
              observedAt: new Date().toISOString()
            }
            // The static lane must pass the same page assessment as the
            // Chromium lane: without it a 404/challenge/login body with enough
            // text is silently accepted as a verified source.
            const staticAssessment = assessExtractedPage(extracted)
            if (staticAssessment.verified) {
              try {
                if (!coversUnresolvedFocus(candidate, sourceId, extracted)) {
                  harvestRedirectHubLinks(candidate, extracted)
                  recordFocusMismatch(errors, candidate.url)
                  return null
                }
                const draft = await materializePage(candidate, rank, sourceId, extracted, false, preflight.signal)
                this.cachePage(candidate.url, extracted)
                if (extracted.url !== candidate.url) this.cachePage(extracted.url, extracted)
                staticFetchHits += 1
                harvestRedirectHubLinks(candidate, extracted)
                return draft
              } catch (error) {
                if (signal.aborted) throw error
                if (stopSignal.aborted) return null
                recordResearchError(errors, { url: candidate.url, error: formatError(error) })
                return null
              } finally {
                preflight.dispose()
              }
            }
            harvestRedirectHubLinks(candidate, extracted)
            if (staticAssessment.reason === 'http-error') {
              // An HTTP error status is authoritative — do not spend a browser
              // load rendering an error page into "no usable passages".
              preflight.dispose()
              recordResearchError(errors, {
                url: candidate.url,
                error: `page verification failed: http-error (status ${extracted.status}${extracted.url !== candidate.url ? ` at ${extracted.url}` : ''})`
              })
              return null
            }
            // Static body reads as a shell/thin/challenge page — fall through
            // and let the Chromium lane render it before giving up.
          }
          preflight.dispose()
          if (stopSignal.aborted) return null
          browserPageLoads += 1
          const browserUrl = staticResult.finalUrl ?? fetchUrl
          const view = this.createHiddenView()
          const linked = linkAbortSignals(signal, stopSignal)
          const closeOnAbort = (): void => this.closeHiddenView(view)
          if (linked.signal.aborted) closeOnAbort()
          else linked.signal.addEventListener('abort', closeOnAbort, { once: true })
          try {
            const navigationResult = await loadPage(view.webContents, browserUrl, linked.signal)
            recordNavigation(navigation, navigationResult)
            throwIfAborted(linked.signal)
            let result = await evaluate<Omit<ExtractedResearchPage, 'observedAt'>>(
              view.webContents,
              buildPageExtractionProgram(MAX_ARTIFACT_CHARS, MAX_HTML_CHARS)
            )
            const safeFinalUrl = normalizeResearchUrls([result.url], 1)[0]
            if (!safeFinalUrl) throw new Error('page verification failed: invalid or non-public final URL')
            result.url = safeFinalUrl
            let assessment = assessExtractedPage(result)
            if (!assessment.verified && assessment.reason === 'insufficient-content' && isLikelyLoadingContent(result.content)) {
              const ready = await waitForResearchContent(view.webContents)
              throwIfAborted(linked.signal)
              if (ready) {
                result = await evaluate<Omit<ExtractedResearchPage, 'observedAt'>>(
                  view.webContents,
                  buildPageExtractionProgram(MAX_ARTIFACT_CHARS, MAX_HTML_CHARS)
                )
                const retryUrl = normalizeResearchUrls([result.url], 1)[0]
                if (!retryUrl) throw new Error('page verification failed: invalid or non-public final URL')
                result.url = retryUrl
                assessment = assessExtractedPage(result)
              }
            }
            if (!assessment.verified) {
              harvestRedirectHubLinks(candidate, result)
              const statusSuffix = result.status >= 400 ? ` (status ${result.status})` : ''
              throw new Error(`page verification failed: ${assessment.reason}${statusSuffix}`)
            }
            throwIfAborted(linked.signal)

            const extracted: ExtractedResearchPage = { ...result, observedAt: new Date().toISOString() }
            if (!coversUnresolvedFocus(candidate, sourceId, extracted)) {
              harvestRedirectHubLinks(candidate, extracted)
              recordFocusMismatch(errors, candidate.url)
              return null
            }
            const draft = await materializePage(candidate, rank, sourceId, extracted, false, linked.signal)
            this.cachePage(candidate.url, extracted)
            if (extracted.url !== candidate.url) this.cachePage(extracted.url, extracted)
            harvestRedirectHubLinks(candidate, extracted)
            return draft
          } catch (error) {
            if (signal.aborted) throw error
            if (stopSignal.aborted) return null
            recordResearchError(errors, { url: candidate.url, error: formatError(error) })
            return null
          } finally {
            linked.signal.removeEventListener('abort', closeOnAbort)
            linked.dispose()
            this.closeHiddenView(view)
          }
        }
      )
      pageAttempts += batch.attempted
      const rankedDrafts = batch.values.map(({ value }) => value)
      const acceptedDrafts = focus.length > 0
        ? retainValuesReducingDeficit(
            rankedDrafts,
            targetPages - pages.length,
            (retained) => focusCoverageDeficit(retained)
          )
        : rankedDrafts.slice(0, targetPages - pages.length)
      for (const draft of acceptedDrafts) {
        pages.push(draft.page)
        evidenceDocuments.push(draftEvidenceDocument(draft))
      }
      pageMs += Date.now() - pageBatchStartedAt
    }

    const drainCandidates = async (candidates: ResearchCandidate[]): Promise<void> => {
      while (!goalMet() && pageAttempts < maxAttempts && pages.length < targetPages) {
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

      if (!goalMet() && redirectFollowUps.length > 0 && pageAttempts < maxAttempts && pages.length < targetPages) {
        notifyProgress(onProgress, {
          stage: 'verifying',
          message: `Following ${redirectFollowUps.length} same-site ${redirectFollowUps.length === 1 ? 'link' : 'links'} found behind cross-host redirects…`,
          pagesAttempted: pageAttempts,
          pagesVerified: pages.length,
          targetPages
        })
        const followUpCandidates = rankSerpCandidates(
          redirectFollowUps,
          rankingQueries.length > 0 ? rankingQueries : [directQuery],
          redirectFollowUps.length
        ).map((candidate): ResearchCandidate => ({ ...candidate, sourceKind: 'direct' }))
        await drainCandidates(followUpCandidates)
      }
    }

    if (!goalMet() && plannedQueries.length > 0 && pageAttempts < maxAttempts && pages.length < targetPages) {
      const discovery = await this.searchHiddenInParallel(plannedQueries, maxResults, signal, onProgress)
      searchQueries.push(...plannedQueries)
      discovered.push(...discovery.candidates)
      discoveryMs += discovery.durationMs
      mergeNavigation(navigation, discovery.navigation)
      for (const candidate of discovery.candidates) discoveredUrls.add(candidate.url)
      for (const error of discovery.errors) recordResearchError(errors, { error })

      const candidates = rankSerpCandidates(discovered, searchQueries, maxAttempts)
        .map((candidate): ResearchCandidate => ({ ...candidate, sourceKind: 'search' }))
      await drainCandidates(candidates)
    }

    notifyProgress(onProgress, {
      stage: 'finalizing',
      message: `Finalizing ${pages.length} verified ${pages.length === 1 ? 'page' : 'pages'}…`,
      pagesAttempted: pageAttempts,
      pagesVerified: pages.length,
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
      pageCacheHits,
      staticFetchAttempts,
      staticFetchHits,
      staticFetchSkipped,
      staticFetchTimeouts,
      staticFetchMs,
      browserPageLoads,
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
      discoveredUrls: [...discoveredUrls].slice(0, 10),
      discoveredCount: discoveredUrls.size,
      ...(discoveredUrls.size > 10 ? { discoveredTruncated: true } : {}),
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
        partition: researchPartition
      }
    })
    this.searchViews.add(view)
    return view
  }

  private async searchHiddenInParallel(
    queries: string[],
    maxResults: number,
    signal: AbortSignal,
    onProgress?: (progress: ResearchProgress) => void,
    onLaneCandidates?: (candidates: SerpCandidate[]) => void
  ): Promise<{
    candidates: SerpCandidate[]
    errors: string[]
    durationMs: number
    searchesAttempted: number
    cacheHits: number
    navigation: NavigationMetrics
  }> {
    const startedAt = Date.now()
    const outcomes: SearchLaneOutcome[] = new Array(queries.length)
    let nextIndex = 0

    notifyProgress(onProgress, {
      stage: 'discovering',
      message: `Discovering source URLs in ${queries.length} hidden search ${queries.length === 1 ? 'lane' : 'lanes'}…`,
      queryCount: queries.length
    })

    const worker = async (): Promise<void> => {
      while (true) {
        throwIfAborted(signal)
        const index = nextIndex
        nextIndex += 1
        if (index >= queries.length) return
        const query = queries[index]
        const cacheKey = `${maxResults}:${query.toLowerCase()}`
        const cached = this.searchCache.get(cacheKey)
        if (cached && cached.expiresAt > Date.now()) {
          outcomes[index] = {
            query,
            cacheHit: true,
            candidates: cached.candidates.map((candidate) => ({ ...candidate, query }))
          }
          notifyLaneCandidates(onLaneCandidates, outcomes[index].candidates)
          continue
        }

        const view = this.createHiddenView()
        try {
          const navigation = await loadSearchPage(view.webContents, googleSearchUrl(query, maxResults), signal)
          const serp = await evaluate<Array<Omit<SerpCandidate, 'query'>>>(
            view.webContents,
            buildSerpExtractionProgram(maxResults)
          )
          this.searchCache.set(cacheKey, {
            expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
            candidates: serp
          })
          outcomes[index] = {
            query,
            cacheHit: false,
            navigation,
            candidates: serp.map((candidate) => ({ ...candidate, query }))
          }
          notifyLaneCandidates(onLaneCandidates, outcomes[index].candidates)
        } catch (error) {
          if (signal.aborted) throw error
          outcomes[index] = {
            query,
            cacheHit: false,
            candidates: [],
            error: `Hidden search lane failed for "${query}": ${formatError(error)}`
          }
        } finally {
          this.closeHiddenView(view)
        }
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(SEARCH_WORKER_CONCURRENCY, queries.length) },
      () => worker()
    ))

    const navigation = createNavigationMetrics()
    for (const outcome of outcomes) {
      if (outcome?.navigation) recordNavigation(navigation, outcome.navigation)
    }
    notifyProgress(onProgress, {
      stage: 'discovering',
      message: `Ranked destination URLs from ${queries.length} hidden search ${queries.length === 1 ? 'lane' : 'lanes'}…`,
      queryIndex: queries.length,
      queryCount: queries.length
    })

    return {
      candidates: outcomes.flatMap((outcome) => outcome?.candidates ?? []),
      errors: outcomes.flatMap((outcome) => outcome?.error ? [outcome.error] : []),
      durationMs: Date.now() - startedAt,
      searchesAttempted: outcomes.length,
      cacheHits: outcomes.filter((outcome) => outcome?.cacheHit).length,
      navigation
    }
  }

  private readPageCache(url: string): ExtractedResearchPage | null {
    return this.pageCache.get(url)
  }

  private cachePage(url: string, page: ExtractedResearchPage): void {
    this.pageCache.set(url, page)
  }

  private closeHiddenView(view: WebContentsView): void {
    this.searchViews.delete(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
}

async function assertPublicResearchUrl(url: string, signal: AbortSignal): Promise<string> {
  const normalized = normalizeResearchUrls([url], 1)[0]
  if (!normalized) throw new Error('page verification failed: invalid or non-public URL')
  const host = new URL(normalized).hostname.replace(/^\[|\]$/g, '')
  if (isPublicResearchAddress(host)) return normalized

  const browserSession = session.fromPartition(researchPartition)
  const resolutions = await Promise.allSettled([
    browserSession.resolveHost(host, { queryType: 'A' }),
    browserSession.resolveHost(host, { queryType: 'AAAA' })
  ])
  throwIfAborted(signal)
  const addresses = resolutions.flatMap((resolution) =>
    resolution.status === 'fulfilled' ? resolution.value.endpoints.map(({ address }) => address) : []
  )
  if (addresses.length === 0) throw new Error(`page verification failed: could not resolve ${host}`)
  const blocked = addresses.find((address) => !isPublicResearchAddress(address))
  if (blocked) throw new Error(`page verification failed: ${host} resolved to a non-public address`)
  return normalized
}

async function loadSearchPage(
  webContents: Electron.WebContents,
  url: string,
  signal: AbortSignal
): Promise<PageNavigationResult> {
  return loadPageAndSettle(webContents, url, {
    timeoutMs: PAGE_TIMEOUT_MS,
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
    signal,
    allowRedirect: allowResearchRedirect
  })
}

async function evaluate<T>(webContents: Electron.WebContents, code: string): Promise<T> {
  return executePageJavaScript(webContents, `(async () => { ${code}\n})()`) as Promise<T>
}

function isLikelyLoadingContent(content: string): boolean {
  return /^(?:loading(?:\.{1,3})?|please wait(?:\.{1,3})?|fetching|initializing|preparing|content is loading|skeleton|shimmer)/i.test(content.trim())
}

async function waitForResearchContent(webContents: Electron.WebContents): Promise<boolean> {
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
      return text.length >= 500 && !loadingShell(text) && !busy;
    };
    const tick = () => {
      if (useful()) return finish(true);
      if (performance.now() - startedAt >= 1500) finish(false);
    };
    observer = new MutationObserver(tick);
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    timer = setInterval(tick, 50);
    tick();
  })`) as Promise<boolean>
}

function clamp(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function formatError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

// A page that verified as real content but added nothing toward the remaining
// focus needs previously vanished silently, leaving "N attempted, 0 verified"
// with no explanation in the result.
function recordFocusMismatch(errors: Array<{ url?: string; error: string }>, url: string): void {
  recordResearchError(errors, {
    url,
    error: 'page verified as real content but did not match the remaining focus needs'
  })
}

function recordResearchError(
  errors: Array<{ url?: string; error: string }>,
  value: { url?: string; error: string }
): void {
  if (errors.length >= 8) return
  errors.push({
    ...(value.url ? { url: value.url.slice(0, 2_048) } : {}),
    error: value.error.slice(0, 500)
  })
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}

function allowResearchRedirect(fromValue: string, toValue: string): boolean {
  const from = normalizeResearchUrls([fromValue], 1)[0]
  const to = normalizeResearchUrls([toValue], 1)[0]
  if (!from || !to) return false
  const fromHost = new URL(from).hostname.replace(/^www\./, '')
  const toHost = new URL(to).hostname.replace(/^www\./, '')
  return fromHost === toHost
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('research run aborted')
}

function notifyLaneCandidates(
  onLaneCandidates: ((candidates: SerpCandidate[]) => void) | undefined,
  candidates: SerpCandidate[]
): void {
  try {
    onLaneCandidates?.(candidates)
  } catch {
    // Early-candidate delivery is observational and must never fail a lane.
  }
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

function mergeNavigation(metrics: NavigationMetrics, addition: NavigationMetrics): void {
  metrics.count += addition.count
  metrics.domReadyMs += addition.domReadyMs
  metrics.settleMs += addition.settleMs
  for (const [reason, count] of Object.entries(addition.settleReasons)) {
    metrics.settleReasons[reason] = (metrics.settleReasons[reason] ?? 0) + count
  }
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
