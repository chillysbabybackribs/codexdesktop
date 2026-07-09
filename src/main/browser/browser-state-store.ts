import { app } from 'electron'
import type { NavigationEntry } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type SavedBrowserTab = {
  title: string
  url: string
  entries: NavigationEntry[]
  activeIndex: number
}

export type SavedBrowserState = {
  version: 1
  activeTabIndex: number
  tabs: SavedBrowserTab[]
}

export const MAX_SAVED_BROWSER_TABS = 20

export class BrowserStateStore {
  private readonly filePath: string

  constructor() {
    this.filePath = join(app.getPath('userData'), 'browser-state.json')
  }

  async load(): Promise<SavedBrowserState | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as SavedBrowserState

      if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) {
        return null
      }

      const tabs = parsed.tabs
        .slice(0, MAX_SAVED_BROWSER_TABS)
        .map(sanitizeSavedTab)
        .filter((tab): tab is SavedBrowserTab => tab !== null)

      if (tabs.length === 0) {
        return null
      }

      const activeTabIndex = clamp(parsed.activeTabIndex ?? 0, 0, tabs.length - 1)

      return { version: 1, activeTabIndex, tabs }
    } catch {
      return null
    }
  }

  async save(state: SavedBrowserState): Promise<void> {
    const payload = this.sanitizeState(state)

    if (!payload) {
      return
    }

    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(payload)}\n`, 'utf8')
  }

  saveSync(state: SavedBrowserState): void {
    const payload = this.sanitizeState(state)

    if (!payload) {
      return
    }

    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, `${JSON.stringify(payload)}\n`, 'utf8')
  }

  private sanitizeState(state: SavedBrowserState): SavedBrowserState | null {
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
}

function sanitizeSavedTab(tab: SavedBrowserTab): SavedBrowserTab | null {
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
    entries,
    activeIndex
  }
}

function sanitizeNavigationEntry(entry: NavigationEntry): NavigationEntry | null {
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

function sanitizeUrl(url: string): string | null {
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }

  return Math.min(max, Math.max(min, Math.round(value)))
}
