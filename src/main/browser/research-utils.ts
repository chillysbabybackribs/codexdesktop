import { isIP } from 'node:net'
import { parseHTML } from 'linkedom'

const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'about', 'be', 'by', 'for', 'from', 'how', 'in', 'is',
  'it', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'which', 'who',
  'with'
])

const VIDEO_HOSTS = new Set(['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv', 'tiktok.com'])
const COMMUNITY_HOSTS = new Set(['reddit.com', 'quora.com', 'facebook.com', 'x.com', 'twitter.com', 'linkedin.com'])
const MAX_RESEARCH_URL_CHARS = 2_048
const MAX_RESEARCH_RESULTS = 10

export type SerpCandidate = {
  url: string
  title: string
  snippet: string
  rank: number
  query: string
}

export type RankedSerpCandidate = SerpCandidate & {
  score: number
  domain: string
  sourceTier: 'official' | 'primary' | 'community' | 'video' | 'general'
}

export type ExtractedPageAssessment = {
  verified: boolean
  reason?: 'invalid-url' | 'http-error' | 'challenge-page' | 'login-page' | 'error-page' | 'insufficient-content'
}

/**
 * Some hosts serve a JS shell (or a login interstitial) to an anonymous
 * browser but keep a server-rendered mirror that extracts cleanly and even
 * satisfies the cheap static lane. Rewrite only the FETCH address — reporting
 * keeps whatever URL the page itself lands on.
 */
export function preferExtractableHost(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (host === 'www.reddit.com' || host === 'reddit.com') {
      parsed.hostname = 'old.reddit.com'
      return parsed.href
    }
  } catch {
    // Not a parseable URL; let downstream validation reject it.
  }
  return url
}

export function normalizeResearchUrls(values: unknown[], maxUrls = 8): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    if (value.trim().length > MAX_RESEARCH_URL_CHARS) continue
    const normalized = canonicalizeUrl(value.trim())
    if (!normalized || normalized.length > MAX_RESEARCH_URL_CHARS || seen.has(normalized)) continue
    const parsed = new URL(normalized)
    if (parsed.username || parsed.password || isObviousPrivateHost(parsed.hostname)) continue
    seen.add(normalized)
    urls.push(normalized)
    if (urls.length >= Math.max(1, Math.min(8, Math.round(maxUrls)))) break
  }
  return urls
}

export function isPublicResearchAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  const version = isIP(address)
  if (version === 4) return isPublicIpv4(address)
  if (version !== 6) return false

  const parts = parseIpv6(address)
  if (!parts) return false
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return isPublicIpv4(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`)
  }
  const first = parts[0]
  if (first < 0x2000 || first > 0x3fff) return false
  if (first === 0x2001 && parts[1] === 0x0db8) return false
  return true
}

export function googleSearchUrl(query: string, maxResults: number): string {
  return `https://www.google.com/search?num=${maxResults * 2}&q=${encodeURIComponent(query)}`
}

/**
 * DuckDuckGo's Lite surface is intentionally small, server rendered, and far
 * less coupled to a frequently changing result-page DOM than the full search
 * applications. Hidden discovery fetches this first and keeps Google as a
 * browser-rendered fallback for provider outages.
 */
export function duckDuckGoLiteSearchUrl(query: string): string {
  return `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
}

/** Bing's RSS surface is the independent no-script fallback for discovery. */
export function bingSearchFeedUrl(query: string, maxResults: number): string {
  return `https://www.bing.com/search?format=rss&count=${Math.max(2, maxResults * 2)}&q=${encodeURIComponent(query)}`
}

export function extractDuckDuckGoLiteCandidates(
  html: string,
  maxResults: number
): Array<Omit<SerpCandidate, 'query'>> {
  const { document } = parseHTML(html)
  const results: Array<Omit<SerpCandidate, 'query'>> = []
  const seen = new Set<string>()
  const limit = Math.max(1, Math.min(MAX_RESEARCH_RESULTS, Math.round(maxResults)))

  for (const anchor of document.querySelectorAll('a.result-link[href]')) {
    const href = anchor.getAttribute('href') ?? ''
    const url = duckDuckGoDestination(href)
    const title = compactText(anchor.textContent, 300)
    if (!url || !title || seen.has(url)) continue

    let snippet = ''
    let row = anchor.closest('tr')?.nextElementSibling ?? null
    for (let offset = 0; row && offset < 3; offset += 1, row = row.nextElementSibling) {
      if (row.querySelector('a.result-link[href]')) break
      const snippetNode = row.querySelector('.result-snippet')
      if (snippetNode) {
        snippet = compactText(snippetNode.textContent, 500)
        break
      }
    }

    seen.add(url)
    results.push({ url, title, snippet, rank: results.length + 1 })
    if (results.length >= limit) break
  }
  return results
}

