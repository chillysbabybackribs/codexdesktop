import { BrowserWindow, WebContentsView, shell } from 'electron'
import type { WebContents } from 'electron'
import type { BrowserBounds, BrowserState, BrowserTabState } from '../../shared/ipc.js'
import type { SavedBrowserState, SavedBrowserTab } from './browser-state-types.js'
import { MAX_SAVED_BROWSER_TABS } from './browser-state-types.js'
import { normalizeNavigationInput } from './url-utils.js'
import { isBlankPopupUrl, isUnsafePopupUrl } from './window-open-policy.js'

const browserPartition = 'persist:codex-browser'
const defaultTabUrl = 'https://www.google.com'

type BrowserStateListener = (state: BrowserState) => void

type BrowserTab = {
  id: string
  view: WebContentsView
  title: string
  url: string
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
    if (this.tabs.size === 0) {
      return null
    }

    const tabIds = Array.from(this.tabs.keys())
    const tabs = tabIds
      .map((id) => this.tabs.get(id))
      .filter((tab): tab is BrowserTab => tab !== undefined)
      .map((tab) => {
        const history = tab.view.webContents.navigationHistory
        const entries = history.getAllEntries()
        const activeIndex = clampIndex(history.getActiveIndex(), entries.length)

        return {
          title: tab.title,
          url: tab.view.webContents.getURL() || tab.url,
          entries,
          activeIndex
        } satisfies SavedBrowserTab
      })

    const activeTabIndex = this.activeTabId ? tabIds.indexOf(this.activeTabId) : 0

    return {
      version: 1,
      activeTabIndex: clampIndex(activeTabIndex, tabs.length),
      tabs
    }
  }

  createTab(url = defaultTabUrl): string {
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
      isLoading: false
    }

    this.tabs.set(id, tab)
    this.attachEvents(tab)
    this.activateTab(id)
    void view.webContents.loadURL(normalizeNavigationInput(url))
    this.pushState()
    return id
  }

  // window.open() must return a real WebContents or OAuth popups break. The old
  // code created a tab and denied the window, leaving blank tabs and a null
  // popup handle. createWindow wires the popup into the in-app tab strip.
  private createPopupTab(url: string | undefined): BrowserTab {
    const id = crypto.randomUUID()
    const view = this.createView()

    view.setBorderRadius?.(12)
    view.setBounds(this.bounds)
    this.window.contentView.addChildView(view)

    const initialUrl = url?.trim() || 'about:blank'
    const tab: BrowserTab = {
      id,
      view,
      title: 'New Tab',
      url: initialUrl,
      isLoading: false
    }

    this.tabs.set(id, tab)
    this.attachEvents(tab)
    this.activateTab(id)

    if (!isBlankPopupUrl(url) && !isUnsafePopupUrl(url)) {
      void view.webContents.loadURL(normalizeNavigationInput(url!))
    }

    this.pushState()
    return tab
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
        await view.webContents.loadURL(saved.url)
        tab.url = view.webContents.getURL() || saved.url
        tab.title = view.webContents.getTitle() || tab.url || 'New Tab'
      } else {
        await view.webContents.loadURL(defaultTabUrl)
        tab.url = defaultTabUrl
        tab.title = 'New Tab'
      }
    } catch {
      const fallbackUrl = isSafeNavigationUrl(saved.url) ? saved.url : defaultTabUrl
      await view.webContents.loadURL(fallbackUrl)
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
    tab.view.webContents.close()
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

    void tab.view.webContents.loadURL(normalizeNavigationInput(input))
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

    webContents.setWindowOpenHandler((details) => {
      if (isUnsafePopupUrl(details.url)) {
        return { action: 'deny' }
      }

      return {
        action: 'allow',
        createWindow: () => this.createPopupTab(details.url).view.webContents
      }
    })

    webContents.on('page-title-updated', (_event, title) => {
      tab.title = title || tab.url || 'New Tab'
      this.pushState()
    })

    webContents.on('did-start-loading', () => {
      tab.isLoading = true
      this.pushState()
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
    return tab?.view.webContents ?? null
  }

  // Flat list for the agent to discover targets before acting.
  listTabs(): Array<{ id: string; url: string; title: string; active: boolean }> {
    return Array.from(this.tabs.values()).map((tab) => ({
      id: tab.id,
      url: tab.view.webContents.getURL() || tab.url,
      title: tab.title,
      active: tab.id === this.activeTabId
    }))
  }

  private pushState(): void {
    this.stateListener?.({
      activeTabId: this.activeTabId,
      tabs: Array.from(this.tabs.values()).map((tab): BrowserTabState => {
        const webContents = tab.view.webContents
        const history = webContents.navigationHistory

        return {
          id: tab.id,
          title: tab.title,
          url: tab.url,
          isLoading: tab.isLoading,
          canGoBack: history.canGoBack(),
          canGoForward: history.canGoForward()
        }
      })
    })
    this.persistListener?.()
  }
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
