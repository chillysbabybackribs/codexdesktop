import { app, WebContentsView } from 'electron'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { browserPartition, chromeLikeUserAgent } from './browser-session.js'
import { buildPageExtractionProgram } from './browser-agent.js'
import { loadPageAndSettle } from './page-navigation.js'
import {
  buildResearchQueryVariants,
  buildSerpExtractionProgram,
  googleSearchUrl,
  assessExtractedPage,
  rankSerpCandidates,
  type SerpCandidate
} from './research-utils.js'
import type { TabManager } from './tab-manager.js'

const DEFAULT_MAX_RESULTS = 5
const MAX_MAX_RESULTS = 10
const DEFAULT_MAX_PAGES = 3
const MAX_MAX_PAGES = 8
const DEFAULT_SNIPPET_CHARS = 3_500
const MAX_SNIPPET_CHARS = 8_000
const PAGE_TIMEOUT_MS = 15_000
const PAGE_WORKER_CONCURRENCY = 2
const MAX_HTML_CHARS = 2_000_000
const SEARCH_CACHE_TTL_MS = 10 * 60_000
const RESEARCH_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const RESEARCH_MAX_BYTES = 250 * 1024 * 1024

export type ResearchRequest = {
  queries: string[]
  maxResults?: number | null
  maxPages?: number | null
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
  errors?: Array<{ url?: string; error: string }>
  error?: string
}

/**
 * A compact, deterministic research pipeline. Discovery is cached and
 * serialized, qualifying pages use a bounded hidden worker pool, and the best
 * result is staged in one reusable visible tab after extraction completes.
 */
export class ResearchRunner {
  private readonly searchViews = new Set<WebContentsView>()
  private readonly activeRuns = new Map<string, AbortController>()
  private readonly searchCache = new Map<string, { expiresAt: number; candidates: Array<Omit<SerpCandidate, 'query'>> }>()
  private queue: Promise<void> = Promise.resolve()
  private stagingTabId: string | null = null

  constructor(private readonly getTabs: () => TabManager | null) {}

  run(request: ResearchRequest, runId: string = crypto.randomUUID()): Promise<ResearchResult> {
    const controller = new AbortController()
    this.activeRuns.set(runId, controller)
    const operation = this.queue.then(() => this.execute(request, controller.signal))
    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation.finally(() => {
      if (this.activeRuns.get(runId) === controller) this.activeRuns.delete(runId)
    })
  }

  cancel(runId: string): void {
    this.activeRuns.get(runId)?.abort()
  }

  dispose(): void {
    for (const controller of this.activeRuns.values()) controller.abort()
    this.activeRuns.clear()
    for (const view of this.searchViews) {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    this.searchViews.clear()
  }

  private async execute(request: ResearchRequest, signal: AbortSignal): Promise<ResearchResult> {
    const queries = request.queries
      .filter((query): query is string => typeof query === 'string' && query.trim().length > 0)
      .map((query) => query.trim())
      .slice(0, 3)

    if (queries.length === 0) {
      return { ok: false, error: 'research_web requires at least one non-empty query' }
    }

    const maxResults = clamp(request.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_MAX_RESULTS)
    const maxPages = clamp(request.maxPages, DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES)
    const snippetChars = clamp(request.snippetChars, DEFAULT_SNIPPET_CHARS, 1_000, MAX_SNIPPET_CHARS)
    const researchId = crypto.randomUUID()
    const artifactDir = join(app.getPath('userData'), 'research', researchId)
    await pruneResearchArtifacts(join(app.getPath('userData'), 'research'))
    await mkdir(artifactDir, { recursive: true })

    const searchQueries = buildResearchQueryVariants(queries)
    const discovered: SerpCandidate[] = []
    const errors: Array<{ url?: string; error: string }> = []

    const searchView = this.createHiddenView()
    try {
      for (const query of searchQueries) {
        throwIfAborted(signal)
        try {
          const cacheKey = `${maxResults}:${query.toLowerCase()}`
          const cached = this.searchCache.get(cacheKey)
          let serp: Array<Omit<SerpCandidate, 'query'>>

          if (cached && cached.expiresAt > Date.now()) {
            serp = cached.candidates
          } else {
            await loadPage(searchView.webContents, googleSearchUrl(query, maxResults), signal)
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
        }
      }
    } finally {
      this.closeHiddenView(searchView)
    }

    const candidates = rankSerpCandidates(discovered, searchQueries, maxPages)
    const tabs = this.getTabs()
    const pageResults = await mapWithConcurrency<typeof candidates[number], ResearchPage | null>(
      candidates,
      PAGE_WORKER_CONCURRENCY,
      async (candidate, index): Promise<ResearchPage | null> => {
        throwIfAborted(signal)
        const view = this.createHiddenView()
        try {
          await loadPage(view.webContents, candidate.url, signal)
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
          const rank = index + 1
          const baseName = `page-${String(rank).padStart(2, '0')}`
          const artifactPath = join(artifactDir, `${baseName}.txt`)
          const htmlPath = join(artifactDir, `${baseName}.html`)
          await writeFile(artifactPath, `${extracted.content}\n`, 'utf8')
          await writeFile(htmlPath, html, 'utf8')

          return {
            rank,
            url: extracted.url || candidate.url,
            title: extracted.title || candidate.title,
            wordCount: extracted.wordCount,
            artifactPath,
            htmlPath,
            sourceQuery: candidate.query,
            sourceTier: candidate.sourceTier,
            score: candidate.score
            ,verified: true
          } satisfies ResearchPage
        } catch (error) {
          if (signal.aborted) throw error
          errors.push({ url: candidate.url, error: formatError(error) })
          return null
        } finally {
          this.closeHiddenView(view)
        }
      }
    )
    const pages = pageResults.filter((page): page is ResearchPage => page !== null)
    const visibleTabId = pages.length > 0 && tabs
      ? this.stageBestPage(tabs, pages[0].url)
      : undefined

    if (visibleTabId) {
      for (const page of pages) page.visibleTabId = visibleTabId
    }

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

async function loadPage(webContents: Electron.WebContents, url: string, signal: AbortSignal): Promise<void> {
  await loadPageAndSettle(webContents, url, {
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('research run aborted')
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
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
