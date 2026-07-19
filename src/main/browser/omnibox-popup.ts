import { ipcMain, WebContentsView } from 'electron'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import { join } from 'node:path'
import type { OmniboxAnchor, OmniboxRenderPayload, OmniboxSuggestion } from '../../shared/ipc.js'
import { ipcChannels } from '../../shared/ipc.js'

// Keep in sync with the row/card metrics in src/renderer/omnibox-popup.html.
const ROW_HEIGHT = 40
const CARD_CHROME = 14
const SHADOW_SPACE = 14

const hiddenBounds = { x: -10000, y: -10000, width: 10, height: 10 }

// The suggestion dropdown. Renderer DOM cannot overlay the page (native tab
// views paint above it), so the dropdown is its own transparent
// WebContentsView stacked above the tab views. The page view is never hidden,
// moved, or resized while it is open — this surface simply floats on top,
// like Chrome's omnibox popup widget. Keyboard focus stays in the main
// renderer's omnibox input; this view only displays rows and reports clicks.
export class OmniboxPopup {
  private view: WebContentsView | null = null
  private pageReady = false
  private visible = false
  private suggestions: OmniboxSuggestion[] = []
  private selectedIndex = -1
  private anchor: OmniboxAnchor | null = null
  private readonly window: BrowserWindow
  private readonly onCommit: (url: string) => void
  private readonly onDeleteHistory: (url: string) => boolean

  constructor(window: BrowserWindow, onCommit: (url: string) => void, onDeleteHistory: (url: string) => boolean) {
    this.window = window
    this.onCommit = onCommit
    this.onDeleteHistory = onDeleteHistory
    ipcMain.on(ipcChannels.browserOmniboxCommit, this.handleCommit)
    ipcMain.on(ipcChannels.browserOmniboxDeleteHistory, this.handleDeleteHistory)

    // Load the hidden native document before the first user gesture. Creating
    // and loading a WebContentsView from the input's first focus event can
    // steal the remainder of that click before Chromium restores chrome focus.
    this.ensureView()
  }

  show(anchor: OmniboxAnchor, suggestions: OmniboxSuggestion[]): void {
    this.suggestions = suggestions
    this.selectedIndex = -1

    if (suggestions.length === 0) {
      this.hide()
      return
    }

    this.anchor = anchor
    this.visible = true
    const view = this.ensureView()

    // Never expose an unready native surface. If startup is unusually slow,
    // did-finish-load presents the pending popup after the click has completed.
    if (this.pageReady) {
      this.present(view)
    }
  }

  setSelection(index: number): void {
    if (!this.visible) {
      return
    }

    this.selectedIndex = index
    this.sendRender()
  }

  hide(): void {
    if (!this.view) {
      return
    }

    this.visible = false
    this.anchor = null
    this.view.setVisible(false)
    this.view.setBounds(hiddenBounds)
  }

  isOpen(): boolean {
    return this.visible
  }

  dispose(): void {
    ipcMain.off(ipcChannels.browserOmniboxCommit, this.handleCommit)
    ipcMain.off(ipcChannels.browserOmniboxDeleteHistory, this.handleDeleteHistory)

    if (this.view) {
      try {
        this.window.contentView.removeChildView(this.view)
      } catch {
        // Window may already be tearing down.
      }

      if (!this.view.webContents.isDestroyed()) {
        this.view.webContents.close()
      }

      this.view = null
    }
  }

  private readonly handleCommit = (event: IpcMainEvent, url: unknown): void => {
    if (event.sender !== this.view?.webContents || typeof url !== 'string') {
      return
    }

    // Rows are built main-side from history/search URLs, but re-check at the
    // trust boundary: only web navigation may be committed from the popup.
    if (!/^https?:\/\//i.test(url)) {
      return
    }

    this.hide()
    this.onCommit(url)
  }

  private readonly handleDeleteHistory = (event: IpcMainEvent, url: unknown): void => {
    if (event.sender !== this.view?.webContents || typeof url !== 'string') {
      return
    }

    // The popup is a sandboxed renderer, so authorize the mutation against the
    // exact history rows main most recently rendered. Search/navigate rows and
    // arbitrary URLs cannot be deleted through this channel.
    const isDisplayedHistory = this.suggestions.some(
      (suggestion) => suggestion.kind === 'history' && suggestion.url === url
    )
    if (!isDisplayedHistory || !this.onDeleteHistory(url)) {
      return
    }

    this.suggestions = this.suggestions.filter(
      (suggestion) => suggestion.kind !== 'history' || suggestion.url !== url
    )
    this.selectedIndex = -1

    if (this.suggestions.length === 0) {
      this.hide()
      return
    }

    if (this.view && this.pageReady && this.anchor) {
      this.view.setBounds(this.computeBounds(this.anchor, this.suggestions.length))
      this.sendRender()
      // Keep keyboard ownership in the address field after the native popup
      // handled the destructive pointer action.
      this.window.webContents.focus()
    }
  }

  private ensureView(): WebContentsView {
    if (this.view) {
      return this.view
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/omnibox-popup.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    view.setBounds(hiddenBounds)
    this.window.contentView.addChildView(view)

    view.webContents.on('did-finish-load', () => {
      this.pageReady = true
      if (this.visible) {
        this.present(view)
      } else {
        this.sendRender()
      }
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void view.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')}/omnibox-popup.html`)
    } else {
      void view.webContents.loadFile(join(__dirname, '../renderer/omnibox-popup.html'))
    }

    this.view = view
    return view
  }

  private present(view: WebContentsView): void {
    if (!this.anchor || !this.visible) {
      return
    }

    // Re-adding an existing child moves it to the top of the stack, so the
    // dropdown stays above whichever tab view is active.
    this.window.contentView.addChildView(view)
    view.setBounds(this.computeBounds(this.anchor, this.suggestions.length))
    view.setVisible(true)
    this.sendRender()
    // Raising a WebContentsView can transfer native keyboard focus to it even
    // though the DOM focus belongs in the main renderer's omnibox.
    this.window.webContents.focus()
  }

  private computeBounds(anchor: OmniboxAnchor, rowCount: number): Electron.Rectangle {
    const [, windowHeight] = this.window.getContentSize()
    const height = rowCount * ROW_HEIGHT + CARD_CHROME + SHADOW_SPACE
    const maxHeight = Math.max(ROW_HEIGHT + CARD_CHROME, windowHeight - anchor.y - 8)

    return {
      x: Math.round(anchor.x),
      y: Math.round(anchor.y),
      width: Math.max(120, Math.round(anchor.width)),
      height: Math.min(height, maxHeight)
    }
  }

  private sendRender(): void {
    if (!this.view || !this.pageReady || this.view.webContents.isDestroyed()) {
      return
    }

    const payload: OmniboxRenderPayload = {
      suggestions: this.suggestions,
      selectedIndex: this.selectedIndex
    }
    this.view.webContents.send(ipcChannels.browserOmniboxRender, payload)
  }
}
