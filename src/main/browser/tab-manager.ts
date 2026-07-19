import type { BrowserWindow, WebContents } from 'electron'
import type { BrowserBounds, BrowserState, BrowserTabState } from '../../shared/ipc.js'
import type { SavedBrowserState, SavedBrowserTab } from './browser-state-types.js'
import { MAX_SAVED_BROWSER_TABS } from './browser-state-types.js'
import {
  clampTabIndex,
  fitBrowserBounds,
  hiddenBrowserBounds,
  nextActiveTabId,
  readTabNavigation,
  safeWebContentsUrl,
  type ManagedBrowserTab
} from './browser-tab-model.js'
import {
  captureBrowserSnapshot,
  hydrateSavedBrowserTab,
  runWithConcurrency
} from './browser-tab-session.js'
import { createBrowserTabView, attachBrowserTabViewEvents } from './browser-tab-view.js'
import { BrowserTargetRegistry, type BrowserTarget } from './browser-target-registry.js'
import { chromeLikeUserAgent } from './browser-session.js'
import { loadPageAndSettle, type PageNavigationResult } from './page-navigation.js'
import { normalizeNavigationInput } from './url-utils.js'

const defaultTabUrl = 'https://www.google.com'

type BrowserStateListener = (state: BrowserState) => void

export type BrowserVisitListener = {
  recordVisit(url: string, title: string): void
  updateTitle(url: string, title: string): void
}

export type NavigateAndWaitOptions = {
  timeoutMs?: number
  quietMs?: number
  maxSettleMs?: number
  readySelector?: string
  signal?: AbortSignal
}

export type { BrowserTarget } from './browser-target-registry.js'

export class TabManager {
  private readonly tabs = new Map<string, ManagedBrowserTab>()
  private readonly navigationControllers = new Map<string, AbortController>()
  private readonly targets = new BrowserTargetRegistry()
  private activeTabId: string | null = null
  private bounds: BrowserBounds = hiddenBrowserBounds
  private isDraggingDivider = false
  // The native browser view sits above all renderer DOM, so a renderer overlay
  // (settings modal, etc.) can't cover it with z-index — hide the view while an
  // overlay is open, the same trick used during a divider drag.
  private isOverlayOpen = false
  private stateListener: BrowserStateListener | null = null
  private persistListener: (() => void) | null = null
  private visitListener: BrowserVisitListener | null = null

  constructor(private readonly window: BrowserWindow) {
    window.on('resize', () => {
      this.bounds = this.fitBoundsToWindow(this.bounds)
      this.syncActiveBounds()
    })
  }

  onState(listener: BrowserStateListener): void {
    this.stateListener = listener
    this.pushState()
  }

  onPersist(listener: () => void): void {
    this.persistListener = listener
  }

  onVisit(listener: BrowserVisitListener): void {
    this.visitListener = listener
  }

  createInitialTab(): void {
    this.createTab(defaultTabUrl)
  }

  async restoreFromSnapshot(state: SavedBrowserState): Promise<void> {
    const savedTabs = state.tabs.slice(0, MAX_SAVED_BROWSER_TABS)
    const created = savedTabs.map((savedTab) => this.createSavedTabShell(savedTab))
    const activeIndex = clampTabIndex(state.activeTabIndex, created.length)
    const active = created[activeIndex]

    if (active) {
      // Put the saved active surface on screen immediately. Its native dark
      // background remains visible until Chromium has useful content to paint.
      this.activateTab(active.tab.id)
      await this.hydrateSavedTab(active.tab, active.saved)
    }

    const background = created.filter((entry) => entry !== active)
    void runWithConcurrency(background, 2, async ({ tab, saved }) => {
      try {
        await this.hydrateSavedTab(tab, saved)
      } catch (error) {
        console.warn(`Failed to restore background tab ${tab.id}`, error)
      }
    }).finally(() => this.pushState())

    this.pushState()
  }

  captureSnapshot(): SavedBrowserState | null {
    this.removeDeadTabs()
    return captureBrowserSnapshot(this.tabs.values(), this.activeTabId)
  }

  createTab(url = defaultTabUrl, options: { load?: boolean; activate?: boolean } = {}): string {
    const id = crypto.randomUUID()
    const view = createBrowserTabView(
      this.window,
      this.activeTabId ? hiddenBrowserBounds : this.bounds
    )
    const tab: ManagedBrowserTab = {
      id,
      view,
      title: 'New Tab',
      url,
      favicon: null,
      isLoading: false,
      isAudible: false,
      isMuted: false,
      suppressVisits: false
    }

    this.tabs.set(id, tab)
    this.attachEvents(tab)
    if (options.activate !== false) {
      this.activateTab(id)
    }
    if (options.load !== false) {
      void this.startNavigation(tab, normalizeNavigationInput(url)).catch(() => {})
    }
    this.pushState()
    return id
  }

