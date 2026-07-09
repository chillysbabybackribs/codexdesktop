export type BrowserBounds = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export type BrowserTabState = {
    id: string;
    title: string;
    url: string;
    isLoading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
};
export type BrowserState = {
    tabs: BrowserTabState[];
    activeTabId: string | null;
};
export type CodexConnectionStatus = 'idle' | 'starting' | 'ready' | 'exited' | 'error';
export type CodexStatusEvent = {
    type: 'status';
    status: CodexConnectionStatus;
    message?: string;
};
export type CodexNotificationEvent = {
    type: 'notification';
    notification: unknown;
};
export type CodexApprovalMethod = 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval' | 'item/permissions/requestApproval' | 'applyPatchApproval' | 'execCommandApproval';
export type CodexApprovalRequest = {
    requestId: string | number;
    method: CodexApprovalMethod;
    threadId: string;
    command?: string;
    cwd?: string;
    reason?: string;
    grantRoot?: string;
    files?: string[];
    permissionsSummary?: string;
};
export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline';
export type CodexApprovalRequestEvent = {
    type: 'approvalRequest';
    request: CodexApprovalRequest;
};
export type CodexApprovalResolvedEvent = {
    type: 'approvalResolved';
    requestId: string | number;
};
export type CodexEvent = CodexStatusEvent | CodexNotificationEvent | CodexApprovalRequestEvent | CodexApprovalResolvedEvent;
export type CodexSendMessageParams = {
    threadId?: string | null;
    text: string;
    cwd?: string | null;
};
export type CodexRespondApprovalParams = {
    requestId: string | number;
    decision: CodexApprovalDecision;
};
export type CodexInterruptTurnParams = {
    threadId: string;
    turnId: string;
};
export declare const ipcChannels: {
    readonly windowMinimize: 'window:minimize';
    readonly windowToggleMaximize: 'window:toggleMaximize';
    readonly windowClose: 'window:close';
    readonly browserNewTab: 'browser:newTab';
    readonly browserCloseTab: 'browser:closeTab';
    readonly browserActivateTab: 'browser:activateTab';
    readonly browserNavigate: 'browser:navigate';
    readonly browserBack: 'browser:back';
    readonly browserForward: 'browser:forward';
    readonly browserReload: 'browser:reload';
    readonly browserSetBounds: 'browser:setBounds';
    readonly browserBeginDividerDrag: 'browser:beginDividerDrag';
    readonly browserEndDividerDrag: 'browser:endDividerDrag';
    readonly browserSetOverlayOpen: 'browser:setOverlayOpen';
    readonly browserState: 'browser:state';
    readonly codexGetAuthStatus: 'codex:getAuthStatus';
    readonly codexListThreads: 'codex:listThreads';
    readonly codexStartThread: 'codex:startThread';
    readonly codexResumeThread: 'codex:resumeThread';
    readonly codexReadThread: 'codex:readThread';
    readonly codexSendMessage: 'codex:sendMessage';
    readonly codexInterruptTurn: 'codex:interruptTurn';
    readonly codexRespondApproval: 'codex:respondApproval';
    readonly codexSetAutoApprove: 'codex:setAutoApprove';
    readonly codexEvent: 'codex:event';
    readonly workspacePick: 'workspace:pick';
};
