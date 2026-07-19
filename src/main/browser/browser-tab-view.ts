import { app, Menu, WebContentsView } from 'electron'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import type { BrowserBounds } from '../../shared/ipc.js'
import type { ManagedBrowserTab } from './browser-tab-model.js'
import { attachPopupWindowHandling } from './browser-popups.js'
import { browserPartition } from './browser-session.js'

const browserBackgroundColor = '#181818'

export type BrowserTabViewHandlers = {
  onPopupCreated(webContents: WebContents): void
  onCreateTab(url: string): void
  onBack(): void
  onForward(): void
  onReload(): void
  onMainFrameNavigationStarted(): void
  onStateChanged(): void
  onRecordVisit(url: string, title: string): void
  onUpdateVisitTitle(url: string, title: string): void
  onDestroyed(): void
}

export function createBrowserTabView(window: BrowserWindow, bounds: BrowserBounds): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/browser-page.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: browserPartition
    }
  })

  // The renderer host has a 10px outer radius and a 1px frame. Match its
  // 9px inner curve so the native surface sits inside instead of over it.
  view.setBorderRadius(9)
  view.setBackgroundColor(browserBackgroundColor)
  view.setVisible(false)
  view.setBounds(bounds)
  window.contentView.addChildView(view)
  return view
}

export function attachBrowserTabViewEvents(
  window: BrowserWindow,
  tab: ManagedBrowserTab,
  handlers: BrowserTabViewHandlers
): void {
  const webContents = tab.view.webContents

  attachPopupWindowHandling(webContents, window, handlers.onPopupCreated)

  webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 'f') {
      event.preventDefault()
      window.webContents.send('browser:findRequested')
    }
    if ((input.control || input.meta) && input.key.toLowerCase() === 'l') {
      event.preventDefault()
      // Keyboard focus is in the page's webContents; hand it back to the
      // chrome renderer or the omnibox input.focus() would be a no-op.
      window.webContents.focus()
      window.webContents.send('browser:focusOmnibox')
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
    if (params.linkURL) {
      template.push({ label: 'Open Link in New Tab', click: () => handlers.onCreateTab(params.linkURL) })
    }
    template.push(
      { role: 'copy', enabled: params.selectionText.length > 0 },
      { role: 'paste', enabled: params.isEditable },
      { type: 'separator' },
      { label: 'Back', enabled: webContents.navigationHistory.canGoBack(), click: handlers.onBack },
      { label: 'Forward', enabled: webContents.navigationHistory.canGoForward(), click: handlers.onForward },
      { label: 'Reload', click: handlers.onReload }
    )
    if (!app.isPackaged) {
      template.push(
        { type: 'separator' },
        { label: 'Inspect Element', click: () => webContents.inspectElement(params.x, params.y) }
      )
    }
    Menu.buildFromTemplate(template).popup({ window })
  })

  // media-started-playing/media-paused fire before Chromium updates the
  // audible flag, so polling isCurrentlyAudible() there reads stale values.
  webContents.on('audio-state-changed', (event) => {
    tab.isAudible = event.audible
    handlers.onStateChanged()
  })

  webContents.on('enter-html-full-screen', () => window.setFullScreen(true))
  webContents.on('leave-html-full-screen', () => window.setFullScreen(false))

  webContents.on('page-title-updated', (_event, title) => {
    tab.title = title || tab.url || 'New Tab'
    handlers.onUpdateVisitTitle(tab.url, title)
    handlers.onStateChanged()
  })

  webContents.on('page-favicon-updated', (_event, favicons) => {
    tab.favicon = pickFavicon(favicons)
    handlers.onStateChanged()
  })

  webContents.on('did-start-loading', () => {
    tab.isLoading = true
    handlers.onStateChanged()
  })

  webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      handlers.onMainFrameNavigationStarted()
    }
    if (isMainFrame && !isInPlace && tab.favicon !== null) {
      tab.favicon = null
      handlers.onStateChanged()
    }
  })

  webContents.on('did-stop-loading', () => {
    tab.isLoading = false
    tab.url = webContents.getURL()
    tab.title = webContents.getTitle() || tab.url || 'New Tab'
    handlers.onStateChanged()
  })

  webContents.on('did-navigate', (_event, url) => {
    tab.url = url
    if (!tab.suppressVisits) {
      handlers.onRecordVisit(url, webContents.getTitle())
    }
    handlers.onStateChanged()
  })

  webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) {
      tab.url = url
      if (!tab.suppressVisits) {
        handlers.onRecordVisit(url, webContents.getTitle())
      }
      handlers.onStateChanged()
    }
  })

  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) {
      return
    }
    tab.isLoading = false
    tab.url = validatedURL || tab.url
    tab.title = errorDescription || tab.title
    handlers.onStateChanged()
  })

  webContents.on('will-navigate', (event, url) => {
    // Block guest-initiated file:// navigation. Handing an arbitrary local path
    // to the OS would let a hostile page launch local documents or handlers.
    if (url.startsWith('file://')) {
      event.preventDefault()
    }
  })

  webContents.once('destroyed', handlers.onDestroyed)
}

// Chromium reports favicon candidates best-first. Take the first the renderer
// can load under its CSP (img-src 'self' data: https:).
function pickFavicon(favicons: string[]): string | null {
  for (const candidate of favicons) {
    const lower = candidate.trim().toLowerCase()

    if (lower.startsWith('https://') || lower.startsWith('data:image/')) {
      return candidate
    }
  }

  return null
}