  closeTab(id: string): void {
    const tab = this.tabs.get(id)

    if (!tab) {
      return
    }

    this.cancelNavigation(id)
    this.window.contentView.removeChildView(tab.view)

    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close()
    }

    this.tabs.delete(id)

    if (this.activeTabId === id) {
      this.activeTabId = null
      this.activateFallbackTab(id)
    }

    this.pushState()
  }

  activateTab(id: string): void {
    if (!this.tabs.has(id)) {
      return
    }

    for (const tab of this.tabs.values()) {
      tab.view.setVisible(false)
      tab.view.setBounds(hiddenBrowserBounds)
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

    void this.startNavigation(tab, normalizeNavigationInput(input)).catch(() => {})
  }

  async navigateAndWait(
    id: string,
    input: string,
    options: NavigateAndWaitOptions = {}
  ): Promise<PageNavigationResult> {
    const tab = this.tabs.get(id)

    if (!tab) {
      throw new Error(`no tab with id ${id}`)
    }

    return this.startNavigation(tab, normalizeNavigationInput(input), options)
  }

  goBack(id: string): void {
    const history = this.tabs.get(id)?.view.webContents.navigationHistory

    if (history?.canGoBack()) {
      this.navigationControllers.get(id)?.abort()
      history.goBack()
    }
  }

  goForward(id: string): void {
    const history = this.tabs.get(id)?.view.webContents.navigationHistory

    if (history?.canGoForward()) {
      this.navigationControllers.get(id)?.abort()
      history.goForward()
    }
  }

  reload(id: string): void {
    this.navigationControllers.get(id)?.abort()
    this.tabs.get(id)?.view.webContents.reload()
  }

  find(
    id: string,
    text: string,
    forward = true
  ): Promise<{ activeMatchOrdinal: number; matches: number; finalUpdate: boolean }> {
    const webContents = this.tabs.get(id)?.view.webContents
    if (!webContents || webContents.isDestroyed() || !text) {
      return Promise.resolve({ activeMatchOrdinal: 0, matches: 0, finalUpdate: true })
    }
    return new Promise((resolve) => {
      const requestId = webContents.findInPage(text, { forward, findNext: true })
      const onResult = (_event: Electron.Event, result: Electron.FoundInPageResult): void => {
        if (result.requestId !== requestId || !result.finalUpdate) return
        webContents.off('found-in-page', onResult)
        resolve({
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches,
          finalUpdate: result.finalUpdate
        })
      }
      webContents.on('found-in-page', onResult)
    })
  }

  stopFind(id: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void {
    this.tabs.get(id)?.view.webContents.stopFindInPage(action)
  }

  zoom(id: string, direction: 'in' | 'out' | 'reset'): void {
    const webContents = this.tabs.get(id)?.view.webContents
    if (!webContents || webContents.isDestroyed()) return
    const next =
      direction === 'reset'
        ? 0
        : webContents.getZoomLevel() + (direction === 'in' ? 0.5 : -0.5)
    webContents.setZoomLevel(Math.max(-3, Math.min(3, next)))
    this.pushState()
  }

  toggleMute(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    tab.isMuted = !tab.isMuted
    tab.view.webContents.setAudioMuted(tab.isMuted)
    this.pushState()
  }

  setBounds(bounds: BrowserBounds): void {
    this.bounds = this.fitBoundsToWindow(bounds)
    this.syncActiveBounds()
  }

  beginDividerDrag(): void {
    this.isDraggingDivider = true
    this.syncActiveBounds()
  }

  endDividerDrag(bounds: BrowserBounds): void {
    this.bounds = this.fitBoundsToWindow(bounds)
    this.isDraggingDivider = false
    this.syncActiveBounds()
  }

  setOverlayOpen(open: boolean): void {
    this.isOverlayOpen = open
    this.syncActiveBounds()
  }

  isUserVisibleWebContents(webContents: WebContents): boolean {
    const active = this.getActiveTab()
    if (active?.view.webContents === webContents) {
      return !this.isDraggingDivider && !this.isOverlayOpen
    }

    return this.targets.contains(webContents)
  }

  getActiveTabId(): string | null {
    return this.activeTabId
  }

  resolveWebContents(tabId?: string | null): WebContents | null {
    const tab = tabId ? this.tabs.get(tabId) : this.getActiveTab()
    const webContents = tab?.view.webContents ?? (tabId ? this.targets.resolvePopup(tabId) : null)

    if (!webContents || webContents.isDestroyed()) {
      return null
    }

    return webContents
  }

  listTabs(): Array<{ id: string; url: string; title: string; active: boolean }> {
    return Array.from(this.tabs.values()).map((tab) => ({
      id: tab.id,
      url: safeWebContentsUrl(tab.view.webContents) || tab.url,
      title: tab.title,
      active: tab.id === this.activeTabId
    }))
  }

  listTargets(): BrowserTarget[] {
    return this.targets.list(this.tabs.values(), this.activeTabId)
  }

  private createSavedTabShell(saved: SavedBrowserTab): {
    tab: ManagedBrowserTab
    saved: SavedBrowserTab
  } {
    const id = crypto.randomUUID()
    const view = createBrowserTabView(this.window, hiddenBrowserBounds)
    const tab: ManagedBrowserTab = {
      id,
      view,
      title: saved.title || 'New Tab',
      url: saved.url,
      favicon: saved.favicon ?? null,
      isLoading: true,
      isAudible: false,
      isMuted: false,
      suppressVisits: true
    }

    this.tabs.set(id, tab)
    this.attachEvents(tab)
    return { tab, saved }
  }

  private async hydrateSavedTab(tab: ManagedBrowserTab, saved: SavedBrowserTab): Promise<void> {
    try {
      await hydrateSavedBrowserTab(tab, saved, defaultTabUrl, (url) =>
        this.startNavigation(tab, url).then(() => {})
      )
    } finally {
      this.pushState()
    }
  }

  private syncActiveBounds(): void {
    const hidden = this.isDraggingDivider || this.isOverlayOpen
    const active = this.getActiveTab()
    active?.view.setVisible(!hidden)
    active?.view.setBounds(hidden ? hiddenBrowserBounds : this.bounds)
  }

  private fitBoundsToWindow(bounds: BrowserBounds): BrowserBounds {
    const contentBounds = this.window.getContentBounds()
    return fitBrowserBounds(bounds, contentBounds.width, contentBounds.height)
  }

  private async startNavigation(
    tab: ManagedBrowserTab,
    url: string,
    options: NavigateAndWaitOptions = {}
  ): Promise<PageNavigationResult> {
    this.cancelNavigation(tab.id)
    const controller = new AbortController()
    this.navigationControllers.set(tab.id, controller)
    const abortFromCaller = (): void => controller.abort()
    options.signal?.addEventListener('abort', abortFromCaller, { once: true })

    try {
      return await loadPageAndSettle(tab.view.webContents, url, {
        timeoutMs: options.timeoutMs ?? 15_000,
        userAgent: chromeLikeUserAgent(),
        signal: controller.signal,
        ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
        ...(options.maxSettleMs === undefined ? {} : { maxSettleMs: options.maxSettleMs }),
        ...(options.readySelector?.trim() ? { readySelector: options.readySelector.trim() } : {})
      })
    } finally {
      options.signal?.removeEventListener('abort', abortFromCaller)
      if (this.navigationControllers.get(tab.id) === controller) {
        this.navigationControllers.delete(tab.id)
      }
    }
  }

  private cancelNavigation(tabId: string): void {
    this.navigationControllers.get(tabId)?.abort()
    this.navigationControllers.delete(tabId)
  }

  private attachEvents(tab: ManagedBrowserTab): void {
    attachBrowserTabViewEvents(this.window, tab, {
      onPopupCreated: (popup) => this.targets.registerPopup(popup, tab.id),
      onCreateTab: (url) => {
        this.createTab(url)
      },
      onBack: () => this.goBack(tab.id),
      onForward: () => this.goForward(tab.id),
      onReload: () => this.reload(tab.id),
      onStateChanged: () => this.pushState(),
      onRecordVisit: (url, title) => this.visitListener?.recordVisit(url, title),
      onUpdateVisitTitle: (url, title) => this.visitListener?.updateTitle(url, title),
      onDestroyed: () => this.handleDestroyedTab(tab)
    })
  }

  private handleDestroyedTab(tab: ManagedBrowserTab): void {
    this.cancelNavigation(tab.id)
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
      this.activeTabId = null
      this.activateFallbackTab(tab.id)
    }
    this.pushState()
  }

  private removeDeadTabs(): void {
    let removedActiveTabId: string | null = null

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
        removedActiveTabId = id
        this.activeTabId = null
      }
    }

    if (this.activeTabId && !this.tabs.has(this.activeTabId)) {
      removedActiveTabId = this.activeTabId
      this.activeTabId = null
    }

    if (!this.activeTabId && this.tabs.size > 0) {
      this.activateFallbackTab(removedActiveTabId ?? '')
    }
  }

  private activateFallbackTab(removedActiveTabId: string): void {
    const next = nextActiveTabId(this.tabs.values(), removedActiveTabId)

    if (next) {
      this.activateTab(next)
    } else {
      this.createTab()
    }
  }

  private getActiveTab(): ManagedBrowserTab | null {
    return this.activeTabId ? (this.tabs.get(this.activeTabId) ?? null) : null
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
          canGoForward: navigation.canGoForward,
          isAudible: tab.isAudible,
          isMuted: tab.isMuted,
          zoomPercent: Math.round(100 * Math.pow(1.2, tab.view.webContents.getZoomLevel()))
        }
      })
    })
    this.persistListener?.()
  }
}
