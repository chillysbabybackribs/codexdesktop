import { contextBridge, ipcRenderer } from 'electron'
import type {
  ArtifactReadImageParams,
  ArtifactReadImageResult,
  AttachmentPreviewParams,
  AttachmentPreviewResult,
  AttachmentSaveInput,
  ChatAttachment,
  BackgroundTurnNotificationParams,
  BrowserBounds,
  BrowserFindResult,
  BrowserState,
  CodexEvent,
  CodexInterruptTurnParams,
  CodexListThreadsParams,
  CodexSendMessageParams,
  CodexSetGoalParams,
  CodexStartThreadParams,
  CodexSteerTurnParams,
  MemoryPersistParams,
  OmniboxAnchor,
  OmniboxSuggestion,
  TraceLoadParams,
  TracePersistParams,
  TraceSaveParams,
  TraceSaveResult
} from '../shared/ipc.js'
import { ipcChannels } from '../shared/ipc.js'

export const api = {
  window: {
    minimize: () => ipcRenderer.invoke(ipcChannels.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(ipcChannels.windowToggleMaximize),
    close: () => ipcRenderer.invoke(ipcChannels.windowClose)
  },
  browser: {
    newTab: (url?: string) => ipcRenderer.invoke(ipcChannels.browserNewTab, url),
    closeTab: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserCloseTab, tabId),
    activateTab: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserActivateTab, tabId),
    navigate: (tabId: string, input: string) => ipcRenderer.invoke(ipcChannels.browserNavigate, tabId, input),
    back: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserBack, tabId),
    forward: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserForward, tabId),
    reload: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserReload, tabId),
    find: (tabId: string, text: string, forward = true): Promise<BrowserFindResult> =>
      ipcRenderer.invoke(ipcChannels.browserFind, tabId, text, forward),
    stopFind: (tabId: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'keepSelection') =>
      ipcRenderer.invoke(ipcChannels.browserStopFind, tabId, action),
    zoom: (tabId: string, direction: 'in' | 'out' | 'reset') =>
      ipcRenderer.invoke(ipcChannels.browserZoom, tabId, direction),
    toggleMute: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserToggleMute, tabId),
    onFindRequested: (listener: () => void) => {
      const wrapped = (): void => listener()
      ipcRenderer.on(ipcChannels.browserFindRequested, wrapped)
      return () => {
        ipcRenderer.off(ipcChannels.browserFindRequested, wrapped)
      }
    },
    setBounds: (bounds: BrowserBounds) => ipcRenderer.invoke(ipcChannels.browserSetBounds, bounds),
    beginDividerDrag: () => ipcRenderer.invoke(ipcChannels.browserBeginDividerDrag),
    endDividerDrag: (bounds: BrowserBounds) => ipcRenderer.invoke(ipcChannels.browserEndDividerDrag, bounds),
    setOverlayOpen: (open: boolean) => ipcRenderer.invoke(ipcChannels.browserSetOverlayOpen, open),
    omniboxQuery: (text: string, anchor: OmniboxAnchor): Promise<OmniboxSuggestion[]> =>
      ipcRenderer.invoke(ipcChannels.browserOmniboxQuery, text, anchor),
    omniboxSelect: (index: number) => ipcRenderer.invoke(ipcChannels.browserOmniboxSelect, index),
    omniboxClose: () => ipcRenderer.invoke(ipcChannels.browserOmniboxClose),
    onFocusOmnibox: (listener: () => void) => {
      const wrapped = (): void => listener()
      ipcRenderer.on(ipcChannels.browserFocusOmnibox, wrapped)
      return () => {
        ipcRenderer.off(ipcChannels.browserFocusOmnibox, wrapped)
      }
    },
    onState: (listener: (state: BrowserState) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: BrowserState): void => listener(state)
      ipcRenderer.on(ipcChannels.browserState, wrapped)
      return () => {
        ipcRenderer.off(ipcChannels.browserState, wrapped)
      }
    }
  },
  codex: {
    getAuthStatus: () => ipcRenderer.invoke(ipcChannels.codexGetAuthStatus),
    listModels: () => ipcRenderer.invoke(ipcChannels.codexListModels),
    listThreads: (params?: CodexListThreadsParams) =>
      ipcRenderer.invoke(ipcChannels.codexListThreads, params),
    startThread: (params?: CodexStartThreadParams) => ipcRenderer.invoke(ipcChannels.codexStartThread, params),
    resumeThread: (threadId: string) => ipcRenderer.invoke(ipcChannels.codexResumeThread, threadId),
    readThread: (threadId: string) => ipcRenderer.invoke(ipcChannels.codexReadThread, threadId),
    getGoal: (threadId: string) => ipcRenderer.invoke(ipcChannels.codexGetGoal, threadId),
    setGoal: (params: CodexSetGoalParams) => ipcRenderer.invoke(ipcChannels.codexSetGoal, params),
    clearGoal: (threadId: string) => ipcRenderer.invoke(ipcChannels.codexClearGoal, threadId),
    sendMessage: (params: CodexSendMessageParams) => ipcRenderer.invoke(ipcChannels.codexSendMessage, params),
    steerTurn: (params: CodexSteerTurnParams) => ipcRenderer.invoke(ipcChannels.codexSteerTurn, params),
    interruptTurn: (params: CodexInterruptTurnParams) => ipcRenderer.invoke(ipcChannels.codexInterruptTurn, params),
    compactThread: (threadId: string): Promise<{ started: boolean }> =>
      ipcRenderer.invoke(ipcChannels.codexCompactThread, threadId),
    unsubscribeThread: (threadId: string) => ipcRenderer.invoke(ipcChannels.codexUnsubscribeThread, threadId),
    onEvent: (listener: (event: CodexEvent) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, event: CodexEvent): void => listener(event)
      ipcRenderer.on(ipcChannels.codexEvent, wrapped)
      return () => {
        ipcRenderer.off(ipcChannels.codexEvent, wrapped)
      }
    }
  },
  memory: {
    persist: (params: MemoryPersistParams): Promise<void> => ipcRenderer.invoke(ipcChannels.memoryPersist, params)
  },
  trace: {
    persist: (params: TracePersistParams): Promise<void> => ipcRenderer.invoke(ipcChannels.tracePersist, params),
    load: (params: TraceLoadParams): Promise<string | null> => ipcRenderer.invoke(ipcChannels.traceLoad, params),
    save: (params: TraceSaveParams): Promise<TraceSaveResult> => ipcRenderer.invoke(ipcChannels.traceSave, params)
  },
  artifact: {
    readImage: (params: ArtifactReadImageParams): Promise<ArtifactReadImageResult> =>
      ipcRenderer.invoke(ipcChannels.artifactReadImage, params)
  },
  attachments: {
    pick: (): Promise<ChatAttachment[]> => ipcRenderer.invoke(ipcChannels.attachmentPick),
    save: (files: AttachmentSaveInput[]): Promise<ChatAttachment[]> =>
      ipcRenderer.invoke(ipcChannels.attachmentSave, files),
    preview: (params: AttachmentPreviewParams): Promise<AttachmentPreviewResult> =>
      ipcRenderer.invoke(ipcChannels.attachmentPreview, params),
    open: (params: AttachmentPreviewParams): Promise<boolean> =>
      ipcRenderer.invoke(ipcChannels.attachmentOpen, params)
  },
  notifications: {
    backgroundTurn: (params: BackgroundTurnNotificationParams): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.notificationBackgroundTurn, params)
  },
  workspace: {
    pick: (): Promise<string | null> => ipcRenderer.invoke(ipcChannels.workspacePick)
  }
}

contextBridge.exposeInMainWorld('api', api)
