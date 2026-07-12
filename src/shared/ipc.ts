import type { ReasoningEffort } from './codex-protocol/ReasoningEffort'
import type { AgentEvent } from './agent'

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
  /** Reasoning effort override for this turn and subsequent turns. */
  effort?: ReasoningEffort | null
  /** Native app-server collaboration mode for this turn and subsequent turns. */
  collaborationMode?: 'default' | 'plan'
}

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ClaudeSendMessageParams = {
  threadId?: string | null
  text: string
  attachments?: ChatAttachment[]
  cwd?: string | null
  model?: string | null
  effort?: ClaudeEffort | null
  collaborationMode?: 'default' | 'plan'
}

export type ClaudeStartThreadParams = {
  cwd?: string | null
  model?: string | null
  effort?: ClaudeEffort | null
  collaborationMode?: 'default' | 'plan'
}

export type ClaudeListThreadsParams = {
  cwd?: string | null
}

export type ClaudeInterruptTurnParams = {
  threadId: string
  turnId: string
}

export type ClaudeSteerTurnParams = ClaudeInterruptTurnParams & { text: string }

export type ClaudeEvent = AgentEvent & { provider: 'claude' }

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
  codexListInstalledPlugins: 'codex:listInstalledPlugins',
  codexListPlugins: 'codex:listPlugins',
  codexReadPlugin: 'codex:readPlugin',
  codexGetPluginAppStatuses: 'codex:getPluginAppStatuses',
  codexInstallPlugin: 'codex:installPlugin',
  codexUninstallPlugin: 'codex:uninstallPlugin',
  codexEvent: 'codex:event',
  claudeGetAuthStatus: 'claude:getAuthStatus',
  claudeListModels: 'claude:listModels',
  claudeListThreads: 'claude:listThreads',
  claudeStartThread: 'claude:startThread',
  claudeResumeThread: 'claude:resumeThread',
  claudeReadThread: 'claude:readThread',
  claudeSendMessage: 'claude:sendMessage',
  claudeSteerTurn: 'claude:steerTurn',
  claudeInterruptTurn: 'claude:interruptTurn',
  claudeEvent: 'claude:event',
  memoryPersist: 'memory:persist',
  tracePersist: 'trace:persist',
  traceLoad: 'trace:load',
  traceSave: 'trace:save',
  artifactReadImage: 'artifact:readImage',
  artifactOpenImage: 'artifact:openImage',
  attachmentPick: 'attachment:pick',
  attachmentSave: 'attachment:save',
  attachmentPreview: 'attachment:preview',
  attachmentOpen: 'attachment:open',
  notificationBackgroundTurn: 'notification:backgroundTurn',
  workspacePick: 'workspace:pick'
} as const
import type { ThreadGoalSetParams } from './codex-protocol/v2/ThreadGoalSetParams.js'
