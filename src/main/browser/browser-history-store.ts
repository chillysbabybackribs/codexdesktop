import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type HistoryEntry = {
  url: string
  title: string
  favicon: string | null
  visitCount: number
  lastVisitAt: number
}

const MAX_HISTORY_ENTRIES = 2000
const SAVE_DEBOUNCE_MS = 1000
const MAX_FAVICON_LENGTH = 128 * 1024

// Global visited-URL history powering omnibox autocomplete. Distinct from
// browser-state.json (session restore): entries survive tab close and carry
// visit counts + recency for frecency ranking. Only http(s) documents are
// recorded — internal, file, and data URLs never belong in suggestions.
export class BrowserHistoryStore {
  private entriesByUrl = new Map<string, HistoryEntry>()
  private faviconsBySite = new Map<string, string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saveQueue: Promise<void> = Promise.resolve()
  private loaded = false
  private readonly getFilePath: () => string

  constructor(getFilePath: () => string) {
    this.getFilePath = getFilePath
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.getFilePath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const entries = parseHistoryEntries(parsed)

      // Seed the site-level identity cache first, then hydrate legacy sibling
      // URLs from any favicon already known for that company host.
      for (const entry of entries) {
        const site = faviconSiteKey(entry.url)
        if (site && entry.favicon) {
          this.faviconsBySite.set(site, entry.favicon)
        }
      }

      for (const entry of entries) {
        const cachedFavicon = this.faviconsBySite.get(faviconSiteKey(entry.url) ?? '')
        if (cachedFavicon) {
          entry.favicon = cachedFavicon
        }
        this.entriesByUrl.set(entry.url, entry)
      }
    } catch {
      // Missing or corrupt file — start empty.
    } finally {
      this.loaded = true
    }
  }

  recordVisit(url: string, title: string, now = Date.now(), favicon: string | null = null): void {
    if (!isRecordableUrl(url)) {
      return
    }

    const existing = this.entriesByUrl.get(url)
    const site = faviconSiteKey(url)
    const safeFavicon = sanitizeHistoryFavicon(favicon)
    if (safeFavicon) {
      this.updateFavicon(url, safeFavicon)
    }
    const resolvedFavicon = safeFavicon ?? (site ? this.faviconsBySite.get(site) ?? null : null)

    if (existing) {
      existing.visitCount += 1
      existing.lastVisitAt = now
      if (title.trim()) {
        existing.title = title.trim()
      }
      if (resolvedFavicon) {
        existing.favicon = resolvedFavicon
      }
      // Re-insert so map order approximates recency, which prune() relies on.
      this.entriesByUrl.delete(url)
      this.entriesByUrl.set(url, existing)
    } else {
      this.entriesByUrl.set(url, {
        url,
        title: title.trim(),
        favicon: resolvedFavicon,
        visitCount: 1,
        lastVisitAt: now
      })
    }

    this.prune()
    this.scheduleSave()
  }

  // Titles usually arrive after did-navigate via page-title-updated; backfill
  // without counting another visit.
  updateTitle(url: string, title: string): void {
    const entry = this.entriesByUrl.get(url)

    if (entry && title.trim()) {
      entry.title = title.trim()
      this.scheduleSave()
    }
  }

  // Favicons often arrive after navigation and title events. Treat them as a
  // company-host identity so a restored Google tab, for example, refreshes
  // every google.com history URL rather than only one exact address.
  updateFavicon(url: string, favicon: string | null): void {
    const safeFavicon = sanitizeHistoryFavicon(favicon)
    const site = faviconSiteKey(url)

    if (!site || !safeFavicon || this.faviconsBySite.get(site) === safeFavicon) {
      return
    }

    this.faviconsBySite.set(site, safeFavicon)
    let changed = false
    for (const entry of this.entriesByUrl.values()) {
      if (faviconSiteKey(entry.url) === site && entry.favicon !== safeFavicon) {
        entry.favicon = safeFavicon
        changed = true
      }
    }

    if (changed) {
      this.scheduleSave()
    }
  }

  entries(): HistoryEntry[] {
    return Array.from(this.entriesByUrl.values())
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }

    await this.save()
  }

  private prune(): void {
    if (this.entriesByUrl.size <= MAX_HISTORY_ENTRIES) {
      return
    }

    const sorted = this.entries().sort((a, b) => b.lastVisitAt - a.lastVisitAt)
    this.entriesByUrl = new Map(sorted.slice(0, MAX_HISTORY_ENTRIES).map((entry) => [entry.url, entry]))
  }

  private scheduleSave(): void {
    if (!this.loaded || this.saveTimer) {
      return
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, SAVE_DEBOUNCE_MS)
  }

  private save(): Promise<void> {
    const filePath = this.getFilePath()
    const serialized = this.serialize()
    const operation = this.saveQueue.then(async () => {
      const temporaryPath = `${filePath}.tmp`
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(temporaryPath, serialized, 'utf8')
      await rename(temporaryPath, filePath)
    })
    // Keep later writes usable after a failure, but return the actual operation
    // so explicit flush callers can detect that persistence did not succeed.
    this.saveQueue = operation.catch(() => {})
    return operation
  }

  private serialize(): string {
    return `${JSON.stringify({ version: 1, entries: this.entries() })}\n`
  }
}

export function isRecordableUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  return lower.startsWith('https://') || lower.startsWith('http://')
}

function parseHistoryEntries(parsed: unknown): HistoryEntry[] {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    return []
  }

  const entries: HistoryEntry[] = []

  for (const candidate of (parsed as { entries: unknown[] }).entries) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }

    const { url, title, favicon, visitCount, lastVisitAt } = candidate as Record<string, unknown>

    if (typeof url !== 'string' || !isRecordableUrl(url)) {
      continue
    }

    entries.push({
      url,
      title: typeof title === 'string' ? title : '',
      favicon: sanitizeHistoryFavicon(favicon),
      visitCount: typeof visitCount === 'number' && Number.isFinite(visitCount) ? Math.max(1, Math.round(visitCount)) : 1,
      lastVisitAt: typeof lastVisitAt === 'number' && Number.isFinite(lastVisitAt) ? lastVisitAt : 0
    })
  }

  return entries
}

// Keep persisted history bounded and aligned with the tab favicon contract.
// Remote HTTP and arbitrary schemes are rejected before they cross into the
// sandboxed popup document.
export function sanitizeHistoryFavicon(favicon: unknown): string | null {
  if (typeof favicon !== 'string') {
    return null
  }

  const trimmed = favicon.trim()
  const lower = trimmed.toLowerCase()

  if (!trimmed || trimmed.length > MAX_FAVICON_LENGTH) {
    return null
  }

  if (lower.startsWith('https://') || lower.startsWith('data:image/')) {
    return trimmed
  }

  return null
}

function faviconSiteKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null
    }

    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    return host ? `${host}${parsed.port ? `:${parsed.port}` : ''}` : null
  } catch {
    return null
  }
}