export function extractBingSearchFeedCandidates(
  xml: string,
  maxResults: number
): Array<Omit<SerpCandidate, 'query'>> {
  const { document } = parseHTML(xml)
  const results: Array<Omit<SerpCandidate, 'query'>> = []
  const seen = new Set<string>()
  const limit = Math.max(1, Math.min(MAX_RESEARCH_RESULTS, Math.round(maxResults)))

  for (const item of document.querySelectorAll('item')) {
    const url = canonicalizeUrl(item.querySelector('link')?.textContent?.trim() ?? '')
    const title = compactText(item.querySelector('title')?.textContent ?? '', 300)
    const snippet = compactText(item.querySelector('description')?.textContent ?? '', 500)
    if (!url || !title || seen.has(url)) continue
    seen.add(url)
    results.push({ url, title, snippet, rank: results.length + 1 })
    if (results.length >= limit) break
  }
  return results
}

/**
 * Keep model-authored variants when present, but make a single-query call
 * useful without asking Codex to spend another turn inventing variants.
 */
export function buildResearchQueryVariants(queries: string[], maxVariants = 3): string[] {
  const supplied = uniqueStrings(queries)
  if (supplied.length !== 1) return supplied.slice(0, maxVariants)

  const seed = supplied[0]
  if (!seed) return []

  const additions = /\b(firsthand|experience|report|forum|reddit|discussion|issue)\b/i.test(seed)
    ? ['GitHub issues discussions', 'developer forum report']
    : /\b(review|compare|comparison|best|rating|overall|opinion|versus|vs\.)\b/i.test(seed)
      ? ['independent analysis', 'official source']
      : ['official documentation', 'technical details']

  return uniqueStrings([
    ...supplied,
    ...additions.map((addition) => `${seed} ${addition}`)
  ]).slice(0, maxVariants)
}

/**
 * Search engines expose many ordinary anchors around a result page. Restrict
 * extraction to anchors containing an h3 result title and read the snippet
 * from that result card, which keeps nav/footer/related links out.
 */
export function buildSerpExtractionProgram(maxResults: number): string {
  return `
  const maxResults = ${maxResults};
  const results = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href]');
  for (const anchor of anchors) {
    const heading = anchor.querySelector('h3');
    if (!heading) continue;
    let url;
    try {
      const candidate = new URL(anchor.href, location.href);
      url = candidate.pathname === '/url'
        ? (candidate.searchParams.get('q') || candidate.searchParams.get('url') || candidate.searchParams.get('u'))
        : candidate.href;
    } catch {
      continue;
    }
    if (!url || !/^https?:\\/\\//i.test(url)) continue;
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (/google\\.com$/i.test(parsed.hostname) || /(^|\\.)google\\./i.test(parsed.hostname)) continue;
    parsed.hash = '';
    const normalizedUrl = parsed.href;
    if (normalizedUrl.length > 2048) continue;
    if (seen.has(normalizedUrl)) continue;
    const card = anchor.closest('div.MjjYud, div.g, [data-snhf], [data-hveid]') || anchor.parentElement;
    const title = (heading.innerText || heading.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
    const snippetNode = card?.querySelector('.VwiC3b, [data-sncf], .yXK7lf, .kb0PBd');
    const snippet = (snippetNode?.innerText || snippetNode?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
    if (!title || title.length < 3) continue;
    seen.add(normalizedUrl);
    results.push({ url: normalizedUrl, title, snippet, rank: results.length + 1 });
    if (results.length >= maxResults) break;
  }
  return results;
`
}

