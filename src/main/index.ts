import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import type { BrowserBounds } from '../shared/ipc.js'
import { ipcChannels } from '../shared/ipc.js'
import { BrowserStateStore } from './browser/browser-state-store.js'
import { TabManager } from './browser/tab-manager.js'
import { startBrowserControlServer, type BrowserControlServer } from './browser/browser-control-server.js'
import { registerCodexIpc } from './codex/codex-ipc.js'
import type { CodexClient } from './codex/codex-client.js'

let mainWindow: BrowserWindow | null = null
let tabManager: TabManager | null = null
let codexClient: CodexClient | null = null
let browserControl: BrowserControlServer | null = null
const browserStateStore = new BrowserStateStore()
let persistBrowserTimer: ReturnType<typeof setTimeout> | null = null

function scheduleBrowserPersist(): void {
  if (persistBrowserTimer) {
    clearTimeout(persistBrowserTimer)
  }

  persistBrowserTimer = setTimeout(() => {
    persistBrowserTimer = null
    const snapshot = tabManager?.captureSnapshot()

    if (snapshot) {
      void browserStateStore.save(snapshot)
    }
  }, 500)
}

async function flushBrowserPersist(): Promise<void> {
  if (persistBrowserTimer) {
    clearTimeout(persistBrowserTimer)
    persistBrowserTimer = null
  }

  const snapshot = tabManager?.captureSnapshot()

  if (snapshot) {
    await browserStateStore.save(snapshot)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 2048,
    height: 1024,
    minWidth: 980,
    minHeight: 620,
    show: false,
    frame: false,
    title: 'Chat',
    backgroundColor: '#121212',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('Renderer failed to load', { errorCode, errorDescription, validatedURL })
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone', details)
  })

  mainWindow.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event
    console.log(`Renderer console [${level}]: ${message} (${sourceId}:${lineNumber})`)
  })

  tabManager = new TabManager(mainWindow)
  tabManager.onState((state) => {
    mainWindow?.webContents.send(ipcChannels.browserState, state)
  })
  tabManager.onPersist(() => {
    scheduleBrowserPersist()
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    void restoreBrowserTabs()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    tabManager = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  registerIpc()
  createWindow()

  // Stand up the agent's browser control surface and publish its socket path
  // into the environment BEFORE the codex child is spawned. The child inherits
  // process.env (see codex-client spawn), and it only spawns lazily on the
  // first message, so setting it here is always in time. Bound to a getter so
  // it survives window close/reopen swapping the TabManager instance.
  try {
    browserControl = await startBrowserControlServer(() => tabManager)
    process.env.CODEX_BROWSER_SOCK = browserControl.socketPath
    console.log(`Browser control socket: ${browserControl.socketPath}`)
  } catch (error) {
    console.error('Failed to start browser control server', error)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  void flushBrowserPersist()
  codexClient?.dispose()
  codexClient = null
  void browserControl?.close()
  browserControl = null
})

async function restoreBrowserTabs(): Promise<void> {
  const saved = await browserStateStore.load()

  if (saved && saved.tabs.length > 0) {
    try {
      await tabManager?.restoreFromSnapshot(saved)
      return
    } catch (error) {
      console.error('Failed to restore browser tabs, falling back to default tab', error)
    }
  }

  tabManager?.createInitialTab()
}

function registerIpc(): void {
  codexClient = registerCodexIpc(() => mainWindow)

  ipcMain.handle(ipcChannels.windowMinimize, () => mainWindow?.minimize())
  ipcMain.handle(ipcChannels.windowToggleMaximize, () => {
    if (!mainWindow) {
      return
    }

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })
  ipcMain.handle(ipcChannels.windowClose, () => mainWindow?.close())

  ipcMain.handle(ipcChannels.workspacePick, async () => {
    if (!mainWindow) {
      return null
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose workspace folder',
      properties: ['openDirectory', 'createDirectory']
    })

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(ipcChannels.browserNewTab, (_event, url?: string) => tabManager?.createTab(url))
  ipcMain.handle(ipcChannels.browserCloseTab, (_event, tabId: string) => tabManager?.closeTab(tabId))
  ipcMain.handle(ipcChannels.browserActivateTab, (_event, tabId: string) => tabManager?.activateTab(tabId))
  ipcMain.handle(ipcChannels.browserNavigate, (_event, tabId: string, input: string) => {
    tabManager?.navigate(tabId, input)
  })
  ipcMain.handle(ipcChannels.browserBack, (_event, tabId: string) => tabManager?.goBack(tabId))
  ipcMain.handle(ipcChannels.browserForward, (_event, tabId: string) => tabManager?.goForward(tabId))
  ipcMain.handle(ipcChannels.browserReload, (_event, tabId: string) => tabManager?.reload(tabId))
  ipcMain.handle(ipcChannels.browserSetBounds, (_event, bounds: BrowserBounds) => tabManager?.setBounds(bounds))
  ipcMain.handle(ipcChannels.browserBeginDividerDrag, () => tabManager?.beginDividerDrag())
  ipcMain.handle(ipcChannels.browserEndDividerDrag, (_event, bounds: BrowserBounds) => tabManager?.endDividerDrag(bounds))
  ipcMain.handle(ipcChannels.browserSetOverlayOpen, (_event, open: boolean) => tabManager?.setOverlayOpen(open))
}
