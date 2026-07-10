import { contextBridge, ipcRenderer } from 'electron'
import type {
  BrowserBounds,
  BrowserState,
  CodexEvent,
  CodexInterruptTurnParams,
  CodexListThreadsParams,
  CodexSendMessageParams,
  CodexSteerTurnParams,
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
    setBounds: (bounds: BrowserBounds) => ipcRenderer.invoke(ipcChannels.browserSetBounds, bounds),
    beginDividerDrag: () => ipcRenderer.invoke(ipcChannels.browserBeginDividerDrag),
    endDividerDrag: (bounds: BrowserBounds) => ipcRenderer.invoke(ipcChannels.browserEndDividerDrag, bounds),
    setOverlayOpen: (open: boolean) => ipcRenderer.invoke(ipcChannels.browserSetOverlayOpen, open),
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
    startThread: (cwd?: string | null) => ipcRenderer.invoke(ipcChannels.codexStartThread, cwd),
    resumeThread: (threadId: string) => ipcRenderer.invoke(ipcChannels.codexResumeThread, threadId),
    readThread: (threadId: string) => ipcRenderer.invoke(ipcChannels.codexReadThread, threadId),
    sendMessage: (params: CodexSendMessageParams) => ipcRenderer.invoke(ipcChannels.codexSendMessage, params),
    steerTurn: (params: CodexSteerTurnParams) => ipcRenderer.invoke(ipcChannels.codexSteerTurn, params),
    interruptTurn: (params: CodexInterruptTurnParams) => ipcRenderer.invoke(ipcChannels.codexInterruptTurn, params),
    unsubscribeThread: (threadId: string) => ipcRenderer.invoke(ipcChannels.codexUnsubscribeThread, threadId),
    onEvent: (listener: (event: CodexEvent) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, event: CodexEvent): void => listener(event)
      ipcRenderer.on(ipcChannels.codexEvent, wrapped)
      return () => {
        ipcRenderer.off(ipcChannels.codexEvent, wrapped)
      }
    }
  },
  trace: {
    save: (params: TraceSaveParams): Promise<TraceSaveResult> => ipcRenderer.invoke(ipcChannels.traceSave, params)
  },
  workspace: {
    pick: (): Promise<string | null> => ipcRenderer.invoke(ipcChannels.workspacePick)
  }
}

contextBridge.exposeInMainWorld('api', api)