export function rankSerpCandidates(candidates: SerpCandidate[], queries: string[], limit: number): RankedSerpCandidate[] {
  const queryTokens = uniqueStrings(queries.flatMap(tokenize))
  const preferCommunity = queries.some((query) => /\b(firsthand|experience|report|forum|reddit|discussion|issue|review|opinion)\b/i.test(query))
  const deduped = new Map<string, RankedSerpCandidate>()

  for (const candidate of candidates) {
    const normalizedUrl = canonicalizeUrl(candidate.url)
    if (!normalizedUrl) continue

    const parsed = new URL(normalizedUrl)
    const title = candidate.title.trim().slice(0, 300)
    const snippet = candidate.snippet.trim().slice(0, 500)
    const domain = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    const titleTokens = tokenize(title)
    const snippetTokens = tokenize(snippet)
    const titleMatches = countMatches(queryTokens, titleTokens)
    const snippetMatches = countMatches(queryTokens, snippetTokens)
    const exactPhrase = normalizedPhrase(title).includes(normalizedPhrase(queries.find((query) => query === candidate.query) || ''))
    const source = classifySource(domain, parsed.pathname, title, queryTokens)
    const score = Math.round(
      titleMatches * 24 +
      snippetMatches * 7 +
      (exactPhrase ? 22 : 0) +
      Math.max(0, 12 - candidate.rank) +
      sourceBonus(source, preferCommunity) +
      distinctiveDomainMatch(domain, queryTokens)
    )
    const ranked: RankedSerpCandidate = {
      ...candidate,
      url: normalizedUrl,
      title,
      snippet,
      score,
      domain,
      sourceTier: source
    }
    const previous = deduped.get(normalizedUrl)
    if (!previous || ranked.score > previous.score) deduped.set(normalizedUrl, ranked)
  }

  const sorted = [...deduped.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (left.sourceTier !== right.sourceTier) return sourceBonus(right.sourceTier, preferCommunity) - sourceBonus(left.sourceTier, preferCommunity)
    return left.rank - right.rank
  })

  const selected: RankedSerpCandidate[] = []
  const domainCounts = new Map<string, number>()
  for (const candidate of sorted) {
    const count = domainCounts.get(candidate.domain) || 0
    if (count >= 2 && selected.length + 2 < sorted.length && candidate.sourceTier === 'general') continue
    selected.push(candidate)
    domainCounts.set(candidate.domain, count + 1)
    if (selected.length >= limit) break
  }
  return selected
}

export function assessExtractedPage(page: {
  title: string
  url: string
  content: string
  wordCount: number
  status?: number
}): ExtractedPageAssessment {
  let url: URL
  try {
    url = new URL(page.url)
  } catch {
    return { verified: false, reason: 'invalid-url' }
  }
  if (!/^https?:$/.test(url.protocol)) return { verified: false, reason: 'invalid-url' }
  if (typeof page.status === 'number' && page.status >= 400) {
    return { verified: false, reason: 'http-error' }
  }

  // A challenge banner is often injected after the site header. Inspect a
  // bounded but meaningful sample rather than just the leading chrome.
  const sample = `${page.title}\n${page.content.slice(0, 12_000)}`.toLowerCase()
  if (/captcha|verify you are human|access denied|sign in to continue|checking your browser|just a moment/.test(sample)) {
    return { verified: false, reason: 'challenge-page' }
  }
  const normalizedTitle = page.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (/^(sign in|log in|login|authentication required)\b/.test(normalizedTitle)) {
    return { verified: false, reason: 'login-page' }
  }
  if (
    page.wordCount < 200 &&
    /^(404|403|500|502|503|page not found|not found|internal server error|bad gateway|service unavailable|deployment not found)\b/.test(normalizedTitle)
  ) {
    return { verified: false, reason: 'error-page' }
  }
  if (page.wordCount < 40 || page.content.trim().length < 240) {
    return { verified: false, reason: 'insufficient-content' }
  }
  if (isLoadingShell(page.content)) {
    return { verified: false, reason: 'insufficient-content' }
  }
  return { verified: true }
}

/**
 * True when a requested URL landed on a different host — the signature of a
 * cross-host redirect (docs domains moving into another product's docs app).
 * `www.` prefixes are not treated as a host change.
 */
export function isCrossHostLanding(requestedUrl: string, landedUrl: string): boolean {
  let requested: URL
  let landed: URL
  try {
    requested = new URL(requestedUrl)
    landed = new URL(landedUrl)
  } catch {
    return false
  }
  const normalize = (host: string): string => host.replace(/^www\./i, '').toLowerCase()
  return normalize(requested.hostname) !== normalize(landed.hostname)
}

const NAV_LINK_PATTERN = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi
const MAX_NAV_LINK_SCANS = 400

export type ResearchNavLink = { url: string; title: string }

/**
 * Harvest same-host navigation links from a landing page's HTML so a redirect
 * that dumps a deep docs URL onto a hub page can be followed one hop instead
 * of being reported as "bounded extraction found nothing." Deterministic and
 * bounded: same host as the landing page, http(s) only, fragments stripped,
 * deduplicated, first `limit` kept in document order.
 */
export function extractSameHostNavLinks(html: string, landedUrl: string, limit: number): ResearchNavLink[] {
  let base: URL
  try {
    base = new URL(landedUrl)
  } catch {
    return []
  }
  const maxLinks = Math.max(1, Math.min(24, Math.round(limit)))
  const normalizeHost = (host: string): string => host.replace(/^www\./i, '').toLowerCase()
  const baseHost = normalizeHost(base.hostname)
  const selfUrl = `${base.origin}${base.pathname}`
  const links: ResearchNavLink[] = []
  const seen = new Set<string>()
  NAV_LINK_PATTERN.lastIndex = 0
  let scans = 0
  let match: RegExpExecArray | null
  while ((match = NAV_LINK_PATTERN.exec(html)) !== null) {
    scans += 1
    if (scans > MAX_NAV_LINK_SCANS || links.length >= maxLinks) break
    const href = (match[1] ?? match[2] ?? '').trim()
    if (!href || href.startsWith('#')) continue
    let resolved: URL
    try {
      resolved = new URL(href, base)
    } catch {
      continue
    }
    if (!/^https?:$/.test(resolved.protocol)) continue
    if (normalizeHost(resolved.hostname) !== baseHost) continue
    const canonical = `${resolved.origin}${resolved.pathname}${resolved.search}`
    if (canonical === selfUrl || seen.has(canonical)) continue
    seen.add(canonical)
    const title = match[3]
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300)
    links.push({ url: canonical, title: title || resolved.pathname })
  }
  return links
}

