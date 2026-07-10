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
}

export type BrowserState = {
  tabs: BrowserTabState[]
  activeTabId: string | null
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

export type CodexSendMessageParams = {
  threadId?: string | null
  text: string
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
  browserSetBounds: 'browser:setBounds',
  browserBeginDividerDrag: 'browser:beginDividerDrag',
  browserEndDividerDrag: 'browser:endDividerDrag',
  browserSetOverlayOpen: 'browser:setOverlayOpen',
  browserState: 'browser:state',
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
  codexUnsubscribeThread: 'codex:unsubscribeThread',
  codexEvent: 'codex:event',
  tracePersist: 'trace:persist',
  traceLoad: 'trace:load',
  traceSave: 'trace:save',
  workspacePick: 'workspace:pick'
} as const
import type { ThreadGoalSetParams } from './codex-protocol/v2/ThreadGoalSetParams.js'
