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

export type CodexEvent = CodexStatusEvent | CodexNotificationEvent

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
}

export type CodexStartThreadParams = {
  cwd?: string | null
  model?: string | null
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
  codexGetAuthStatus: 'codex:getAuthStatus',
  codexListModels: 'codex:listModels',
  codexListThreads: 'codex:listThreads',
  codexStartThread: 'codex:startThread',
  codexResumeThread: 'codex:resumeThread',
  codexReadThread: 'codex:readThread',
  codexGetGoal: 'codex:getGoal',
  codexSetGoal: 'codex:setGoal',
  codexClearGoal: 'codex:clearGoal',
  codexSendMessage: 'codex:sendMessage',
  codexSteerTurn: 'codex:steerTurn',
  codexInterruptTurn: 'codex:interruptTurn',
  codexCompactThread: 'codex:compactThread',
  codexUnsubscribeThread: 'codex:unsubscribeThread',
  codexEvent: 'codex:event',
  memoryPersist: 'memory:persist',
  tracePersist: 'trace:persist',
  traceLoad: 'trace:load',
  traceSave: 'trace:save',
  artifactReadImage: 'artifact:readImage',
  attachmentPick: 'attachment:pick',
  attachmentSave: 'attachment:save',
  attachmentPreview: 'attachment:preview',
  attachmentOpen: 'attachment:open',
  notificationBackgroundTurn: 'notification:backgroundTurn',
  workspacePick: 'workspace:pick'
} as const
import type { ThreadGoalSetParams } from './codex-protocol/v2/ThreadGoalSetParams.js'
