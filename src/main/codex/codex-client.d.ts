import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import type { GetAuthStatusResponse } from '../../shared/codex-protocol/GetAuthStatusResponse.js';
import type { ThreadListResponse } from '../../shared/codex-protocol/v2/ThreadListResponse.js';
import type { ThreadReadResponse } from '../../shared/codex-protocol/v2/ThreadReadResponse.js';
import type { ThreadResumeResponse } from '../../shared/codex-protocol/v2/ThreadResumeResponse.js';
import type { ThreadStartResponse } from '../../shared/codex-protocol/v2/ThreadStartResponse.js';
import type { TurnStartResponse } from '../../shared/codex-protocol/v2/TurnStartResponse.js';
export declare class CodexClient extends EventEmitter {
    private readonly getWindow;
    private child;
    private startPromise;
    private readonly pending;
    private requestCounter;
    constructor(getWindow: () => BrowserWindow | null);
    getAuthStatus(): Promise<GetAuthStatusResponse>;
    listThreads(): Promise<ThreadListResponse>;
    startThread(cwd?: string | null): Promise<ThreadStartResponse>;
    resumeThread(threadId: string): Promise<ThreadResumeResponse>;
    readThread(threadId: string): Promise<ThreadReadResponse>;
    sendMessage(threadId: string | null | undefined, text: string, cwd?: string | null): Promise<TurnStartResponse & {
        threadId: string;
    }>;
    interruptTurn(threadId: string, turnId: string): Promise<unknown>;
    dispose(): void;
    private ensureStarted;
    private start;
    private request;
    private notify;
    private handleLine;
    private handleResponse;
    private handleServerRequest;
    private respond;
    private respondError;
    private write;
    private emitStatus;
    private rejectPending;
}