function isLoadingShell(content: string): boolean {
  const lines = content
    .split(/\n+/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 120)
  if (lines.length === 0) return false
  const loadingLines = lines.filter((line) =>
    /^(?:loading(?:\.{1,3})?|please wait(?:\.{1,3})?|fetching|initializing|preparing|content is loading|skeleton|shimmer)/.test(line)
  ).length
  return loadingLines >= 2 && loadingLines / lines.length >= 0.6
}

function classifySource(
  domain: string,
  pathname: string,
  title: string,
  queryTokens: string[]
): RankedSerpCandidate['sourceTier'] {
  if ([...VIDEO_HOSTS].some((host) => domain === host || domain.endsWith(`.${host}`)) || /\/(watch|video|videos|shorts|live)(\/|$)/i.test(pathname)) return 'video'
  if (
    [...COMMUNITY_HOSTS].some((host) => domain === host || domain.endsWith(`.${host}`)) ||
    (domain === 'github.com' && /\/(issues|discussions|pull)(\/|$)/i.test(pathname))
  ) return 'community'
  if (/\.(gov|mil|edu)$/i.test(domain) || /(^|\.)((docs?|developer|support|learn|help|api)\.)/i.test(domain)) return 'official'
  if (/\/(docs?|developer|reference|api|spec|standards?)\b/i.test(pathname) || /\bofficial\b/i.test(title)) return 'primary'
  if (distinctiveDomainMatch(domain, queryTokens) >= 8) return 'primary'
  return 'general'
}

function sourceBonus(source: RankedSerpCandidate['sourceTier'], preferCommunity = false): number {
  if (source === 'community') return preferCommunity ? 20 : -10
  return { official: 30, primary: 16, general: 0, video: -24 }[source]
}

function distinctiveDomainMatch(domain: string, queryTokens: string[]): number {
  return queryTokens.some((token) => token.length >= 4 && domain.includes(token)) ? 8 : 0
}

function countMatches(needles: string[], haystack: string[]): number {
  const values = new Set(haystack)
  return needles.reduce((total, needle) => total + (values.has(needle) ? 1 : 0), 0)
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]{2,}/g)?.filter((token) => !QUERY_STOP_WORDS.has(token)) || []
}

function normalizedPhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function canonicalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    if (!/^https?:$/i.test(url.protocol)) return ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|ref$|source$)/i.test(key)) url.searchParams.delete(key)
    }
    return url.href
  } catch {
    return ''
  }
}

function duckDuckGoDestination(value: string): string {
  try {
    const link = new URL(value, 'https://lite.duckduckgo.com/')
    const host = link.hostname.replace(/^www\./i, '').toLowerCase()
    const destination = host === 'duckduckgo.com' && link.pathname === '/l/'
      ? link.searchParams.get('uddg') ?? ''
      : link.href
    return canonicalizeUrl(destination)
  } catch {
    return ''
  }
}

function compactText(value: string | null | undefined, maxChars: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function isObviousPrivateHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  return isIP(host) !== 0 && !isPublicResearchAddress(host)
}

function isPublicIpv4(value: string): boolean {
  const octets = value.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [first, second, third] = octets
  if (first === undefined || second === undefined || third === undefined) return false
  return !(first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third <= 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113))
}

function parseIpv6(value: string): number[] | null {
  if (value.split('::').length > 2) return null
  const [leftRaw = '', rightRaw = ''] = value.split('::')
  const left = parseIpv6Parts(leftRaw)
  const right = parseIpv6Parts(rightRaw)
  if (!left || !right) return null
  if (!value.includes('::')) return left.length === 8 ? left : null
  const missing = 8 - left.length - right.length
  if (missing < 1) return null
  return [...left, ...Array<number>(missing).fill(0), ...right]
}

function parseIpv6Parts(value: string): number[] | null {
  if (!value) return []
  const parts: number[] = []
  for (const part of value.split(':')) {
    if (part.includes('.')) {
      const octets = part.split('.').map(Number)
      if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
      parts.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
      continue
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null
    parts.push(Number.parseInt(part, 16))
  }
  return parts
}
