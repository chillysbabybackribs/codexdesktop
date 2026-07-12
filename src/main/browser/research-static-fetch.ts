import { parseHTML } from 'linkedom'
import { buildPageExtractionProgram } from './browser-agent.js'
import { assessExtractedPage } from './research-utils.js'

const DEFAULT_MAX_BYTES = 2_000_000
const DEFAULT_MAX_REDIRECTS = 5
const STATIC_ARTIFACT_CHARS = 100_000
const MIN_STATIC_WORDS = 80
const MIN_STATIC_CONTENT_CHARS = 500

export type StaticResearchPage = {
  title: string
  url: string
  content: string
  wordCount: number
  status: number
  truncated: boolean
  html: string
}

export type StaticResearchResult = {
  kind: 'accepted' | 'fallback' | 'blocked'
  page?: StaticResearchPage
  reason?: string
  durationMs: number
  bytes: number
  redirects: number
  finalUrl?: string
}

export type StaticResearchFetchOptions = {
  fetch: (
    url: string,
    init: RequestInit & { bypassCustomProtocolHandlers?: boolean }
  ) => Promise<Response>
  validateUrl: (url: string, signal: AbortSignal) => Promise<string>
  signal: AbortSignal
  maxBytes?: number
  maxRedirects?: number
}

const runStaticExtraction = new Function(
  'document',
  'location',
  'Node',
  buildPageExtractionProgram(STATIC_ARTIFACT_CHARS)
) as (document: unknown, location: { href: string }, node: unknown) => Omit<StaticResearchPage, 'html' | 'status'> & {
  status?: number
}

export async function fetchStaticResearchPage(
  initialUrl: string,
  options: StaticResearchFetchOptions
): Promise<StaticResearchResult> {
  const startedAt = Date.now()
  const maxBytes = clamp(options.maxBytes, DEFAULT_MAX_BYTES, 100_000, 5_000_000)
  const maxRedirects = clamp(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, 8)
  let bytes = 0
  let redirects = 0
  let currentUrl = initialUrl

  try {
    currentUrl = await options.validateUrl(initialUrl, options.signal)
  } catch (error) {
    if (options.signal.aborted) throw error
    return result('blocked', startedAt, bytes, redirects, formatError(error), currentUrl)
  }

  while (true) {
    throwIfAborted(options.signal)
    let response: Response
    try {
      response = await options.fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'include',
        signal: options.signal,
        bypassCustomProtocolHandlers: true,
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9' }
      })
    } catch (error) {
      if (options.signal.aborted) throw error
      return result('fallback', startedAt, bytes, redirects, `static fetch failed: ${formatError(error)}`, currentUrl)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return result('fallback', startedAt, bytes, redirects, 'redirect response has no location', currentUrl)
      if (redirects >= maxRedirects) return result('fallback', startedAt, bytes, redirects, 'redirect limit exceeded', currentUrl)
      let redirectUrl: string
      try {
        redirectUrl = new URL(location, currentUrl).href
        currentUrl = await options.validateUrl(redirectUrl, options.signal)
      } catch (error) {
        if (options.signal.aborted) throw error
        return result('blocked', startedAt, bytes, redirects, `redirect blocked: ${formatError(error)}`, currentUrl)
      }
      redirects += 1
      continue
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!/^text\/html\b|^application\/xhtml\+xml\b/.test(contentType)) {
      return result('fallback', startedAt, bytes, redirects, `unsupported static content type: ${contentType || 'unknown'}`, currentUrl)
    }
    const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1]?.replace(/["']/g, '').toLowerCase()
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
      return result('fallback', startedAt, bytes, redirects, `unsupported static charset: ${charset}`, currentUrl)
    }

    const body = await readBoundedBody(response, maxBytes, options.signal)
    bytes = body.bytes
    if (body.tooLarge) return result('fallback', startedAt, bytes, redirects, 'static response exceeded byte limit', currentUrl)
    if (body.text === null) return result('fallback', startedAt, bytes, redirects, 'static response has no body', currentUrl)

    try {
      const { document, Node } = parseHTML(body.text)
      if (!document.querySelector('article, main, [role="main"], [itemprop="articleBody"]')) {
        return result('fallback', startedAt, bytes, redirects, 'static document has no confident content root', currentUrl)
      }
      const extracted = runStaticExtraction(document, { href: currentUrl }, Node)
      const page: StaticResearchPage = {
        ...extracted,
        url: currentUrl,
        status: response.status,
        html: body.text
      }
      const assessment = assessExtractedPage(page)
      if (!assessment.verified) {
        return result('fallback', startedAt, bytes, redirects, `static verification failed: ${assessment.reason}`, currentUrl)
      }
      if (page.wordCount < MIN_STATIC_WORDS || page.content.length < MIN_STATIC_CONTENT_CHARS) {
        return result('fallback', startedAt, bytes, redirects, 'static extraction confidence is too low', currentUrl)
      }
      return {
        kind: 'accepted',
        page,
        durationMs: Date.now() - startedAt,
        bytes,
        redirects,
        finalUrl: currentUrl
      }
    } catch (error) {
      if (options.signal.aborted) throw error
      return result('fallback', startedAt, bytes, redirects, `static extraction failed: ${formatError(error)}`, currentUrl)
    }
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<{ text: string | null; bytes: number; tooLarge: boolean }> {
  if (!response.body) return { text: null, bytes: 0, tooLarge: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      throwIfAborted(signal)
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel('research response exceeded byte limit')
        return { text: null, bytes, tooLarge: true }
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(combined), bytes, tooLarge: false }
}

function result(
  kind: StaticResearchResult['kind'],
  startedAt: number,
  bytes: number,
  redirects: number,
  reason: string,
  finalUrl: string
): StaticResearchResult {
  return { kind, reason: reason.slice(0, 300), durationMs: Date.now() - startedAt, bytes, redirects, finalUrl }
}

function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('static research fetch aborted')
}
