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

export type CodexApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'applyPatchApproval'
  | 'execCommandApproval'

export type CodexApprovalRequest = {
  requestId: string | number
  method: CodexApprovalMethod
  threadId: string
  command?: string
  cwd?: string
  reason?: string
  grantRoot?: string
  files?: string[]
  permissionsSummary?: string
}

export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline'

export type CodexApprovalRequestEvent = {
  type: 'approvalRequest'
  request: CodexApprovalRequest
}

export type CodexApprovalResolvedEvent = {
  type: 'approvalResolved'
  requestId: string | number
}

export type CodexEvent =
  | CodexStatusEvent
  | CodexNotificationEvent
  | CodexApprovalRequestEvent
  | CodexApprovalResolvedEvent

export type CodexSendMessageParams = {
  threadId?: string | null
  text: string
  cwd?: string | null
}

export type CodexRespondApprovalParams = {
  requestId: string | number
  decision: CodexApprovalDecision
}

export type CodexInterruptTurnParams = {
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
  codexListThreads: 'codex:listThreads',
  codexStartThread: 'codex:startThread',
  codexResumeThread: 'codex:resumeThread',
  codexReadThread: 'codex:readThread',
  codexSendMessage: 'codex:sendMessage',
  codexInterruptTurn: 'codex:interruptTurn',
  codexRespondApproval: 'codex:respondApproval',
  codexSetAutoApprove: 'codex:setAutoApprove',
  codexEvent: 'codex:event',
  workspacePick: 'workspace:pick'
} as const
