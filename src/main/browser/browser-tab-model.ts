import type { WebContents, WebContentsView } from 'electron'
import type { BrowserBounds } from '../../shared/ipc.js'

export type ManagedBrowserTab = {
  id: string
  view: WebContentsView
  title: string
  url: string
  favicon: string | null
  isLoading: boolean
  isAudible: boolean
  isMuted: boolean
  // Session restore replays navigations; they are not user visits and must not
  // inflate history counts on every app start.
  suppressVisits: boolean
}

export const hiddenBrowserBounds: BrowserBounds = {
  x: -10000,
  y: -10000,
  width: 10,
  height: 10
}

export function clampTabIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0
  }

  if (!Number.isFinite(index)) {
    return length - 1
  }

  return Math.min(length - 1, Math.max(0, Math.round(index)))
}

export function sanitizeBrowserBounds(bounds: BrowserBounds): BrowserBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  }
}

export function fitBrowserBounds(
  bounds: BrowserBounds,
  containerWidth: number,
  containerHeight: number
): BrowserBounds {
  const sanitized = sanitizeBrowserBounds(bounds)
  const width = Math.max(1, Math.round(containerWidth))
  const height = Math.max(1, Math.round(containerHeight))
  const x = Math.min(sanitized.x, width - 1)
  const y = Math.min(sanitized.y, height - 1)

  return {
    x,
    y,
    width: Math.min(sanitized.width, width - x),
    height: Math.min(sanitized.height, height - y)
  }
}

export function safeWebContentsUrl(webContents: WebContents): string {
  if (webContents.isDestroyed()) {
    return ''
  }

  try {
    return webContents.getURL()
  } catch {
    return ''
  }
}

export function safeWebContentsTitle(webContents: WebContents): string {
  if (webContents.isDestroyed()) {
    return ''
  }

  try {
    return webContents.getTitle()
  } catch {
    return ''
  }
}

export function readTabNavigation(tab: ManagedBrowserTab): {
  url: string
  canGoBack: boolean
  canGoForward: boolean
} {
  const webContents = tab.view.webContents

  if (webContents.isDestroyed()) {
    return { url: tab.url, canGoBack: false, canGoForward: false }
  }

  const history = webContents.navigationHistory

  if (!history) {
    return {
      url: safeWebContentsUrl(webContents) || tab.url,
      canGoBack: false,
      canGoForward: false
    }
  }

  return {
    url: safeWebContentsUrl(webContents) || tab.url,
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward()
  }
}

export function nextActiveTabId(tabs: Iterable<ManagedBrowserTab>, removedActiveTabId: string): string | null {
  for (const tab of tabs) {
    if (tab.id !== removedActiveTabId) {
      return tab.id
    }
  }

  return null
}
