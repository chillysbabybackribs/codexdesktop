import type { ReasoningEffort } from './codex-protocol/ReasoningEffort'

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserTabState = {
  id: string
  title: string
  url: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isAudible: boolean
  isMuted: boolean
  zoomPercent: number
}

export type BrowserFindResult = {
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

export type BrowserState = {
  tabs: BrowserTabState[]
  activeTabId: string | null
}

export type OmniboxSuggestion = {
  kind: 'navigate' | 'search' | 'history'
  /** Full URL this row navigates to when committed. */
  url: string
  /** Primary display text: page title, typed query, or the URL itself. */
  text: string
  /** Secondary display text: display URL for history rows, engine label for search. */
  detail: string
}

/** Dropdown anchor in window content coordinates: the omnibox rect's bottom edge. */
export type OmniboxAnchor = {
  x: number
  y: number
  width: number
}

export type OmniboxRenderPayload = {
  suggestions: OmniboxSuggestion[]
  selectedIndex: number
}

export type OmniboxQueryResult = {
  suggestions: OmniboxSuggestion[]
  /**
   * Full address-bar text to inline-autocomplete (typed prefix preserved), or
   * null when nothing should complete. The renderer shows the remainder as
   * selected text so the next keystroke replaces it.
   */
  inline: string | null
}

export type CodexConnectionStatus = 'idle' | 'starting' | 'ready' | 'exited' | 'error'

export type CodexStatusEvent = {
  type: 'status'
  status: CodexConnectionStatus
  message?: string
}

export type CodexNotificationEvent = {
  type: 'notification'
  notification: unknown
}

export type ResearchProgressStage = 'queued' | 'preparing' | 'discovering' | 'verifying' | 'finalizing' | 'complete'

export type ResearchProgress = {
  stage: ResearchProgressStage
  message: string
  queryIndex?: number
  queryCount?: number
  pagesAttempted?: number
  pagesVerified?: number
  targetPages?: number
}

export type CodexResearchProgressEvent = {
  type: 'researchProgress'
  threadId: string
  turnId: string
  itemId: string
  progress: ResearchProgress
}

export type SessionEvent = CodexStatusEvent | CodexNotificationEvent | CodexResearchProgressEvent
/** @deprecated alias kept for migration; import SessionEvent. */
export type CodexEvent = SessionEvent

export type ChatAttachment = {
  id: string
  kind: 'image' | 'file'
  name: string
  path: string
  mediaType: string
  size: number
}

export type AttachmentSaveInput = {
  name: string
  mediaType: string
  data: Uint8Array
}

export type AttachmentPreviewParams = {
  path: string
}

export type AttachmentPreviewResult = {
  dataUrl: string | null
}

export type ImageViewPreviewParams = {
  path: string
}

export type ImageViewPreviewResult = {
  dataUrl: string | null
}

export type CodexSendMessageParams = {
  threadId?: string | null
  text: string
  attachments?: ChatAttachment[]
  cwd?: string | null
  /**
   * Model slug to run the turn with. Omitted/null keeps the CLI-configured
   * default (or whatever the thread was last switched to server-side).
   */
  model?: string | null
  /** Reasoning effort override for this turn and subsequent turns. */
  effort?: ReasoningEffort | null
  /** Opt-in: downshift supported simple requests while retaining the selected effort for substantive work. */
  fastMode?: boolean
}

export type CodexStartThreadParams = {
  cwd?: string | null
  model?: string | null
}

export type CodexResumeThreadParams = {
  threadId: string
  history: 'main' | 'background' | 'agent'
}

export type CodexListThreadTurnsParams = {
  threadId: string
  cursor: string
  limit?: number
}

export type CodexSetGoalParams = ThreadGoalSetParams

export type CodexInterruptTurnParams = {
  threadId: string
  turnId: string
}

export type CodexSteerTurnParams = {
  threadId: string
  turnId: string
  text: string
}

export type CodexListThreadsParams = {
  cursor?: string | null
  cwd?: string | null
}

export type CodexPluginQueryParams = {
  cwd?: string | null
}

export type CodexPluginInstallParams = {
  pluginName: string
  marketplacePath?: string | null
  remoteMarketplaceName?: string | null
}

export type CodexPluginReadParams = CodexPluginInstallParams

export type CodexPluginAppStatusParams = {
  appIds: string[]
  forceRefetch?: boolean
}

export type CodexPluginAppStatus = {
  id: string
  name: string
  installUrl: string | null
  isAccessible: boolean
  isEnabled: boolean
}

export type CodexPluginAppStatusResponse = {
  apps: CodexPluginAppStatus[]
}

export type MemoryPersistParams = {
  threadId: string
  title: string
  workspace: string | null
  updatedAt: string
  turns: Array<{
    user: string
    assistant: string
    completedWork?: string[]
  }>
}

export type TraceSaveParams = {
  suggestedName: string
  content: string
}

export type TraceSaveResult = {
  saved: boolean
  path?: string
}

export type TracePersistParams = {
  threadId: string
  turnId: string
  content: string
}

export type ArtifactReadImageParams = {
  artifactPath: string
}

export type ArtifactReadImageResult = {
  dataUrl: string | null
}

export type BackgroundTurnNotificationParams = {
  threadId: string
  title: string
  status: 'completed' | 'failed'
  message?: string | null
}

export type TraceLoadParams = {
  threadId: string
  turnId: string
}

export type TranscriptCachePersistParams = {
  threadId: string
  snapshot: unknown
}

export type CheckpointSummary = {
  id: string
  threadId: string
  turnId: string | null
  label: string
  createdAt: number
}

export type CheckpointRevertParams = {
  checkpointId: string
}

export type CheckpointChangedFilesParams = {
  threadId: string
  turnId: string
}

export const ipcChannels = {
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  browserNewTab: 'browser:newTab',
  browserCloseTab: 'browser:closeTab',
  browserActivateTab: 'browser:activateTab',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserFind: 'browser:find',
  browserStopFind: 'browser:stopFind',
  browserFindRequested: 'browser:findRequested',
  browserZoom: 'browser:zoom',
  browserToggleMute: 'browser:toggleMute',
  browserSetBounds: 'browser:setBounds',
  browserBeginDividerDrag: 'browser:beginDividerDrag',
  browserEndDividerDrag: 'browser:endDividerDrag',
  browserSetOverlayOpen: 'browser:setOverlayOpen',
  browserState: 'browser:state',
  browserOmniboxQuery: 'browser:omniboxQuery',
  browserOmniboxSelect: 'browser:omniboxSelect',
  browserOmniboxClose: 'browser:omniboxClose',
  browserOmniboxCommit: 'browser:omniboxCommit',
  browserOmniboxRender: 'browser:omniboxRender',
  browserFocusOmnibox: 'browser:focusOmnibox',
  browserSelectionCopy: 'browser:selectionCopy',
  clipboardWrite: 'clipboard:write',
  sessionGetAuthStatus: 'session:getAuthStatus',
  sessionListModels: 'session:listModels',
  sessionListThreads: 'session:listThreads',
  sessionStartThread: 'session:startThread',
  sessionResumeThread: 'session:resumeThread',
  sessionListThreadTurns: 'session:listThreadTurns',
  sessionGetGoal: 'session:getGoal',
  sessionSetGoal: 'session:setGoal',
  sessionClearGoal: 'session:clearGoal',
  sessionSendMessage: 'session:sendMessage',
  sessionSteerTurn: 'session:steerTurn',
  sessionInterruptTurn: 'session:interruptTurn',
  sessionCompactThread: 'session:compactThread',
  sessionUnsubscribeThread: 'session:unsubscribeThread',
  sessionListInstalledPlugins: 'session:listInstalledPlugins',
  sessionListPlugins: 'session:listPlugins',
  sessionReadPlugin: 'session:readPlugin',
  sessionGetPluginAppStatuses: 'session:getPluginAppStatuses',
  sessionInstallPlugin: 'session:installPlugin',
  sessionUninstallPlugin: 'session:uninstallPlugin',
  sessionEvent: 'session:event',
  memoryPersist: 'memory:persist',
  tracePersist: 'trace:persist',
  traceLoad: 'trace:load',
  traceSave: 'trace:save',
  transcriptCacheLoad: 'transcript-cache:load',
  transcriptCachePersist: 'transcript-cache:persist',
  checkpointList: 'checkpoint:list',
  checkpointRevert: 'checkpoint:revert',
  checkpointChangedFiles: 'checkpoint:changedFiles',
  artifactReadImage: 'artifact:readImage',
  artifactOpenImage: 'artifact:openImage',
  imageViewPreview: 'image-view:preview',
  attachmentPick: 'attachment:pick',
  attachmentSave: 'attachment:save',
  attachmentPreview: 'attachment:preview',
  attachmentOpen: 'attachment:open',
  notificationBackgroundTurn: 'notification:backgroundTurn',
  workspacePick: 'workspace:pick'
} as const
import type { ThreadGoalSetParams } from './codex-protocol/v2/ThreadGoalSetParams.js'
