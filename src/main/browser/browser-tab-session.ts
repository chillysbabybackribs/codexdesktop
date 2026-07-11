import type { NavigationEntry } from 'electron'
import type { SavedBrowserState, SavedBrowserTab } from './browser-state-types.js'
import type { ManagedBrowserTab } from './browser-tab-model.js'
import { clampTabIndex, safeWebContentsTitle, safeWebContentsUrl } from './browser-tab-model.js'

export function captureBrowserSnapshot(
  tabs: Iterable<ManagedBrowserTab>,
  activeTabId: string | null
): SavedBrowserState | null {
  const tabList = Array.from(tabs)
  const savedTabs = tabList
    .map((tab) => {
      const snapshot = snapshotTabHistory(tab)

      if (!snapshot) {
        return null
      }

      return {
        title: tab.title,
        url: snapshot.url,
        favicon: tab.favicon,
        entries: snapshot.entries,
        activeIndex: snapshot.activeIndex
      } satisfies SavedBrowserTab
    })
    .filter((tab): tab is SavedBrowserTab => tab !== null)

  if (savedTabs.length === 0) {
    return null
  }

  const activeTabIndex = activeTabId ? tabList.findIndex((tab) => tab.id === activeTabId) : 0

  return {
    version: 1,
    activeTabIndex: clampTabIndex(activeTabIndex, savedTabs.length),
    tabs: savedTabs
  }
}

export async function hydrateSavedBrowserTab(
  tab: ManagedBrowserTab,
  saved: SavedBrowserTab,
  defaultUrl: string,
  navigate: (url: string) => Promise<void>
): Promise<void> {
  const webContents = tab.view.webContents

  try {
    const safeEntries = saved.entries.filter((entry) => isSafeNavigationUrl(entry.url))

    if (safeEntries.length > 0) {
      const activeIndex = clampTabIndex(saved.activeIndex, safeEntries.length)
      await webContents.navigationHistory.restore({
        entries: safeEntries,
        index: activeIndex
      })
      tab.url = safeWebContentsUrl(webContents) || safeEntries[activeIndex]?.url || saved.url
      tab.title = safeWebContentsTitle(webContents) || tab.url || 'New Tab'
    } else if (isSafeNavigationUrl(saved.url)) {
      await navigate(saved.url)
      tab.url = safeWebContentsUrl(webContents) || saved.url
      tab.title = safeWebContentsTitle(webContents) || tab.url || 'New Tab'
    } else {
      await navigate(defaultUrl)
      tab.url = defaultUrl
      tab.title = 'New Tab'
    }
  } catch {
    const fallbackUrl = isSafeNavigationUrl(saved.url) ? saved.url : defaultUrl
    await navigate(fallbackUrl)
    tab.url = safeWebContentsUrl(webContents) || fallbackUrl
    tab.title = safeWebContentsTitle(webContents) || tab.url || 'New Tab'
  } finally {
    tab.isLoading = false
    tab.suppressVisits = false
  }
}

export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      await worker(item)
    }
  })

  await Promise.all(runners)
}

function snapshotTabHistory(tab: ManagedBrowserTab): {
  url: string
  entries: NavigationEntry[]
  activeIndex: number
} | null {
  const webContents = tab.view.webContents

  if (webContents.isDestroyed()) {
    return null
  }

  const url = safeWebContentsUrl(webContents) || tab.url
  const history = webContents.navigationHistory

  if (!history) {
    if (!url || url === 'about:blank') {
      return null
    }

    return {
      url,
      entries: [{ url, title: tab.title || url }],
      activeIndex: 0
    }
  }

  const entries = history.getAllEntries()

  return {
    url,
    entries,
    activeIndex: clampTabIndex(history.getActiveIndex(), entries.length)
  }
}

function isSafeNavigationUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()

  return Boolean(url.trim()) && !lower.startsWith('javascript:') && !lower.startsWith('file:')
}
