import type { NavigationEntry } from 'electron'
import type { SavedBrowserState, SavedBrowserTab } from './browser-state-types.js'
import { MAX_SAVED_BROWSER_TABS } from './browser-state-types.js'

export function sanitizeUrl(url: string): string | null {
  if (typeof url !== 'string') {
    return null
  }

  const trimmed = url.trim()

  if (!trimmed || trimmed === 'about:blank') {
    return null
  }

  const lower = trimmed.toLowerCase()

  if (lower.startsWith('javascript:') || lower.startsWith('file:')) {
    return null
  }

  return trimmed
}

export function sanitizeNavigationEntry(entry: NavigationEntry): NavigationEntry | null {
  const url = sanitizeUrl(entry.url)

  if (!url) {
    return null
  }

  return {
    url,
    title: typeof entry.title === 'string' ? entry.title : url,
    ...(typeof entry.pageState === 'string' ? { pageState: entry.pageState } : {})
  }
}

export function sanitizeSavedTab(tab: SavedBrowserTab): SavedBrowserTab | null {
  const entries = Array.isArray(tab.entries)
    ? tab.entries
        .map(sanitizeNavigationEntry)
        .filter((entry): entry is NavigationEntry => entry !== null)
    : []

  const fallbackUrl = sanitizeUrl(tab.url) ?? 'https://www.google.com'
  const activeIndex = clamp(tab.activeIndex ?? Math.max(entries.length - 1, 0), 0, Math.max(entries.length - 1, 0))

  if (entries.length === 0 && !sanitizeUrl(tab.url)) {
    return null
  }

  return {
    title: typeof tab.title === 'string' && tab.title.trim() ? tab.title : fallbackUrl,
    url: entries[activeIndex]?.url ?? fallbackUrl,
    favicon: sanitizeFavicon(tab.favicon),
    entries,
    activeIndex
  }
}

function sanitizeFavicon(favicon: unknown): string | null {
  if (typeof favicon !== 'string') {
    return null
  }

  const lower = favicon.trim().toLowerCase()

  if (lower.startsWith('https://') || lower.startsWith('data:image/')) {
    return favicon
  }

  return null
}

export function sanitizeBrowserState(state: SavedBrowserState): SavedBrowserState | null {
  const tabs = state.tabs
    .slice(0, MAX_SAVED_BROWSER_TABS)
    .map(sanitizeSavedTab)
    .filter((tab): tab is SavedBrowserTab => tab !== null)

  if (tabs.length === 0) {
    return null
  }

  return {
    version: 1,
    activeTabIndex: clamp(state.activeTabIndex, 0, tabs.length - 1),
    tabs
  }
}

export function parseSavedBrowserState(raw: string): SavedBrowserState | null {
  try {
    const parsed = JSON.parse(raw) as SavedBrowserState

    if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) {
      return null
    }

    return sanitizeBrowserState(parsed)
  } catch {
    return null
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }

  return Math.min(max, Math.max(min, Math.round(value)))
}
