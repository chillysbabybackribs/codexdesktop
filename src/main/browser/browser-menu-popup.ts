import { ipcMain, WebContentsView } from 'electron'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import { join } from 'node:path'
import type { BrowserMenuAnchor, BrowserMenuCommand, BrowserMenuItem, BrowserMenuRenderPayload } from '../../shared/ipc.js'
import { ipcChannels } from '../../shared/ipc.js'

// Keep in sync with the row/card metrics in src/renderer/browser-menu.html.
const ACTION_ROW_HEIGHT = 34
const ZOOM_ROW_HEIGHT = 40
const SEPARATOR_HEIGHT = 9
const CARD_CHROME = 14
const SHADOW_SPACE = 14
const MENU_WIDTH = 240

const hiddenBounds = { x: -10000, y: -10000, width: 10, height: 10 }

const menuCommands: readonly BrowserMenuCommand[] = [
  'find',
  'mute',
  'vpn',
  'zoom-out',
  'zoom-reset',
  'zoom-in',
  'fullscreen'
]

// Commands that keep the menu open after running (Chrome-style zoom stepper).
const stickyCommands: ReadonlySet<BrowserMenuCommand> = new Set(['zoom-out', 'zoom-reset', 'zoom-in'])

// The browser overflow (kebab) menu. Renderer DOM cannot overlay the page
// (native tab views paint above it), so — exactly like the omnibox dropdown —
// the menu is its own transparent WebContentsView stacked above the tab views.
// The page view is never hidden, moved, or resized while it is open; this
// surface simply floats on top. The renderer owns the item list (it already
// tracks tab/vpn/fullscreen state) and pushes updates while the menu is open.
export class BrowserMenuPopup {
  private view: WebContentsView | null = null
  private pageReady = false
  private visible = false
  private items: BrowserMenuItem[] = []
  private readonly window: BrowserWindow
  private readonly onCommand: (command: BrowserMenuCommand) => void
  private readonly onClosed: () => void

  constructor(window: BrowserWindow, onCommand: (command: BrowserMenuCommand) => void, onClosed: () => void) {
    this.window = window
    this.onCommand = onCommand
    this.onClosed = onClosed
    ipcMain.on(ipcChannels.browserMenuCommand, this.handleCommand)
  }

  show(anchor: BrowserMenuAnchor, items: BrowserMenuItem[]): void {
    this.items = items

    if (items.length === 0) {
      this.hide()
      return
    }

    const view = this.ensureView()
    // Re-adding an existing child moves it to the top of the stack, so the
    // menu stays above whichever tab view is active.
    this.window.contentView.addChildView(view)
    view.setBounds(this.computeBounds(anchor, items))
    view.setVisible(true)
    // Raising a WebContentsView can transfer native keyboard focus to it.
    // Give focus back so Escape and outside clicks keep working in the chrome.
    this.window.webContents.focus()
    this.visible = true
    this.sendRender()
  }

  update(items: BrowserMenuItem[]): void {
    if (!this.visible) {
      return
    }

    this.items = items
    this.sendRender()
  }

  hide(): void {
    const wasVisible = this.visible
    this.visible = false

    if (this.view) {
      this.view.setVisible(false)
      this.view.setBounds(hiddenBounds)
    }

    if (wasVisible) {
      this.onClosed()
    }
  }

  isOpen(): boolean {
    return this.visible
  }

  dispose(): void {
    ipcMain.off(ipcChannels.browserMenuCommand, this.handleCommand)

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

  private readonly handleCommand = (event: IpcMainEvent, command: unknown): void => {
    if (event.sender !== this.view?.webContents) {
      return
    }

    // Items are built renderer-side, but re-check at the trust boundary: only
    // known commands may be dispatched from the popup.
    if (typeof command !== 'string' || !(menuCommands as readonly string[]).includes(command)) {
      return
    }

    const menuCommand = command as BrowserMenuCommand

    if (stickyCommands.has(menuCommand)) {
      // Clicking the popup moved native focus into it; hand focus back to the
      // chrome so the renderer's outside-click/Escape dismissal keeps working.
      this.window.webContents.focus()
    } else {
      this.hide()
    }

    this.onCommand(menuCommand)
  }

  private ensureView(): WebContentsView {
    if (this.view) {
      return this.view
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/browser-menu.cjs'),
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
      this.sendRender()
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void view.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')}/browser-menu.html`)
    } else {
      void view.webContents.loadFile(join(__dirname, '../renderer/browser-menu.html'))
    }

    this.view = view
    return view
  }

  private computeBounds(anchor: BrowserMenuAnchor, items: BrowserMenuItem[]): Electron.Rectangle {
    const [windowWidth, windowHeight] = this.window.getContentSize()
    const rowsHeight = items.reduce((total, item) => {
      if (item.kind === 'separator') return total + SEPARATOR_HEIGHT
      if (item.kind === 'zoom') return total + ZOOM_ROW_HEIGHT
      return total + ACTION_ROW_HEIGHT
    }, 0)
    const height = rowsHeight + CARD_CHROME + SHADOW_SPACE
    const maxHeight = Math.max(ACTION_ROW_HEIGHT + CARD_CHROME, windowHeight - anchor.y - 8)

    return {
      // Right-align the card to the anchor (the kebab button's right edge).
      x: Math.max(8, Math.min(Math.round(anchor.x - MENU_WIDTH), windowWidth - MENU_WIDTH - 8)),
      y: Math.round(anchor.y),
      width: MENU_WIDTH,
      height: Math.min(height, maxHeight)
    }
  }

  private sendRender(): void {
    if (!this.view || !this.pageReady || this.view.webContents.isDestroyed()) {
      return
    }

    const payload: BrowserMenuRenderPayload = { items: this.items }
    this.view.webContents.send(ipcChannels.browserMenuRender, payload)
  }
}
