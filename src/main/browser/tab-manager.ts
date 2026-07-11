import { app, BrowserWindow, Menu, WebContentsView } from 'electron'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import type { BrowserBounds, BrowserState, BrowserTabState } from '../../shared/ipc.js'
import type { SavedBrowserState, SavedBrowserTab } from './browser-state-types.js'
import { MAX_SAVED_BROWSER_TABS } from './browser-state-types.js'
import { attachPopupWindowHandling } from './browser-popups.js'
import { browserPartition, chromeLikeUserAgent } from './browser-session.js'
import { loadPageAndSettle } from './page-navigation.js'
import { normalizeNavigationInput } from './url-utils.js'

const defaultTabUrl = 'https://www.google.com'
const browserBackgroundColor = '#181818'

type BrowserStateListener = (state: BrowserState) => void

export type BrowserVisitListener = {
  recordVisit(url: string, title: string): void
  updateTitle(url: string, title: string): void
}

type BrowserTab = {
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

export type BrowserTarget = {
  id: string
  kind: 'tab' | 'popup'
  url: string
  title: string
  active: boolean
  openerTabId: string | null
}

const hiddenBounds: BrowserBounds = { x: -10000, y: -10000, width: 10, height: 10 }

export class TabManager {
  private readonly tabs = new Map<string, BrowserTab>()
  private readonly navigationControllers = new Map<string, AbortController>()
  private readonly popupTargets = new Map<string, { webContents: WebContents; openerTabId: string }>()
  private activeTabId: string | null = null
  private bounds: BrowserBounds = hiddenBounds
  private isDraggingDivider = false
  // The native browser view sits above all renderer DOM, so a renderer overlay
  // (settings modal, etc.) can't cover it with z-index — we hide the view while
  // an overlay is open, the same trick used during a divider drag.
  private isOverlayOpen = false
  private stateListener: BrowserStateListener | null = null
  private persistListener: (() => void) | null = null
  private visitListener: BrowserVisitListener | null = null

  constructor(private readonly window: BrowserWindow) {}

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
    const activeIndex = clampIndex(state.activeTabIndex, created.length)
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

  createTab(url = defaultTabUrl, options: { load?: boolean; activate?: boolean } = {}): string {
    const id = crypto.randomUUID()
    const view = this.createView()

    view.setBorderRadius?.(12)
    view.setBackgroundColor(browserBackgroundColor)
    view.setVisible(false)
    view.setBounds(this.activeTabId ? hiddenBounds : this.bounds)
    this.window.contentView.addChildView(view)

    const tab: BrowserTab = {
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

  private createSavedTabShell(saved: SavedBrowserTab): { tab: BrowserTab; saved: SavedBrowserTab } {
    const id = crypto.randomUUID()
    const view = this.createView()

    view.setBorderRadius?.(12)
    view.setBackgroundColor(browserBackgroundColor)
    view.setVisible(false)
    view.setBounds(hiddenBounds)
    this.window.contentView.addChildView(view)

    const tab: BrowserTab = {
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

  private async hydrateSavedTab(tab: BrowserTab, saved: SavedBrowserTab): Promise<void> {
    const view = tab.view
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
        await this.startNavigation(tab, saved.url)
        tab.url = view.webContents.getURL() || saved.url
        tab.title = view.webContents.getTitle() || tab.url || 'New Tab'
      } else {
        await this.startNavigation(tab, defaultTabUrl)
        tab.url = defaultTabUrl
        tab.title = 'New Tab'
      }
    } catch {
      const fallbackUrl = isSafeNavigationUrl(saved.url) ? saved.url : defaultTabUrl
      await this.startNavigation(tab, fallbackUrl)
      tab.url = view.webContents.getURL() || fallbackUrl
      tab.title = view.webContents.getTitle() || tab.url || 'New Tab'
    } finally {
      tab.isLoading = false
      tab.suppressVisits = false
      this.pushState()
    }
  }

  private createView(): WebContentsView {
    return new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/browser-page.cjs'),
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

    this.navigationControllers.get(id)?.abort()
    this.navigationControllers.delete(id)

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
      tab.view.setVisible(false)
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

    void this.startNavigation(tab, normalizeNavigationInput(input)).catch(() => {})
  }

  async navigateAndWait(id: string, input: string, timeoutMs = 15_000): Promise<void> {
    const tab = this.tabs.get(id)

    if (!tab) {
      throw new Error(`no tab with id ${id}`)
    }

    await this.startNavigation(tab, normalizeNavigationInput(input), timeoutMs)
  }

  goBack(id: string): void {
    const tab = this.tabs.get(id)
    const history = tab?.view.webContents.navigationHistory

    if (history?.canGoBack()) {
      this.navigationControllers.get(id)?.abort()
      history.goBack()
    }
  }

  goForward(id: string): void {
    const tab = this.tabs.get(id)
    const history = tab?.view.webContents.navigationHistory

    if (history?.canGoForward()) {
      this.navigationControllers.get(id)?.abort()
      history.goForward()
    }
  }

  reload(id: string): void {
    this.navigationControllers.get(id)?.abort()
    this.tabs.get(id)?.view.webContents.reload()
  }

  find(id: string, text: string, forward = true): Promise<{ activeMatchOrdinal: number; matches: number; finalUpdate: boolean }> {
    const webContents = this.tabs.get(id)?.view.webContents
    if (!webContents || webContents.isDestroyed() || !text) {
      return Promise.resolve({ activeMatchOrdinal: 0, matches: 0, finalUpdate: true })
    }
    return new Promise((resolve) => {
      const requestId = webContents.findInPage(text, { forward, findNext: true })
      const onResult = (_event: Electron.Event, result: Electron.FoundInPageResult): void => {
        if (result.requestId !== requestId || !result.finalUpdate) return
        webContents.off('found-in-page', onResult)
        resolve({ activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches, finalUpdate: result.finalUpdate })
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
    const next = direction === 'reset' ? 0 : webContents.getZoomLevel() + (direction === 'in' ? 0.5 : -0.5)
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

  isUserVisibleWebContents(webContents: WebContents): boolean {
    const active = this.getActiveTab()
    if (active?.view.webContents === webContents) {
      return !this.isDraggingDivider && !this.isOverlayOpen
    }

    return [...this.popupTargets.values()].some((popup) => popup.webContents === webContents)
  }

  // The active view is on-screen only when nothing renderer-side needs the
  // browser region clear — a divider drag in progress, or an overlay covering it.
  private syncActiveBounds(): void {
    const hidden = this.isDraggingDivider || this.isOverlayOpen
    const active = this.getActiveTab()
    active?.view.setVisible(!hidden)
    active?.view.setBounds(hidden ? hiddenBounds : this.bounds)
  }

  private async startNavigation(tab: BrowserTab, url: string, timeoutMs = 15_000): Promise<void> {
    const previous = this.navigationControllers.get(tab.id)
    previous?.abort()

    const controller = new AbortController()
    this.navigationControllers.set(tab.id, controller)

    try {
      await loadPageAndSettle(tab.view.webContents, url, {
        timeoutMs,
        userAgent: chromeLikeUserAgent(),
        signal: controller.signal
      })
    } finally {
      if (this.navigationControllers.get(tab.id) === controller) {
        this.navigationControllers.delete(tab.id)
      }
    }
  }

  private attachEvents(tab: BrowserTab): void {
    const webContents = tab.view.webContents

    attachPopupWindowHandling(webContents, this.window, (popup) => this.registerPopupTarget(popup, tab.id))

    webContents.on('before-input-event', (event, input) => {
      if ((input.control || input.meta) && input.key.toLowerCase() === 'f') {
        event.preventDefault()
        this.window.webContents.send('browser:findRequested')
      }
      if ((input.control || input.meta) && input.key.toLowerCase() === 'l') {
        event.preventDefault()
        // Keyboard focus is in the page's webContents; hand it back to the
        // chrome renderer or the omnibox input.focus() would be a no-op.
        this.window.webContents.focus()
        this.window.webContents.send('browser:focusOmnibox')
      }
    })

    webContents.on('context-menu', (_event, params) => {
      const template: Electron.MenuItemConstructorOptions[] = []
      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          template.push({ label: suggestion, click: () => webContents.replaceMisspelling(suggestion) })
        }
        if (template.length) template.push({ type: 'separator' })
      }
      if (params.linkURL) template.push({ label: 'Open Link in New Tab', click: () => this.createTab(params.linkURL) })
      template.push(
        { role: 'copy', enabled: params.selectionText.length > 0 },
        { role: 'paste', enabled: params.isEditable },
        { type: 'separator' },
        { label: 'Back', enabled: webContents.navigationHistory.canGoBack(), click: () => this.goBack(tab.id) },
        { label: 'Forward', enabled: webContents.navigationHistory.canGoForward(), click: () => this.goForward(tab.id) },
        { label: 'Reload', click: () => this.reload(tab.id) }
      )
      if (!app.isPackaged) template.push({ type: 'separator' }, { label: 'Inspect Element', click: () => webContents.inspectElement(params.x, params.y) })
      Menu.buildFromTemplate(template).popup({ window: this.window })
    })

    // media-started-playing/media-paused fire before Chromium updates the
    // audible flag, so polling isCurrentlyAudible() there reads stale values.
    webContents.on('audio-state-changed', (event) => {
      tab.isAudible = event.audible
      this.pushState()
    })

    webContents.on('enter-html-full-screen', () => this.window.setFullScreen(true))
    webContents.on('leave-html-full-screen', () => this.window.setFullScreen(false))

    webContents.on('page-title-updated', (_event, title) => {
      tab.title = title || tab.url || 'New Tab'
      this.visitListener?.updateTitle(tab.url, title)
      this.pushState()
    })

    webContents.on('page-favicon-updated', (_event, favicons) => {
      // Chromium emits the page's declared favicon URLs, best-first. Prefer the
      // first valid http(s)/data URL; anything else (file:, blob:) is unsafe to
      // render from the renderer origin, so fall back to the neutral glyph.
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
      if (!tab.suppressVisits) {
        this.visitListener?.recordVisit(url, webContents.getTitle())
      }
      this.pushState()
    })

    webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        tab.url = url
        if (!tab.suppressVisits) {
          this.visitListener?.recordVisit(url, webContents.getTitle())
        }
        this.pushState()
      }
    })

    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) {
        return
      }
      tab.isLoading = false
      tab.url = validatedURL || tab.url
      tab.title = errorDescription || tab.title
      this.pushState()
    })

    webContents.on('will-navigate', (event, url) => {
      // Block guest-initiated file:// navigation. Handing an arbitrary local
      // path to the OS (shell.openExternal) would let a hostile page launch
      // documents/handlers off-screen; just refuse it.
      if (url.startsWith('file://')) {
        event.preventDefault()
      }
    })

    webContents.once('destroyed', () => {
      this.navigationControllers.get(tab.id)?.abort()
      this.navigationControllers.delete(tab.id)
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
    const webContents = tab?.view.webContents ?? (tabId ? this.popupTargets.get(tabId)?.webContents : null)

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

  listTargets(): BrowserTarget[] {
    this.removeDeadTargets()
    return [
      ...Array.from(this.tabs.values()).map((tab): BrowserTarget => ({
        id: tab.id,
        kind: 'tab',
        url: safeWebContentsUrl(tab.view.webContents) || tab.url,
        title: safeWebContentsTitle(tab.view.webContents) || tab.title,
        active: tab.id === this.activeTabId,
        openerTabId: null
      })),
      ...Array.from(this.popupTargets.entries()).map(([id, popup]): BrowserTarget => ({
        id,
        kind: 'popup',
        url: safeWebContentsUrl(popup.webContents),
        title: safeWebContentsTitle(popup.webContents) || 'Popup',
        active: false,
        openerTabId: popup.openerTabId
      }))
    ]
  }

  private registerPopupTarget(webContents: WebContents, openerTabId: string): void {
    if (webContents.isDestroyed()) return
    const id = `popup-${webContents.id}`
    this.popupTargets.set(id, { webContents, openerTabId })
    webContents.once('destroyed', () => {
      this.popupTargets.delete(id)
    })
  }

  private removeDeadTargets(): void {
    for (const [id, popup] of this.popupTargets) {
      if (popup.webContents.isDestroyed()) this.popupTargets.delete(id)
    }
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

// Chromium reports favicon candidates best-first. Take the first the renderer
// can actually load under its CSP (img-src 'self' data: https:) — https or data
// image URLs only. http/blob/file candidates are dropped so we fall back to the
// neutral glyph rather than shipping a src the renderer will refuse to render.
function pickFavicon(favicons: string[]): string | null {
  for (const candidate of favicons) {
    const lower = candidate.trim().toLowerCase()

    if (lower.startsWith('https://') || lower.startsWith('data:image/')) {
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

function safeWebContentsTitle(webContents: WebContents): string {
  if (webContents.isDestroyed()) {
    return ''
  }

  try {
    return webContents.getTitle()
  } catch {
    return ''
  }
}

async function runWithConcurrency<T>(
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
