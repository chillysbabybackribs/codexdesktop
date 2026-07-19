import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Notification } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  ArtifactReadImageParams,
  ArtifactReadImageResult,
  AttachmentPreviewParams,
  AttachmentPreviewResult,
  AttachmentSaveInput,
  ImageViewPreviewParams,
  ImageViewPreviewResult,
  BackgroundTurnNotificationParams,
  BrowserBounds,
  OmniboxAnchor,
  OmniboxQueryResult,
  TraceLoadParams,
  TracePersistParams,
  TranscriptCachePersistParams,
  CheckpointRevertParams,
  CheckpointRevertFilesParams,
  CheckpointChangedFilesParams,
  CheckpointSummary,
  MentionIndexParams,
  MentionIndexResult,
  MentionReadParams,
  MentionReadIpcResult,
  TraceSaveParams,
  TraceSaveResult
} from '../shared/ipc.js'
import { ipcChannels } from '../shared/ipc.js'
import { BrowserHistoryStore } from './browser/browser-history-store.js'
import { BrowserStateStore } from './browser/browser-state-store.js'
import { OmniboxPopup } from './browser/omnibox-popup.js'
import { buildSuggestions, inlineCompletion } from './browser/omnibox-suggestions.js'
import { describeNavigationInput } from './browser/url-utils.js'
import { BrowserAgentController } from './browser/browser-agent.js'
import { CdpArtifactStore } from './browser/cdp-artifact-store.js'
import { ResearchRunner } from './browser/research-runner.js'
import { configureBrowserSession } from './browser/browser-session.js'
import { TabManager } from './browser/tab-manager.js'
import { TorVpnManager } from './browser/vpn-manager.js'
import { startBrowserControlServer, type BrowserControlServer } from './browser/browser-control-server.js'
import { registerSessionIpc, type RegisteredSessionProviders } from './codex/codex-ipc.js'
import { TurnTraceStore } from './turn-trace-store.js'
import { MemoryStore } from './memory-store.js'
import { AttachmentStore } from './attachment-store.js'
import { readImageViewDataUrl } from './image-view-preview.js'
import { TranscriptCache } from './transcript-cache.js'
import { TurnCheckpointStore } from './turn-checkpoint.js'
import { MentionIndexService } from './mention-index.js'

// Dev/testing hook: point userData somewhere else so a verification instance
// can run alongside the real app (the single-instance lock is per userData).
if (process.env.CODEX_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.CODEX_DESKTOP_USER_DATA)
}

const instanceRole = process.env.CODEX_DESKTOP_INSTANCE_ROLE === 'verification' ? 'verification' : 'host'
const hostSessionId = process.env.CODEX_DESKTOP_HOST_SESSION_ID || randomUUID()
process.env.CODEX_DESKTOP_SELF_HOSTED = '1'
process.env.CODEX_DESKTOP_INSTANCE_ROLE = instanceRole
process.env.CODEX_DESKTOP_HOST_SESSION_ID = hostSessionId
process.env.CODEX_DESKTOP_HOST_PID = String(process.pid)
process.env.CODEX_DESKTOP_DEV_SERVER_PID = String(process.ppid)
process.env.CODEX_DESKTOP_HOST_USER_DATA = app.getPath('userData')

// Chromium locks profile storage (cookies, service workers, etc.). A second
// instance against the same userData dir causes random IO errors like:
// "Failed to delete the database: Database IO error".
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  crashReporter.start({ uploadToServer: false })
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }

      mainWindow.focus()
    }
  })

  bootstrap()
}

let mainWindow: BrowserWindow | null = null
let tabManager: TabManager | null = null
let omniboxPopup: OmniboxPopup | null = null
let sessionProviders: RegisteredSessionProviders | null = null
let browserControl: BrowserControlServer | null = null
let quitPreparationStarted = false
let quitReady = false
const cdpArtifactStore = new CdpArtifactStore(() => join(app.getPath('userData'), 'cdp-artifacts'))
const attachmentStore = new AttachmentStore(() => join(app.getPath('userData'), 'chat-attachments'))
const browserAgent = new BrowserAgentController(() => tabManager, cdpArtifactStore)
const researchRunner = new ResearchRunner()
const browserStateStore = new BrowserStateStore(() => join(app.getPath('userData'), 'browser-state.json'))
const browserHistoryStore = new BrowserHistoryStore(() => join(app.getPath('userData'), 'browser-history.json'))
const vpnManager = new TorVpnManager()
let persistBrowserTimer: ReturnType<typeof setTimeout> | null = null
let verificationBrowserControlReady = false
let verificationBrowserRestored = false
let verificationCloseScheduled = false
const verificationAutoCloseDelayMs = 1_000

