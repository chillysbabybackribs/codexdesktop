import type { TraceSource } from './trace-types'

export function traceSources(finalResponse: string): TraceSource[] {
  const sources = new Map<string, TraceSource>()
  const markdownLink = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g
  for (const match of finalResponse.matchAll(markdownLink)) {
    addTraceSource(sources, match[2], match[1])
  }

  const bareUrl = /https?:\/\/[^\s<>"'`]+/g
  for (const match of finalResponse.matchAll(bareUrl)) {
    addTraceSource(sources, match[0])
  }
  return [...sources.values()]
}

function addTraceSource(sources: Map<string, TraceSource>, rawUrl: string | undefined, label?: string): void {
  if (!rawUrl) return
  const cleaned = rawUrl.replace(/[),.;:\]]+$/g, '')
  try {
    const parsed = new URL(cleaned)
    const url = parsed.toString()
    const existing = sources.get(url)
    if (existing && existing.label !== existing.host) return
    sources.set(url, {
      url,
      label: label?.trim() || parsed.hostname,
      host: parsed.hostname,
      kind: sourceKind(parsed)
    })
  } catch {
    // Ignore malformed URL-shaped text rather than polluting the source index.
  }
}

function sourceKind(url: URL): TraceSource['kind'] {
  if (url.hostname === 'electronjs.org' || url.hostname.endsWith('.electronjs.org')) return 'official'
  if (url.hostname === 'releases.electronjs.org') return 'official'
  if (url.hostname === 'github.com' && /\/electron\/electron\/(issues|discussions)\//.test(url.pathname)) return 'firsthand'
  if (url.hostname === 'github.com' && /\/electron\/electron\/(pull|commit|releases)\//.test(url.pathname)) return 'projectRecord'
  return 'other'
}
