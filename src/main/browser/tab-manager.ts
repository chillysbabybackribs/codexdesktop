import { BrowserWindow, WebContentsView, shell } from 'electron'
import type { WebContents } from 'electron'
import type { BrowserBounds, BrowserState, BrowserTabState } from '../../shared/ipc.js'
import type { SavedBrowserState, SavedBrowserTab } from './browser-state-types.js'
import { MAX_SAVED_BROWSER_TABS } from './browser-state-types.js'
import { attachPopupWindowHandling } from './browser-popups.js'
import { browserPartition, chromeLikeUserAgent } from './browser-session.js'
import { normalizeNavigationInput } from './url-utils.js'

const defaultTabUrl = 'https://www.google.com'

type BrowserStateListener = (state: BrowserState) => void

type BrowserTab = {
  id: string
  view: WebContentsView
  title: string
  url: string
  favicon: string | null
  isLoading: boolean
}

const hiddenBounds: BrowserBounds = { x: -10000, y: -10000, width: 10, height: 10 }

export class TabManager {
  private readonly tabs = new Map<string, BrowserTab>()
  private activeTabId: string | null = null
  private bounds: BrowserBounds = hiddenBounds
  private isDraggingDivider = false
  // The native browser view sits above all renderer DOM, so a renderer overlay
  // (settings modal, etc.) can't cover it with z-index — we hide the view while
  // an overlay is open, the same trick used during a divider drag.
  private isOverlayOpen = false
  private stateListener: BrowserStateListener | null = null
  private persistListener: (() => void) | null = null

  constructor(private readonly window: BrowserWindow) {}

  onState(listener: BrowserStateListener): void {
    this.stateListener = listener
    this.pushState()
  }

  onPersist(listener: () => void): void {
    this.persistListener = listener
  }

  createInitialTab(): void {
    this.createTab(defaultTabUrl)
  }

  async restoreFromSnapshot(state: SavedBrowserState): Promise<void> {
    const savedTabs = state.tabs.slice(0, MAX_SAVED_BROWSER_TABS)

    for (const savedTab of savedTabs) {
      await this.createTabFromSaved(savedTab)
    }

    const tabIds = Array.from(this.tabs.keys())
    const activeTabId = tabIds[Math.min(Math.max(state.activeTabIndex, 0), tabIds.length - 1)]

    if (activeTabId) {
      this.activateTab(activeTabId)
    }

    this.pushState()
  }

  captureSnapshot(): SavedBrowserState | null {
    this.removeDeadTabs()

    if (this.tabs.size === 0) {
      return null
    }

    const tabIds = Array.from(this.tabs.keys())
    const tabs = tabIds
      .map((id) => this.tabs.get(id))
      .filter((tab): tab is BrowserTab => tab !== undefined)
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

    if (tabs.length === 0) {
      return null
    }

    const activeTabIndex = this.activeTabId ? tabIds.indexOf(this.activeTabId) : 0

    return {
      version: 1,
      activeTabIndex: clampIndex(activeTabIndex, tabs.length),
      tabs
    }
  }

  createTab(url = defaultTabUrl, options: { load?: boolean } = {}): string {
    const id = crypto.randomUUID()
    const view = this.createView()

    view.setBorderRadius?.(12)
    view.setBounds(this.activeTabId ? hiddenBounds : this.bounds)
    this.window.contentView.addChildView(view)

    const tab: BrowserTab = {
      id,
      view,
      title: 'New Tab',
      url,
      favicon: null,
      isLoading: false
    }

    this.tabs.set(id, tab)
    this.attachEvents(tab)
    this.activateTab(id)
    if (options.load !== false) {
      void view.webContents.loadURL(normalizeNavigationInput(url), { userAgent: chromeLikeUserAgent() })
    }
    this.pushState()
    return id
  }

  private async createTabFromSaved(saved: SavedBrowserTab): Promise<string> {
    const id = crypto.randomUUID()
    const view = this.createView()

    view.setBorderRadius?.(12)
    view.setBounds(hiddenBounds)
    this.window.contentView.addChildView(view)

    const tab: BrowserTab = {
      id,
      view,
      title: saved.title || 'New Tab',
      url: saved.url,
      favicon: saved.favicon ?? null,
      isLoading: true
    }

    this.tabs.set(id, tab)
    this.attachEvents(tab)

    try {
      const safeEntries = saved.entries.filter((entry) => isSafeNavigationUrl(entry.url))

      if (safeEntries.length > 0) {
        const activeIndex = clampIndex(saved.activeIndex, safeEntries.length)
        await view.webContents.navigationHistory.restore({
          entries: safeEntries,
          index: activeIndex
        })
        tab.url = view.webContents.getURL() || safeEntries[activeIndex]?.url || saved.url
        tab.title = view.webContents.getTitle() || tab.url || 'New Tab'
      } else if (isSafeNavigationUrl(saved.url)) {
        await view.webContents.loadURL(saved.url, { userAgent: chromeLikeUserAgent() })
        tab.url = view.webContents.getURL() || saved.url
        tab.title = view.webContents.getTitle() || tab.url || 'New Tab'
      } else {
        await view.webContents.loadURL(defaultTabUrl, { userAgent: chromeLikeUserAgent() })
        tab.url = defaultTabUrl
        tab.title = 'New Tab'
      }
    } catch {
      const fallbackUrl = isSafeNavigationUrl(saved.url) ? saved.url : defaultTabUrl
      await view.webContents.loadURL(fallbackUrl, { userAgent: chromeLikeUserAgent() })
      tab.url = view.webContents.getURL() || fallbackUrl
      tab.title = view.webContents.getTitle() || tab.url || 'New Tab'
    } finally {
      tab.isLoading = false
    }

    return id
  }