function maybeCloseVerificationInstance(): void {
  if (
    instanceRole !== 'verification' ||
    process.env.CODEX_DESKTOP_VERIFY_AUTO_CLOSE !== '1' ||
    !verificationBrowserControlReady ||
    !verificationBrowserRestored ||
    verificationCloseScheduled
  ) {
    return
  }

  verificationCloseScheduled = true
  // The browser-control surface and restored tab snapshot are both live. Use
  // BrowserWindow.close() so the normal browser persistence/CDP teardown path
  // is what the verifier observes, not a terminal-signal shortcut.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  }, verificationAutoCloseDelayMs)
}

function scheduleBrowserPersist(): void {
  if (persistBrowserTimer) {
    clearTimeout(persistBrowserTimer)
  }

  persistBrowserTimer = setTimeout(() => {
    persistBrowserTimer = null
    const snapshot = tabManager?.captureSnapshot()

    if (snapshot) {
      void browserStateStore.save(snapshot).catch((error) => {
        console.warn('Failed to persist browser state', error)
      })
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

  await browserStateStore.flush()
}

function sendToMainRenderer(channel: string, payload: unknown): void {
  const window = mainWindow

  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return
  }

  try {
    window.webContents.send(channel, payload)
  } catch (error) {
    // The renderer can disappear between the lifetime check and send during
    // reload/shutdown. That is expected and there is no receiver to notify.
    if (!/render frame was disposed|webcontents.*destroyed|webcontents.*disposed/i.test(String(error))) {
      console.warn(`Failed to send ${channel} to the renderer`, error)
    }
  }
}

function createWindow(): void {
  const windowTitle = instanceRole === 'verification' ? 'Chat — Verification Instance' : 'Chat'
  mainWindow = new BrowserWindow({
    width: 2048,
    height: 1024,
    minWidth: 980,
    minHeight: 620,
    show: false,
    frame: false,
    title: windowTitle,
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
    console.error('Local crash dumps are retained in', app.getPath('crashDumps'))
  })

  mainWindow.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event
    console.log(`Renderer console [${level}]: ${message} (${sourceId}:${lineNumber})`)
  })

  tabManager = new TabManager(mainWindow)
  tabManager.setVpnStatusSource(() => vpnManager.status())
  tabManager.onState((state) => {
    sendToMainRenderer(ipcChannels.browserState, state)
  })
  tabManager.onPersist(() => {
    scheduleBrowserPersist()
  })
  tabManager.onVisit({
    recordVisit: (url, title) => browserHistoryStore.recordVisit(url, title),
    updateTitle: (url, title) => browserHistoryStore.updateTitle(url, title)
  })

  omniboxPopup = new OmniboxPopup(mainWindow, (url) => {
    const activeTabId = tabManager?.getActiveTabId()

    if (activeTabId) {
      tabManager?.navigate(activeTabId, url)
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    void restoreBrowserTabs().finally(() => {
      verificationBrowserRestored = true
      maybeCloseVerificationInstance()
    })
  })

  // The omnibox dropdown is a native view anchored to the toolbar. Renderer
  // input onBlur can't catch OS window deactivation (the input stays
  // document.activeElement), so dismiss it here when the window loses focus.
  mainWindow.on('blur', () => {
    omniboxPopup?.hide()
  })

  // Capture while the native views still exist. On macOS a normal window
  // close does not quit the process, and on other platforms before-quit can
  // run only after this manager has been cleared.
  mainWindow.on('close', () => {
    void flushBrowserPersist().catch((error) => {
      console.warn('Failed to persist browser state while closing the window', error)
    })
    tabManager?.dispose()
  })

  mainWindow.on('closed', () => {
    tabManager?.dispose()
    omniboxPopup?.dispose()
    omniboxPopup = null
    mainWindow = null
    tabManager = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function bootstrap(): void {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', (event) => {
    if (quitReady) {
      return
    }

    event.preventDefault()
    if (quitPreparationStarted) {
      return
    }
    quitPreparationStarted = true

    vpnManager.dispose()
    researchRunner.dispose()
    sessionProviders?.dispose()
    sessionProviders = null
    const closingBrowserControl = browserControl?.close()
    browserControl = null

    // before-quit does not wait for promises. Hold the first quit request long
    // enough to durably flush history, then allow the second request through.
    void Promise.all([flushBrowserPersist(), browserHistoryStore.flush(), closingBrowserControl])
      .catch((error) => console.warn('Failed to finish shutdown persistence', error))
      .finally(() => {
        quitReady = true
        app.quit()
      })
  })

  void app.whenReady().then(async () => {
    configureBrowserSession({
      getWindow: () => mainWindow,
      isUserVisibleWebContents: (webContents) =>
        tabManager?.isUserVisibleWebContents(webContents) ?? false
    })
    await browserHistoryStore.load()
    vpnManager.onChange(() => tabManager?.refreshState())
    // Reconnect in the background when the user last left the VPN on; the
    // toolbar shows bootstrap progress while tabs restore in parallel.
    void vpnManager.restoreFromDisk()
    registerIpc()
    createWindow()

    // Stand up the agent's browser control surface and publish its socket path
    // into the environment BEFORE the codex child is spawned. The child inherits
    // process.env (see codex-client spawn), and it only spawns lazily on the
    // first message, so setting it here is always in time. Bound to a getter so
    // it survives window close/reopen swapping the TabManager instance.
    try {
      browserControl = await startBrowserControlServer(() => tabManager, browserAgent, researchRunner)
      process.env.CODEX_BROWSER_SOCK = browserControl.socketPath
      console.log(`Browser control socket: ${browserControl.socketPath}`)
      verificationBrowserControlReady = true
      maybeCloseVerificationInstance()
    } catch (error) {
      console.error('Failed to start browser control server', error)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

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
  const memoryDirectory = join(app.getPath('userData'), 'memory')
  process.env.CODEX_DESKTOP_MEMORY_DIR = memoryDirectory
  const memoryStore = new MemoryStore(memoryDirectory)
  const checkpointStore = new TurnCheckpointStore(join(app.getPath('userData'), 'checkpoints'))
  const mentionIndexService = new MentionIndexService()
  sessionProviders = registerSessionIpc(() => mainWindow, browserAgent, researchRunner, memoryStore, attachmentStore, checkpointStore)
  // Pre-spawn the app-server (Phase 3): async and non-blocking, so the window
  // paints immediately while the child warms in parallel.
  void sessionProviders.codexClient.warmUp()
  const turnTraceStore = new TurnTraceStore(join(app.getPath('userData'), 'turn-traces'))
  const transcriptCache = new TranscriptCache(join(app.getPath('userData'), 'transcript-cache'))

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

  const copySelection = (text: unknown): boolean => {
    if (typeof text !== 'string' || !text.trim() || text.length > 1_000_000) return false
    clipboard.writeText(text)
    return true
  }
  ipcMain.handle(ipcChannels.clipboardWrite, (_event, text: unknown) => copySelection(text))
  ipcMain.on(ipcChannels.browserSelectionCopy, (event, text: unknown) => {
    if (!tabManager?.isUserVisibleWebContents(event.sender)) return
    copySelection(text)
  })

  ipcMain.handle(ipcChannels.workspacePick, async () => {
    if (!mainWindow) {
      return null
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose workspace folder',
      properties: ['openDirectory', 'createDirectory']
    })

    const picked = result.canceled ? null : (result.filePaths[0] ?? null)
    // A user-picked folder is a legitimate mention root even outside git.
    if (picked) await mentionIndexService.approveWorkspace(picked)
    return picked
  })
  ipcMain.handle(ipcChannels.artifactReadImage, async (_event, params: ArtifactReadImageParams): Promise<ArtifactReadImageResult> => ({
    dataUrl: await cdpArtifactStore.readImageDataUrl(params.artifactPath)
  }))
  ipcMain.handle(ipcChannels.artifactOpenImage, async (_event, params: ArtifactReadImageParams): Promise<boolean> => {
    const dataUrl = await cdpArtifactStore.readImageDataUrl(params.artifactPath)
    if (!dataUrl || !tabManager) return false
    tabManager.createTab(dataUrl)
    return true
  })
  ipcMain.handle(ipcChannels.imageViewPreview, async (_event, params: ImageViewPreviewParams): Promise<ImageViewPreviewResult> => ({
    dataUrl: await readImageViewDataUrl(params.path)
  }))
  ipcMain.handle(ipcChannels.attachmentPick, async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add images or files',
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: 'Supported files',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'csv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'sh', 'sql', 'log', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf']
      }]
    })
    if (result.canceled) return []
    const inputs: AttachmentSaveInput[] = await Promise.all(result.filePaths.map(async (path) => ({
      name: path.split(/[\\/]/).pop() ?? 'attachment',
      mediaType: 'application/octet-stream',
      data: new Uint8Array(await readFile(path))
    })))
    return attachmentStore.persistFiles(inputs)
  })
  ipcMain.handle(ipcChannels.attachmentSave, (_event, files: AttachmentSaveInput[]) =>
    attachmentStore.persistFiles(files)
  )
  ipcMain.handle(ipcChannels.attachmentPreview, async (_event, params: AttachmentPreviewParams): Promise<AttachmentPreviewResult> => ({
    dataUrl: await attachmentStore.preview(params.path)
  }))
  ipcMain.handle(ipcChannels.attachmentOpen, async (_event, params: AttachmentPreviewParams): Promise<boolean> => {
    const dataUrl = await attachmentStore.preview(params.path)
    if (!dataUrl || !tabManager) return false
    tabManager.createTab(dataUrl)
    return true
  })
  ipcMain.handle(ipcChannels.browserNewTab, (_event, url?: string) => tabManager?.createTab(url))
  ipcMain.handle(ipcChannels.browserCloseTab, (_event, tabId: string) => tabManager?.closeTab(tabId))
  ipcMain.handle(ipcChannels.browserActivateTab, (_event, tabId: string) => tabManager?.activateTab(tabId))
  // Address-bar input goes through the strict interpreter: dangerous schemes
  // (javascript:, file:, data:) become searches instead of navigations.
  ipcMain.handle(ipcChannels.browserNavigate, (_event, tabId: string, input: string) => {
    tabManager?.navigate(tabId, describeNavigationInput(String(input ?? '')).url)
  })
  ipcMain.handle(ipcChannels.browserBack, (_event, tabId: string) => tabManager?.goBack(tabId))
  ipcMain.handle(ipcChannels.browserForward, (_event, tabId: string) => tabManager?.goForward(tabId))
  ipcMain.handle(ipcChannels.browserReload, (_event, tabId: string) => tabManager?.reload(tabId))
  ipcMain.handle(ipcChannels.browserFind, (_event, tabId: string, text: string, forward: boolean) =>
    tabManager?.find(tabId, text, forward))
  ipcMain.handle(ipcChannels.browserStopFind, (_event, tabId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection') =>
    tabManager?.stopFind(tabId, action))
  ipcMain.handle(ipcChannels.browserZoom, (_event, tabId: string, direction: 'in' | 'out' | 'reset') =>
    tabManager?.zoom(tabId, direction))
  ipcMain.handle(ipcChannels.browserToggleMute, (_event, tabId: string) => tabManager?.toggleMute(tabId))
  ipcMain.handle(ipcChannels.browserSetBounds, (_event, bounds: BrowserBounds) => tabManager?.setBounds(bounds))
  ipcMain.handle(ipcChannels.browserBeginDividerDrag, () => tabManager?.beginDividerDrag())
  ipcMain.handle(ipcChannels.browserEndDividerDrag, (_event, bounds: BrowserBounds) => tabManager?.endDividerDrag(bounds))
  ipcMain.handle(ipcChannels.browserSetOverlayOpen, (_event, open: boolean) => tabManager?.setOverlayOpen(open))
  ipcMain.handle(
    ipcChannels.browserOmniboxQuery,
    (_event, text: string, anchor: OmniboxAnchor): OmniboxQueryResult => {
      const input = String(text ?? '')
      const entries = browserHistoryStore.entries()
      const suggestions = buildSuggestions(input, entries)

      if (suggestions.length > 0) {
        omniboxPopup?.show(anchor, suggestions)
      } else {
        omniboxPopup?.hide()
      }

      return { suggestions, inline: inlineCompletion(input, entries) }
    }
  )
  ipcMain.handle(ipcChannels.browserOmniboxSelect, (_event, index: number) => omniboxPopup?.setSelection(index))
  ipcMain.handle(ipcChannels.browserOmniboxClose, () => omniboxPopup?.hide())

  ipcMain.handle(
    ipcChannels.notificationBackgroundTurn,
    (_event, params: BackgroundTurnNotificationParams): void => {
      const window = mainWindow
      if (!window || window.isFocused() || !Notification.isSupported()) return

      const notification = new Notification({
        title: params.status === 'failed' ? `${params.title} failed` : `${params.title} finished`,
        body: params.message?.trim() || (params.status === 'failed' ? 'The background turn failed.' : 'The background turn completed.'),
        silent: false
      })
      notification.on('click', () => {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      })
      notification.show()
    }
  )

  ipcMain.handle(ipcChannels.tracePersist, (_event, params: TracePersistParams) =>
    turnTraceStore.persist(params)
  )
  ipcMain.handle(ipcChannels.traceLoad, (_event, params: TraceLoadParams) =>
    turnTraceStore.load(params.threadId, params.turnId)
  )
  ipcMain.handle(ipcChannels.transcriptCacheLoad, async (_event, threadId: string): Promise<unknown | null> => {
    const snapshots = await transcriptCache.read(threadId)
    return snapshots.at(-1) ?? null
  })
  ipcMain.handle(ipcChannels.transcriptCachePersist, (_event, params: TranscriptCachePersistParams) =>
    transcriptCache.replace(params.threadId, [params.snapshot])
  )
  ipcMain.handle(ipcChannels.checkpointList, async (_event, threadId: string): Promise<CheckpointSummary[]> => {
    const records = await checkpointStore.list(threadId)
    return records.map(({ id, threadId: recordThreadId, turnId, label, createdAt }) => ({
      id,
      threadId: recordThreadId,
      turnId,
      label,
      createdAt
    }))
  })
  ipcMain.handle(ipcChannels.checkpointRevert, async (_event, params: CheckpointRevertParams): Promise<void> => {
    await checkpointStore.revert(params.checkpointId)
  })
  ipcMain.handle(ipcChannels.checkpointRevertFiles, async (_event, params: CheckpointRevertFilesParams): Promise<void> => {
    await checkpointStore.revertFiles(params.checkpointId, params.paths)
  })
  ipcMain.handle(ipcChannels.mentionIndex, (_event, params: MentionIndexParams): Promise<MentionIndexResult> =>
    mentionIndexService.index(params.workspace)
  )
  ipcMain.handle(ipcChannels.mentionRead, (_event, params: MentionReadParams): Promise<MentionReadIpcResult> =>
    mentionIndexService.read(params.workspace, params.path, params.kind)
  )
  ipcMain.handle(ipcChannels.checkpointChangedFiles, async (_event, params: CheckpointChangedFilesParams): Promise<string[] | null> => {
    const record = await checkpointStore.find(params.threadId, params.turnId)
    // null = detection unavailable (no checkpoint for this turn — typically a
    // non-git workspace), distinct from a genuinely empty diff. The audit
    // trigger uses the difference to explain itself instead of silently idling.
    return record ? checkpointStore.changedFiles(record.id) : null
  })

  ipcMain.handle(ipcChannels.traceSave, async (_event, params: TraceSaveParams): Promise<TraceSaveResult> => {
    if (!mainWindow) {
      return { saved: false }
    }

    const suggestedName = sanitizeTraceFileName(params.suggestedName)
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save turn trace',
      defaultPath: suggestedName,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })

    if (result.canceled || !result.filePath) {
      return { saved: false }
    }

    await writeFile(result.filePath, params.content, 'utf8')
    return { saved: true, path: result.filePath }
  })
}

function sanitizeTraceFileName(name: string): string {
  const cleaned = name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'codex-turn-trace'
  return cleaned.toLowerCase().endsWith('.json') ? cleaned : `${cleaned}.json`
}
