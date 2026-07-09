export function googleSearchUrl(query: string, maxResults: number): string {
  return `https://www.google.com/search?num=${maxResults * 2}&q=${encodeURIComponent(query)}`
}

export function buildSerpExtractionProgram(maxResults: number): string {
  return `
  const maxResults = ${maxResults};
  const seen = new Set();
  const results = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    let url;
    try {
      const candidate = new URL(anchor.href, location.href);
      url = candidate.pathname === '/url' ? candidate.searchParams.get('q') : candidate.href;
    } catch {
      continue;
    }
    if (!url || !/^https?:\\/\\//i.test(url)) continue;
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (/google\\.com$/i.test(parsed.hostname) || /(^|\\.)google\\./i.test(parsed.hostname)) continue;
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    const title = (anchor.innerText || anchor.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!title || title.length < 3) continue;
    results.push({ url: parsed.href, title });
    if (results.length >= maxResults) break;
  }
  return results;
`
}
