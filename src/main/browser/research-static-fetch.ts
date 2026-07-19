import { extractStaticPage } from '../workers/static-extract-client.js'

// Byte limits bound network reads; parsing itself runs in a utility-process
// worker (Phase 5) so large documents cannot stall the application event loop.
// Larger-than-limit documents move directly to Chromium.
const DEFAULT_MAX_BYTES = 750_000
const DEFAULT_MAX_REDIRECTS = 5

export type StaticResearchPage = {
  title: string
  url: string
  content: string
  wordCount: number
  status: number
  truncated: boolean
  html: string
  mediaType: string
  extractionPath: 'static-html' | 'network-response'
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
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,application/json;q=0.9,application/graphql-response+json;q=0.9,application/x-ndjson;q=0.8,application/ndjson;q=0.8'
        }
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
    const responseKind = classifyResponseKind(contentType)
    if (responseKind === 'unsupported') {
      return result('fallback', startedAt, bytes, redirects, `unsupported static content type: ${contentType || 'unknown'}`, currentUrl)
    }
    const charset = /charset=([^;\s]+)/i.exec(contentType)?.[1]?.replace(/["']/g, '').toLowerCase()
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
      return result('fallback', startedAt, bytes, redirects, `unsupported static charset: ${charset}`, currentUrl)
    }

    let body: Awaited<ReturnType<typeof readBoundedBody>>
    try {
      body = await readBoundedBody(response, maxBytes, options.signal)
    } catch (error) {
      if (options.signal.aborted) throw error
      return result('fallback', startedAt, bytes, redirects, `static body read failed: ${formatError(error)}`, currentUrl)
    }
    bytes = body.bytes
    if (body.tooLarge) return result('fallback', startedAt, bytes, redirects, 'static response exceeded byte limit', currentUrl)
    if (body.text === null) return result('fallback', startedAt, bytes, redirects, 'static response has no body', currentUrl)

    try {
      const extraction = responseKind === 'html'
        ? await extractHtmlResearchPage(body.text, currentUrl, response.status, contentType)
        : extractStructuredResearchPage(body.text, currentUrl, response.status, contentType, responseKind)
      if (!extraction.page) {
        return result(
          'fallback',
          startedAt,
          bytes,
          redirects,
          extraction.reason,
          currentUrl
        )
      }
      const page = extraction.page
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

async function extractHtmlResearchPage(
  html: string,
  url: string,
  status: number,
  mediaType: string
): Promise<{ page: StaticResearchPage | null; reason: string }> {
  const extraction = await extractStaticPage(html, url)
  if (!extraction.ok) return { page: null, reason: extraction.reason }
  return {
    page: {
      ...extraction.page,
      status,
      html,
      mediaType,
      extractionPath: 'static-html'
    },
    reason: ''
  }
}

function extractStructuredResearchPage(
  body: string,
  url: string,
  status: number,
  mediaType: string,
  kind: 'json' | 'ndjson'
): { page: StaticResearchPage | null; reason: string } {
  let content: string
  try {
    if (kind === 'json') {
      content = JSON.stringify(JSON.parse(body), null, 2)
    } else {
      const records = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      if (records.length === 0) return { page: null, reason: 'structured response has no records' }
      content = records.map((record) => JSON.stringify(JSON.parse(record), null, 2)).join('\n')
    }
  } catch {
    return { page: null, reason: 'structured response is not valid JSON' }
  }
  const normalized = content.trim()
  const wordCount = normalized ? normalized.split(/\s+/).length : 0
  if (normalized.length < 240 || wordCount < 40) {
    return { page: null, reason: 'structured response confidence is too low' }
  }
  const title = structuredResponseTitle(url, kind)
  return {
    page: {
      title,
      url,
      content: normalized,
      wordCount,
      status,
      truncated: false,
      html: `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><pre>${escapeHtml(body)}</pre></body></html>`,
      mediaType,
      extractionPath: 'network-response'
    },
    reason: ''
  }
}

function classifyResponseKind(contentType: string): 'html' | 'json' | 'ndjson' | 'unsupported' {
  const mediaType = contentType.split(';', 1)[0]?.trim() ?? ''
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') return 'html'
  if (mediaType === 'application/x-ndjson' || mediaType === 'application/ndjson') return 'ndjson'
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return 'json'
  return 'unsupported'
}

function structuredResponseTitle(url: string, kind: 'json' | 'ndjson'): string {
  const parsed = new URL(url)
  const leaf = parsed.pathname.split('/').filter(Boolean).at(-1)
  return `${leaf || parsed.hostname} ${kind === 'ndjson' ? 'NDJSON' : 'JSON'} response`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character)
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
