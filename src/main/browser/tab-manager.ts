import { BrowserWindow, WebContentsView, shell } from 'electron'
import type { WebContents } from 'electron'
import type { BrowserBounds, BrowserState, BrowserTabState } from '../../shared/ipc.js'
import { normalizeNavigationInput } from './url-utils.js'

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

  constructor(private readonly window: BrowserWindow) {}

  onState(listener: BrowserStateListener): void {
    this.stateListener = listener
    this.pushState()
  }

  createInitialTab(): void {
    this.createTab('https://www.google.com')
  }

  createTab(url = 'https://www.google.com'): string {
    const id = crypto.randomUUID()
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

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
    void view.webContents.loadURL(url)
    this.pushState()
    return id
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

    webContents.setWindowOpenHandler(({ url }) => {
      this.createTab(url)
      return { action: 'deny' }
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
  }
}

function sanitizeBounds(bounds: BrowserBounds): BrowserBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  }
}