  private createView(): WebContentsView {
    return new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: browserPartition
      }
    })
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id)

    if (!tab) {
      return
    }

    this.window.contentView.removeChildView(tab.view)

    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close()
    }

    this.tabs.delete(id)

    if (this.activeTabId === id) {
      const next = this.tabs.keys().next().value as string | undefined
      this.activeTabId = null

      if (next) {
        this.activateTab(next)
      } else {
        this.createTab()
      }
    }

    this.pushState()
  }

  activateTab(id: string): void {
    if (!this.tabs.has(id)) {
      return
    }

    for (const tab of this.tabs.values()) {
      tab.view.setBounds(hiddenBounds)
    }

    this.activeTabId = id
    this.syncActiveBounds()
    this.pushState()
  }

  navigate(id: string, input: string): void {
    const tab = this.tabs.get(id)

    if (!tab) {
      return
    }

    void tab.view.webContents.loadURL(normalizeNavigationInput(input), { userAgent: chromeLikeUserAgent() })
  }

  async navigateAndWait(id: string, input: string, timeoutMs = 15_000): Promise<void> {
    const tab = this.tabs.get(id)

    if (!tab) {
      throw new Error(`no tab with id ${id}`)
    }

    const load = tab.view.webContents.loadURL(normalizeNavigationInput(input), {
      userAgent: chromeLikeUserAgent()
    })
    await withTimeout(load, timeoutMs)
  }

  goBack(id: string): void {
    const tab = this.tabs.get(id)
    const history = tab?.view.webContents.navigationHistory

    if (history?.canGoBack()) {
      history.goBack()
    }
  }

  goForward(id: string): void {
    const tab = this.tabs.get(id)
    const history = tab?.view.webContents.navigationHistory

    if (history?.canGoForward()) {
      history.goForward()
    }
  }

  reload(id: string): void {
    this.tabs.get(id)?.view.webContents.reload()
  }

  setBounds(bounds: BrowserBounds): void {
    this.bounds = sanitizeBounds(bounds)
    this.syncActiveBounds()
  }

  beginDividerDrag(): void {
    this.isDraggingDivider = true
    this.syncActiveBounds()
  }

  endDividerDrag(bounds: BrowserBounds): void {
    this.bounds = sanitizeBounds(bounds)
    this.isDraggingDivider = false
    this.syncActiveBounds()
  }

  setOverlayOpen(open: boolean): void {
    this.isOverlayOpen = open
    this.syncActiveBounds()
  }

  // The active view is on-screen only when nothing renderer-side needs the
  // browser region clear — a divider drag in progress, or an overlay covering it.
  private syncActiveBounds(): void {
    const hidden = this.isDraggingDivider || this.isOverlayOpen
    this.getActiveTab()?.view.setBounds(hidden ? hiddenBounds : this.bounds)
  }

  private attachEvents(tab: BrowserTab): void {
    const webContents = tab.view.webContents

    attachPopupWindowHandling(webContents, this.window)

    webContents.on('page-title-updated', (_event, title) => {
      tab.title = title || tab.url || 'New Tab'
      this.pushState()
    })

    webContents.on('page-favicon-updated', (_event, favicons) => {
      // Chromium emits the page's declared favicon URLs, best-first. Prefer the
      // first valid http(s)/data URL; anything else (file:, blob:) is unsafe to
      // render from the renderer origin, so fall back to the neutral glyph.
      console.log('[FAVICON-DBG] page-favicon-updated', tab.url, JSON.stringify(favicons), '-> picked', pickFavicon(favicons))
      tab.favicon = pickFavicon(favicons)
      this.pushState()
    })

    webContents.on('did-start-loading', () => {
      tab.isLoading = true
      this.pushState()
    })

    // Drop a stale favicon when navigating to a different document so the old
    // site's icon doesn't linger over the new page. In-page navigations (hash
    // changes, history.pushState) keep the current icon.
    webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace && tab.favicon !== null) {
        tab.favicon = null
        this.pushState()
      }
    })

    webContents.on('did-stop-loading', () => {
      tab.isLoading = false
      tab.url = webContents.getURL()
      tab.title = webContents.getTitle() || tab.url || 'New Tab'
      this.pushState()
    })

    webContents.on('did-navigate', (_event, url) => {
      tab.url = url
      this.pushState()
    })

    webContents.on('did-navigate-in-page', (_event, url) => {
      tab.url = url
      this.pushState()
    })

    webContents.on('did-fail-load', (_event, _errorCode, errorDescription, validatedURL) => {
      tab.isLoading = false
      tab.url = validatedURL || tab.url
      tab.title = errorDescription || tab.title
      this.pushState()
    })

    webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('file://')) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    })

    webContents.once('destroyed', () => {
      if (!this.tabs.has(tab.id)) {
        return
      }

      try {
        this.window.contentView.removeChildView(tab.view)
      } catch {
        // View may already be detached when OAuth popups self-close.
      }

      this.tabs.delete(tab.id)

      if (this.activeTabId === tab.id) {
        const next = this.tabs.keys().next().value as string | undefined
        this.activeTabId = null

        if (next) {
          this.activateTab(next)
        } else {
          this.createTab()
        }
      }

      this.pushState()
    })
  }

  private removeDeadTabs(): void {
    for (const [id, tab] of this.tabs) {
      if (!tab.view.webContents.isDestroyed()) {
        continue
      }

      try {
        this.window.contentView.removeChildView(tab.view)
      } catch {
        // Already removed.
      }

      this.tabs.delete(id)

      if (this.activeTabId === id) {
        this.activeTabId = null
      }
    }

    if (this.activeTabId && !this.tabs.has(this.activeTabId)) {
      this.activeTabId = null
    }

    if (!this.activeTabId && this.tabs.size > 0) {
      this.activateTab(this.tabs.keys().next().value as string)
    }
  }

  private getActiveTab(): BrowserTab | null {
    return this.activeTabId ? (this.tabs.get(this.activeTabId) ?? null) : null
  }

  // --- Agent control surface ---------------------------------------------
  // Public accessors used by the browser-control server so the Codex agent can
  // drive whichever tab it's targeting. Default target is the visible active
  // tab; an explicit id lets it reach any tab for multi-tab work.

  getActiveTabId(): string | null {
    return this.activeTabId
  }

  // Resolve the WebContents to run against. No id → the visible active tab.
  resolveWebContents(tabId?: string | null): WebContents | null {
    const tab = tabId ? this.tabs.get(tabId) : this.getActiveTab()
    const webContents = tab?.view.webContents

    if (!webContents || webContents.isDestroyed()) {
      return null
    }

    return webContents
  }

  // Flat list for the agent to discover targets before acting.
  listTabs(): Array<{ id: string; url: string; title: string; active: boolean }> {
    return Array.from(this.tabs.values()).map((tab) => ({
      id: tab.id,
      url: safeWebContentsUrl(tab.view.webContents) || tab.url,
      title: tab.title,
      active: tab.id === this.activeTabId
    }))
  }

  private pushState(): void {
    this.removeDeadTabs()

    this.stateListener?.({
      activeTabId: this.activeTabId,
      tabs: Array.from(this.tabs.values()).map((tab): BrowserTabState => {
        const navigation = readTabNavigation(tab)

        return {
          id: tab.id,
          title: tab.title,
          url: navigation.url || tab.url,
          favicon: tab.favicon,
          isLoading: tab.isLoading,
          canGoBack: navigation.canGoBack,
          canGoForward: navigation.canGoForward
        }
      })
    })
    this.persistListener?.()
  }
}

// Chromium reports favicon candidates best-first. Take the first that's safe to
// render from the renderer origin — http(s) or data URLs — and ignore the rest.
function pickFavicon(favicons: string[]): string | null {
  for (const candidate of favicons) {
    const lower = candidate.trim().toLowerCase()

    if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('data:image/')) {
      return candidate
    }
  }

  return null
}

function isSafeNavigationUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()

  return Boolean(url.trim()) && !lower.startsWith('javascript:') && !lower.startsWith('file:')
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0
  }

  if (!Number.isFinite(index)) {
    return length - 1
  }

  return Math.min(length - 1, Math.max(0, Math.round(index)))
}

function sanitizeBounds(bounds: BrowserBounds): BrowserBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  }
}

function readTabNavigation(tab: BrowserTab): {
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

function snapshotTabHistory(tab: BrowserTab): {
  url: string
  entries: SavedBrowserTab['entries']
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
    activeIndex: clampIndex(history.getActiveIndex(), entries.length)
  }
}

function safeWebContentsUrl(webContents: WebContents): string {
  if (webContents.isDestroyed()) {
    return ''
  }

  try {
    return webContents.getURL()
  } catch {
    return ''
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`navigation timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
