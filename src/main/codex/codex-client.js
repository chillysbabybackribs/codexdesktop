import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
export class CodexClient extends EventEmitter {
    getWindow;
    child = null;
    startPromise = null;
    pending = new Map();
    pendingApprovals = new Map();
    requestCounter = 0;
    autoApprove = false;
    constructor(getWindow) {
        super();
        this.getWindow = getWindow;
    }
    async getAuthStatus() {
        await this.ensureStarted();
        return this.request('getAuthStatus', {
            includeToken: false,
            refreshToken: false
        });
    }
    async listThreads() {
        await this.ensureStarted();
        return this.request('thread/list', {
            limit: 30,
            sortKey: 'recency_at',
            sortDirection: 'desc',
            archived: false
        });
    }
    async startThread(cwd) {
        await this.ensureStarted();
        return this.request('thread/start', {
            cwd: cwd ?? process.env.HOME ?? process.cwd(),
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            historyMode: 'legacy'
        });
    }
    async resumeThread(threadId) {
        await this.ensureStarted();
        return this.request('thread/resume', {
            threadId,
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write'
        });
    }
    async readThread(threadId) {
        await this.ensureStarted();
        return this.request('thread/read', {
            threadId,
            includeTurns: true
        });
    }
    async sendMessage(threadId, text, cwd) {
        const activeThreadId = threadId ?? (await this.startThread(cwd)).thread.id;
        const response = await this.request('turn/start', {
            threadId: activeThreadId,
            input: [
                {
                    type: 'text',
                    text,
                    text_elements: []
                }
            ],
            approvalPolicy: 'on-request'
        });
        return { ...response, threadId: activeThreadId };
    }
    async interruptTurn(threadId, turnId) {
        await this.ensureStarted();
        this.cancelPendingApprovals(threadId);
        return this.request('turn/interrupt', { threadId, turnId });
    }
    setAutoApprove(enabled) {
        this.autoApprove = enabled;
        if (!enabled) {
            return;
        }
        // Flipping auto-approve on resolves anything already waiting on the user.
        for (const [id, approval] of this.pendingApprovals) {
            this.pendingApprovals.delete(id);
            this.respond(id, this.approvalResponse(approval, 'accept'));
            this.emit('event', { type: 'approvalResolved', requestId: id });
        }
    }
    respondToApproval(requestId, decision) {
        const approval = this.pendingApprovals.get(requestId);
        if (!approval) {
            return;
        }
        this.pendingApprovals.delete(requestId);
        this.respond(requestId, this.approvalResponse(approval, decision));
        this.emit('event', { type: 'approvalResolved', requestId });
    }
    dispose() {
        this.child?.kill();
        this.child = null;
    }
    async ensureStarted() {
        if (this.child && !this.child.killed) {
            this.emitStatus('ready');
            return;
        }
        if (this.startPromise) {
            return this.startPromise;
        }
        this.startPromise = this.start();
        try {
            await this.startPromise;
        }
        finally {
            this.startPromise = null;
        }
    }
    async start() {
        this.emitStatus('starting');
        const child = spawn('codex', ['app-server', '--stdio'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env
        });
        this.child = child;
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            const message = String(chunk).trim();
            if (message) {
                console.warn(`codex app-server: ${message}`);
            }
        });
        child.on('exit', (code, signal) => {
            this.child = null;
            const message = `codex app-server exited (${code ?? signal ?? 'unknown'})`;
            this.emitStatus('exited', message);
            this.rejectPending(new Error(message));
            this.dropPendingApprovals();
        });
        child.on('error', (error) => {
            this.child = null;
            this.emitStatus('error', error.message);
            this.rejectPending(error);
            this.dropPendingApprovals();
        });
        const lines = createInterface({ input: child.stdout });
        lines.on('line', (line) => this.handleLine(line));
        await this.request('initialize', {
            clientInfo: {
                name: 'codexdesktop',
                title: 'Codex Desktop',
                version: '0.1.0'
            },
            capabilities: {
                experimentalApi: true,
                requestAttestation: false,
                optOutNotificationMethods: [
                    'rawResponseItem/completed',
                    'thread/realtime/started',
                    'thread/realtime/itemAdded',
                    'thread/realtime/transcript/delta',
                    'thread/realtime/transcript/done',
                    'thread/realtime/outputAudio/delta',
                    'thread/realtime/sdp',
                    'thread/realtime/error',
                    'thread/realtime/closed'
                ]
            }
        });
        this.notify('initialized');
        this.emitStatus('ready');
    }
    request(method, params) {
        const id = `codexdesktop-${++this.requestCounter}`;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve: (value) => resolve(value),
                reject
            });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }
    notify(method, params) {
        this.write({ jsonrpc: '2.0', method, params });
    }
    handleLine(line) {
        if (!line.trim()) {
            return;
        }
        let message;
        try {
            message = JSON.parse(line);
        }
        catch (error) {
            console.warn('Ignoring non-JSON app-server line', { line, error });
            return;
        }
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            this.handleResponse(message);
            return;
        }
        if (message.id !== undefined && message.method) {
            this.handleServerRequest(message);
            return;
        }
        if (message.method) {
            const notification = message;
            this.emit('event', {
                type: 'notification',
                notification
            });
        }
    }
    handleResponse(message) {
        const pending = this.pending.get(message.id);
        if (!pending) {
            return;
        }
        this.pending.delete(message.id);
        if (message.error) {
            pending.reject(new Error(message.error.message));
        }
        else {
            pending.resolve(message.result);
        }
    }
    handleServerRequest(message) {
        switch (message.method) {
            case 'item/commandExecution/requestApproval':
            case 'item/fileChange/requestApproval':
            case 'item/permissions/requestApproval':
            case 'applyPatchApproval':
            case 'execCommandApproval':
                this.handleApprovalRequest(message.id, message.method, message.params);
                return;
            case 'item/tool/requestUserInput':
                this.respond(message.id, { answers: {} });
                return;
            case 'currentTime/read':
                this.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
                return;
            default:
                this.respondError(message.id, -32601, `Unsupported app-server request: ${message.method}`);
        }
    }
    handleApprovalRequest(id, method, params) {
        const request = describeApproval(id, method, params);
        const approval = { method, threadId: request.threadId, params };
        if (this.autoApprove) {
            this.respond(id, this.approvalResponse(approval, 'accept'));
            return;
        }
        this.pendingApprovals.set(id, approval);
        this.emit('event', { type: 'approvalRequest', request });
    }
    approvalResponse(approval, decision) {
        switch (approval.method) {
            case 'item/commandExecution/requestApproval':
            case 'item/fileChange/requestApproval':
                return { decision };
            case 'applyPatchApproval':
            case 'execCommandApproval':
                return {
                    decision: decision === 'accept' ? 'approved' : decision === 'acceptForSession' ? 'approved_for_session' : 'denied'
                };
            case 'item/permissions/requestApproval': {
                if (decision === 'decline') {
                    return { permissions: {}, scope: 'turn' };
                }
                const params = approval.params;
                return {
                    permissions: {
                        network: params.permissions.network ?? undefined,
                        fileSystem: params.permissions.fileSystem ?? undefined
                    },
                    scope: decision === 'acceptForSession' ? 'session' : 'turn'
                };
            }
        }
    }
    cancelPendingApprovals(threadId) {
        for (const [id, approval] of this.pendingApprovals) {
            if (approval.threadId !== threadId) {
                continue;
            }
            this.pendingApprovals.delete(id);
            this.respond(id, cancelResponse(approval.method));
            this.emit('event', { type: 'approvalResolved', requestId: id });
        }
    }
    dropPendingApprovals() {
        for (const id of this.pendingApprovals.keys()) {
            this.emit('event', { type: 'approvalResolved', requestId: id });
        }
        this.pendingApprovals.clear();
    }
    respond(id, result) {
        this.write({ jsonrpc: '2.0', id, result });
    }
    respondError(id, code, message) {
        this.write({ jsonrpc: '2.0', id, error: { code, message } });
    }
    write(message) {
        if (!this.child) {
            throw new Error('codex app-server is not running');
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    emitStatus(status, message) {
        this.emit('event', {
            type: 'status',
            status,
            message
        });
    }
    rejectPending(error) {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }
}
function describeApproval(id, method, params) {
    switch (method) {
        case 'item/commandExecution/requestApproval': {
            const p = params;
            return {
                requestId: id,
                method,
                threadId: p.threadId,
                command: p.command ?? undefined,
                cwd: p.cwd ?? undefined,
                reason: p.reason ?? undefined
            };
        }
        case 'item/fileChange/requestApproval': {
            const p = params;
            return {
                requestId: id,
                method,
                threadId: p.threadId,
                reason: p.reason ?? undefined,
                grantRoot: p.grantRoot ?? undefined
            };
        }
        case 'item/permissions/requestApproval': {
            const p = params;
            return {
                requestId: id,
                method,
                threadId: p.threadId,
                cwd: p.cwd,
                reason: p.reason ?? undefined,
                permissionsSummary: JSON.stringify(p.permissions, null, 2)
            };
        }
        case 'applyPatchApproval': {
            const p = params;
            return {
                requestId: id,
                method,
                threadId: p.conversationId,
                reason: p.reason ?? undefined,
                grantRoot: p.grantRoot ?? undefined,
                files: Object.keys(p.fileChanges)
            };
        }
        case 'execCommandApproval': {
            const p = params;
            return {
                requestId: id,
                method,
                threadId: p.conversationId,
                command: p.command.join(' '),
                cwd: p.cwd,
                reason: p.reason ?? undefined
            };
        }
    }
}
function cancelResponse(method) {
    switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
            return { decision: 'cancel' };
        case 'applyPatchApproval':
        case 'execCommandApproval':
            return { decision: 'abort' };
        case 'item/permissions/requestApproval':
            return { permissions: {}, scope: 'turn' };
    }
}
