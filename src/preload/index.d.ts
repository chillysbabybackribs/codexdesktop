import type {
  BrowserBounds,
  BrowserState,
  CodexEvent,
  CodexInterruptTurnParams,
  CodexSendMessageParams
} from '../shared/ipc'
import type { GetAuthStatusResponse } from '../shared/codex-protocol/GetAuthStatusResponse'
import type { ThreadListResponse } from '../shared/codex-protocol/v2/ThreadListResponse'
import type { ThreadReadResponse } from '../shared/codex-protocol/v2/ThreadReadResponse'
import type { ThreadResumeResponse } from '../shared/codex-protocol/v2/ThreadResumeResponse'
import type { ThreadStartResponse } from '../shared/codex-protocol/v2/ThreadStartResponse'
import type { TurnStartResponse } from '../shared/codex-protocol/v2/TurnStartResponse'

declare global {
  interface Window {
    api: {
      window: {
        minimize: () => Promise<void>
        toggleMaximize: () => Promise<void>
        close: () => Promise<void>
      }
      browser: {
        newTab: (url?: string) => Promise<string>
        closeTab: (tabId: string) => Promise<void>
        activateTab: (tabId: string) => Promise<void>
        navigate: (tabId: string, input: string) => Promise<void>
        back: (tabId: string) => Promise<void>
        forward: (tabId: string) => Promise<void>
        reload: (tabId: string) => Promise<void>
        setBounds: (bounds: BrowserBounds) => Promise<void>
        beginDividerDrag: () => Promise<void>
        endDividerDrag: (bounds: BrowserBounds) => Promise<void>
        onState: (listener: (state: BrowserState) => void) => () => void
      }
      codex: {
        getAuthStatus: () => Promise<GetAuthStatusResponse>
        listThreads: () => Promise<ThreadListResponse>
        startThread: () => Promise<ThreadStartResponse>
        resumeThread: (threadId: string) => Promise<ThreadResumeResponse>
        readThread: (threadId: string) => Promise<ThreadReadResponse>
        sendMessage: (params: CodexSendMessageParams) => Promise<TurnStartResponse & { threadId: string }>
        interruptTurn: (params: CodexInterruptTurnParams) => Promise<unknown>
        onEvent: (listener: (event: CodexEvent) => void) => () => void
      }
    }
  }
}

export {}
