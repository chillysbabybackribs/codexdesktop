import { contextBridge, ipcRenderer } from 'electron';
import type {
  ArtifactReadImageParams,
  ArtifactReadImageResult,
  AttachmentPreviewParams,
  AttachmentPreviewResult,
  AttachmentSaveInput,
  ImageViewPreviewParams,
  ImageViewPreviewResult,
  ChatAttachment,
  BackgroundTurnNotificationParams,
  BrowserBounds,
  BrowserFindResult,
  BrowserMenuAnchor,
  BrowserMenuItem,
  TitlebarCalendarAnchor,
  BrowserState,
  BrowserVpnStatus,
  SessionEvent,
  CodexInterruptTurnParams,
  CodexListThreadTurnsParams,
  CodexListThreadsParams,
  CodexPluginAppStatusParams,
  CodexPluginAppStatusResponse,
  CodexPluginInstallParams,
  CodexPluginQueryParams,
  CodexPluginReadParams,
  CodexResumeThreadParams,
  CodexSendMessageParams,
  CodexSetGoalParams,
  CodexStartThreadParams,
  CodexSteerTurnParams,
  MemoryPersistParams,
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
  TraceSaveResult,
} from '../shared/ipc.js';
import type { PluginInstalledResponse } from '../shared/codex-protocol/v2/PluginInstalledResponse.js';
import type { PluginListResponse } from '../shared/codex-protocol/v2/PluginListResponse.js';
import type { PluginInstallResponse } from '../shared/codex-protocol/v2/PluginInstallResponse.js';
import type { PluginReadResponse } from '../shared/codex-protocol/v2/PluginReadResponse.js';
import { ipcChannels } from '../shared/ipc.js';

