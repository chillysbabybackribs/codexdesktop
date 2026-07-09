import { app, WebContentsView } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { browserPartition, chromeLikeUserAgent } from './browser-session.js'
import { buildPageExtractionProgram } from './browser-agent.js'
import { buildSerpExtractionProgram, googleSearchUrl } from './research-utils.js'

const DEFAULT_MAX_RESULTS = 5
const MAX_MAX_RESULTS = 10
const DEFAULT_MAX_PAGES = 5
const MAX_MAX_PAGES = 8
const DEFAULT_SNIPPET_CHARS = 3_500
const MAX_SNIPPET_CHARS = 8_000
const PAGE_TIMEOUT_MS = 15_000

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
  content: string
  wordCount: number
  artifactPath: string
  htmlPath: string
}

export type ResearchResult = {
  ok: boolean
  researchId?: string
  queries?: string[]
  artifactDir?: string
  pages?: ResearchPage[]
  discoveredUrls?: string[]
  errors?: Array<{ url?: string; error: string }>
  error?: string
}

type SerpResult = { url: string; title: string }

/**
 * A compact, deterministic research pipeline. Search results and pages stay
 * inside one unattached WebContentsView; Codex receives only extracted text
 * and filesystem pointers to the full artifacts.
 */
export class ResearchRunner {
  private view: WebContentsView | null = null
  private queue: Promise<void> = Promise.resolve()

  run(request: ResearchRequest): Promise<ResearchResult> {
    const operation = this.queue.then(() => this.execute(request))
    this.queue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  dispose(): void {
    const webContents = this.view?.webContents
    this.view = null

    if (webContents && !webContents.isDestroyed()) {
      webContents.close()
    }
  }

  private async execute(request: ResearchRequest): Promise<ResearchResult> {
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
    await mkdir(artifactDir, { recursive: true })

    const webContents = this.ensureView().webContents
    const discovered = new Map<string, SerpResult>()
    const errors: Array<{ url?: string; error: string }> = []

    for (const query of queries) {
      try {
        await loadPage(webContents, googleSearchUrl(query, maxResults))
        const serp = await evaluate<SerpResult[]>(webContents, buildSerpExtractionProgram(maxResults))
        for (const result of serp) {
          if (!discovered.has(result.url)) discovered.set(result.url, result)
        }
      } catch (error) {
        errors.push({ error: `SERP query failed for "${query}": ${formatError(error)}` })
      }
    }

    const pages: ResearchPage[] = []
    const candidates = [...discovered.values()].slice(0, maxPages)

    for (const [index, candidate] of candidates.entries()) {
      try {
        await loadPage(webContents, candidate.url)
        const extracted = await evaluate<{
          title: string
          url: string
          content: string
          wordCount: number
          truncated: boolean
        }>(webContents, buildPageExtractionProgram(snippetChars))
        const html = await evaluate<string>(webContents, 'return document.documentElement?.outerHTML || ""')
        const rank = index + 1
        const baseName = `page-${String(rank).padStart(2, '0')}`
        const artifactPath = join(artifactDir, `${baseName}.txt`)
        const htmlPath = join(artifactDir, `${baseName}.html`)
        await writeFile(artifactPath, `${extracted.content}\n`, 'utf8')
        await writeFile(htmlPath, html, 'utf8')
        pages.push({
          rank,
          url: extracted.url || candidate.url,
          title: extracted.title || candidate.title,
          content: extracted.content,
          wordCount: extracted.wordCount,
          artifactPath,
          htmlPath
        })
      } catch (error) {
        errors.push({ url: candidate.url, error: formatError(error) })
      }
    }

    return {
      ok: pages.length > 0,
      researchId,
      queries,
      artifactDir,
      discoveredUrls: [...discovered.keys()],
      pages,
      ...(errors.length > 0 ? { errors } : {}),
      ...(pages.length === 0 && errors.length === 0 ? { error: 'No qualifying pages found' } : {})
    }
  }

  private ensureView(): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) {
      return this.view
    }

    this.view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: browserPartition
      }
    })
    this.view.webContents.setUserAgent(chromeLikeUserAgent())
    return this.view
  }
}

async function loadPage(webContents: Electron.WebContents, url: string): Promise<void> {
  await withTimeout(webContents.loadURL(url, { userAgent: chromeLikeUserAgent() }), PAGE_TIMEOUT_MS)
}

async function evaluate<T>(webContents: Electron.WebContents, code: string): Promise<T> {
  return webContents.executeJavaScript(`(async () => { ${code}\n})()`, true) as Promise<T>
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`research operation timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function clamp(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
