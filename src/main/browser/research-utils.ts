const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'about', 'be', 'by', 'for', 'from', 'how', 'in', 'is',
  'it', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'which', 'who',
  'with'
])

const VIDEO_HOSTS = new Set(['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv', 'tiktok.com'])
const COMMUNITY_HOSTS = new Set(['reddit.com', 'quora.com', 'facebook.com', 'x.com', 'twitter.com', 'linkedin.com'])

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

export function googleSearchUrl(query: string, maxResults: number): string {
  return `https://www.google.com/search?num=${maxResults * 2}&q=${encodeURIComponent(query)}`
}

/**
 * Keep model-authored variants when present, but make a single-query call
 * useful without asking Codex to spend another turn inventing variants.
 */
export function buildResearchQueryVariants(queries: string[], maxVariants = 3): string[] {
  const supplied = uniqueStrings(queries)
  if (supplied.length >= maxVariants) return supplied.slice(0, maxVariants)

  const seed = supplied[0]
  if (!seed) return []

  const additions = /\b(review|compare|comparison|best|rating|overall|opinion|versus|vs\.)\b/i.test(seed)
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
    if (seen.has(normalizedUrl)) continue;
    const card = anchor.closest('div.MjjYud, div.g, [data-snhf], [data-hveid]') || anchor.parentElement;
    const title = (heading.innerText || heading.textContent || '').replace(/\\s+/g, ' ').trim();
    const snippetNode = card?.querySelector('.VwiC3b, [data-sncf], .yXK7lf, .kb0PBd');
    const snippet = (snippetNode?.innerText || snippetNode?.textContent || '').replace(/\\s+/g, ' ').trim();
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
  const deduped = new Map<string, RankedSerpCandidate>()

  for (const candidate of candidates) {
    const normalizedUrl = canonicalizeUrl(candidate.url)
    if (!normalizedUrl) continue

    const parsed = new URL(normalizedUrl)
    const title = candidate.title.trim()
    const snippet = candidate.snippet.trim()
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
      sourceBonus(source) +
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
    if (left.sourceTier !== right.sourceTier) return sourceBonus(right.sourceTier) - sourceBonus(left.sourceTier)
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

function classifySource(
  domain: string,
  pathname: string,
  title: string,
  queryTokens: string[]
): RankedSerpCandidate['sourceTier'] {
  if ([...VIDEO_HOSTS].some((host) => domain === host || domain.endsWith(`.${host}`)) || /\/(watch|video|videos|shorts|live)(\/|$)/i.test(pathname)) return 'video'
  if ([...COMMUNITY_HOSTS].some((host) => domain === host || domain.endsWith(`.${host}`))) return 'community'
  if (/\.(gov|mil|edu)$/i.test(domain) || /(^|\.)((docs?|developer|support|learn|help|api)\.)/i.test(domain)) return 'official'
  if (/\/(docs?|developer|reference|api|spec|standards?)\b/i.test(pathname) || /\bofficial\b/i.test(title)) return 'primary'
  if (distinctiveDomainMatch(domain, queryTokens) >= 8) return 'primary'
  return 'general'
}

function sourceBonus(source: RankedSerpCandidate['sourceTier']): number {
  return { official: 30, primary: 16, general: 0, community: -10, video: -24 }[source]
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