export const api = {
  runtime: {
    instanceRole:
      process.env.CODEX_DESKTOP_INSTANCE_ROLE === 'verification'
        ? ('verification' as const)
        : ('host' as const),
    sessionId: process.env.CODEX_DESKTOP_HOST_SESSION_ID ?? '',
  },
  clipboard: {
    writeText: (text: string): Promise<boolean> =>
      ipcRenderer.invoke(ipcChannels.clipboardWrite, text),
  },
  window: {
    minimize: () => ipcRenderer.invoke(ipcChannels.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(ipcChannels.windowToggleMaximize),
    close: () => ipcRenderer.invoke(ipcChannels.windowClose),
  },
  titlebarCalendar: {
    open: (anchor: TitlebarCalendarAnchor) =>
      ipcRenderer.invoke(ipcChannels.titlebarCalendarOpen, anchor),
    close: () => ipcRenderer.invoke(ipcChannels.titlebarCalendarClose),
    onClosed: (listener: () => void) => {
      const wrapped = (): void => listener();
      ipcRenderer.on(ipcChannels.titlebarCalendarClosed, wrapped);
      return () => {
        ipcRenderer.off(ipcChannels.titlebarCalendarClosed, wrapped);
      };
    },
  },
  browser: {
    newTab: (url?: string): Promise<string | undefined> =>
      ipcRenderer.invoke(ipcChannels.browserNewTab, url),
    closeTab: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserCloseTab, tabId),
    activateTab: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserActivateTab, tabId),
    navigate: (tabId: string, input: string) =>
      ipcRenderer.invoke(ipcChannels.browserNavigate, tabId, input),
    back: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserBack, tabId),
    forward: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserForward, tabId),
    reload: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserReload, tabId),
    find: (tabId: string, text: string, forward = true): Promise<BrowserFindResult> =>
      ipcRenderer.invoke(ipcChannels.browserFind, tabId, text, forward),
    stopFind: (
      tabId: string,
      action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'keepSelection',
    ) => ipcRenderer.invoke(ipcChannels.browserStopFind, tabId, action),
    zoom: (tabId: string, direction: 'in' | 'out' | 'reset') =>
      ipcRenderer.invoke(ipcChannels.browserZoom, tabId, direction),
    toggleMute: (tabId: string) => ipcRenderer.invoke(ipcChannels.browserToggleMute, tabId),
    toggleVpn: (): Promise<BrowserVpnStatus> => ipcRenderer.invoke(ipcChannels.browserToggleVpn),
    onFindRequested: (listener: () => void) => {
      const wrapped = (): void => listener();
      ipcRenderer.on(ipcChannels.browserFindRequested, wrapped);
      return () => {
        ipcRenderer.off(ipcChannels.browserFindRequested, wrapped);
      };
    },
    onFullscreenToggleRequested: (listener: () => void) => {
      const wrapped = (): void => listener();
      ipcRenderer.on(ipcChannels.browserFullscreenToggleRequested, wrapped);
      return () => {
        ipcRenderer.off(ipcChannels.browserFullscreenToggleRequested, wrapped);
      };
    },
    setBounds: (bounds: BrowserBounds) => ipcRenderer.invoke(ipcChannels.browserSetBounds, bounds),
    beginDividerDrag: () => ipcRenderer.invoke(ipcChannels.browserBeginDividerDrag),
    endDividerDrag: (bounds: BrowserBounds) =>
      ipcRenderer.invoke(ipcChannels.browserEndDividerDrag, bounds),
    setOverlayOpen: (open: boolean) => ipcRenderer.invoke(ipcChannels.browserSetOverlayOpen, open),
    omniboxQuery: (text: string, anchor: OmniboxAnchor): Promise<OmniboxQueryResult> =>
      ipcRenderer.invoke(ipcChannels.browserOmniboxQuery, text, anchor),
    omniboxSelect: (index: number) => ipcRenderer.invoke(ipcChannels.browserOmniboxSelect, index),
    omniboxClose: () => ipcRenderer.invoke(ipcChannels.browserOmniboxClose),
    onHistoryRemoved: (listener: (url: string) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, url: string): void => listener(url);
      ipcRenderer.on(ipcChannels.browserHistoryRemoved, wrapped);
      return () => {
        ipcRenderer.off(ipcChannels.browserHistoryRemoved, wrapped);
      };
    },
    menuOpen: (anchor: BrowserMenuAnchor, items: BrowserMenuItem[]) =>
      ipcRenderer.invoke(ipcChannels.browserMenuOpen, anchor, items),
    menuUpdate: (items: BrowserMenuItem[]) =>
      ipcRenderer.invoke(ipcChannels.browserMenuUpdate, items),
    menuClose: () => ipcRenderer.invoke(ipcChannels.browserMenuClose),
    onMenuClosed: (listener: () => void) => {
      const wrapped = (): void => listener();
      ipcRenderer.on(ipcChannels.browserMenuClosed, wrapped);
      return () => {
        ipcRenderer.off(ipcChannels.browserMenuClosed, wrapped);
      };
    },
    onFocusOmnibox: (listener: () => void) => {
      const wrapped = (): void => listener();
      ipcRenderer.on(ipcChannels.browserFocusOmnibox, wrapped);
      return () => {
        ipcRenderer.off(ipcChannels.browserFocusOmnibox, wrapped);
      };
    },
    onState: (listener: (state: BrowserState) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: BrowserState): void =>
        listener(state);
      ipcRenderer.on(ipcChannels.browserState, wrapped);
      return () => {
        ipcRenderer.off(ipcChannels.browserState, wrapped);
      };
    },
  },
  session: {
    getAuthStatus: () => ipcRenderer.invoke(ipcChannels.sessionGetAuthStatus),
    listModels: () => ipcRenderer.invoke(ipcChannels.sessionListModels),
    listThreads: (params?: CodexListThreadsParams) =>
      ipcRenderer.invoke(ipcChannels.sessionListThreads, params),
    startThread: (params?: CodexStartThreadParams) =>
      ipcRenderer.invoke(ipcChannels.sessionStartThread, params),
    resumeThread: (params: CodexResumeThreadParams) =>
      ipcRenderer.invoke(ipcChannels.sessionResumeThread, params),
    listThreadTurns: (params: CodexListThreadTurnsParams) =>
      ipcRenderer.invoke(ipcChannels.sessionListThreadTurns, params),
    getGoal: (threadId: string) => ipcRenderer.invoke(ipcChannels.sessionGetGoal, threadId),
    setGoal: (params: CodexSetGoalParams) => ipcRenderer.invoke(ipcChannels.sessionSetGoal, params),
    clearGoal: (threadId: string) => ipcRenderer.invoke(ipcChannels.sessionClearGoal, threadId),
    sendMessage: (params: CodexSendMessageParams) =>
      ipcRenderer.invoke(ipcChannels.sessionSendMessage, params),
    steerTurn: (params: CodexSteerTurnParams) =>
      ipcRenderer.invoke(ipcChannels.sessionSteerTurn, params),
    interruptTurn: (params: CodexInterruptTurnParams) =>
      ipcRenderer.invoke(ipcChannels.sessionInterruptTurn, params),
    compactThread: (threadId: string): Promise<{ started: boolean }> =>
      ipcRenderer.invoke(ipcChannels.sessionCompactThread, threadId),
    unsubscribeThread: (threadId: string) =>
      ipcRenderer.invoke(ipcChannels.sessionUnsubscribeThread, threadId),
    listInstalledPlugins: (params?: CodexPluginQueryParams): Promise<PluginInstalledResponse> =>
      ipcRenderer.invoke(ipcChannels.sessionListInstalledPlugins, params),
    listPlugins: (params?: CodexPluginQueryParams): Promise<PluginListResponse> =>
      ipcRenderer.invoke(ipcChannels.sessionListPlugins, params),
    readPlugin: (params: CodexPluginReadParams): Promise<PluginReadResponse> =>
      ipcRenderer.invoke(ipcChannels.sessionReadPlugin, params),
    getPluginAppStatuses: (
      params: CodexPluginAppStatusParams,
    ): Promise<CodexPluginAppStatusResponse> =>
      ipcRenderer.invoke(ipcChannels.sessionGetPluginAppStatuses, params),
    installPlugin: (params: CodexPluginInstallParams): Promise<PluginInstallResponse> =>
      ipcRenderer.invoke(ipcChannels.sessionInstallPlugin, params),
    uninstallPlugin: (pluginId: string): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.sessionUninstallPlugin, pluginId),
    onEvent: (listener: (event: SessionEvent) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, event: SessionEvent): void =>
        listener(event);
      ipcRenderer.on(ipcChannels.sessionEvent, wrapped);
      return () => {
        ipcRenderer.off(ipcChannels.sessionEvent, wrapped);
      };
    },
  },
  memory: {
    persist: (params: MemoryPersistParams): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.memoryPersist, params),
  },
  trace: {
    persist: (params: TracePersistParams): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.tracePersist, params),
    load: (params: TraceLoadParams): Promise<string | null> =>
      ipcRenderer.invoke(ipcChannels.traceLoad, params),
    save: (params: TraceSaveParams): Promise<TraceSaveResult> =>
      ipcRenderer.invoke(ipcChannels.traceSave, params),
  },
  transcriptCache: {
    load: (threadId: string): Promise<unknown | null> =>
      ipcRenderer.invoke(ipcChannels.transcriptCacheLoad, threadId),
    persist: (params: TranscriptCachePersistParams): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.transcriptCachePersist, params),
  },
  checkpoints: {
    list: (threadId: string): Promise<CheckpointSummary[]> =>
      ipcRenderer.invoke(ipcChannels.checkpointList, threadId),
    revert: (params: CheckpointRevertParams): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.checkpointRevert, params),
    revertFiles: (params: CheckpointRevertFilesParams): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.checkpointRevertFiles, params),
    changedFiles: (params: CheckpointChangedFilesParams): Promise<string[] | null> =>
      ipcRenderer.invoke(ipcChannels.checkpointChangedFiles, params),
  },
  mentions: {
    index: (params: MentionIndexParams): Promise<MentionIndexResult> =>
      ipcRenderer.invoke(ipcChannels.mentionIndex, params),
    read: (params: MentionReadParams): Promise<MentionReadIpcResult> =>
      ipcRenderer.invoke(ipcChannels.mentionRead, params),
  },
  artifact: {
    readImage: (params: ArtifactReadImageParams): Promise<ArtifactReadImageResult> =>
      ipcRenderer.invoke(ipcChannels.artifactReadImage, params),
    openImage: (params: ArtifactReadImageParams): Promise<boolean> =>
      ipcRenderer.invoke(ipcChannels.artifactOpenImage, params),
  },
  imageView: {
    preview: (params: ImageViewPreviewParams): Promise<ImageViewPreviewResult> =>
      ipcRenderer.invoke(ipcChannels.imageViewPreview, params),
  },
  attachments: {
    pick: (): Promise<ChatAttachment[]> => ipcRenderer.invoke(ipcChannels.attachmentPick),
    save: (files: AttachmentSaveInput[]): Promise<ChatAttachment[]> =>
      ipcRenderer.invoke(ipcChannels.attachmentSave, files),
    preview: (params: AttachmentPreviewParams): Promise<AttachmentPreviewResult> =>
      ipcRenderer.invoke(ipcChannels.attachmentPreview, params),
    open: (params: AttachmentPreviewParams): Promise<boolean> =>
      ipcRenderer.invoke(ipcChannels.attachmentOpen, params),
  },
  notifications: {
    backgroundTurn: (params: BackgroundTurnNotificationParams): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.notificationBackgroundTurn, params),
  },
  workspace: {
    pick: (): Promise<string | null> => ipcRenderer.invoke(ipcChannels.workspacePick),
  },
};

contextBridge.exposeInMainWorld('api', api);
