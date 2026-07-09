import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const taskShapingGuidance = [
    'Codex Desktop task-shaping guidance:',
    '- Start by organizing the task in the visible reasoning or plan stream before tool use when the task benefits from planning.',
    '- Decide whether a formal plan is necessary. For trivial tasks, briefly note the direct path and proceed.',
    '- For non-trivial tasks, reason about the goal, available tools, needed context, efficient execution order, and verification before acting.',
    '- Keep the plan updated when observations from tools change the best path.',
    '- Treat this as task-process shaping only; do not change personality, tone, or final-answer style.'
];
// The visible embedded browser is exposed to you as a local Unix-socket HTTP
// endpoint you drive from the shell — not a fixed tool set. You write whatever
// JS the task needs and run it IN the live page, getting structured JSON back in
// the same call. This block is only included when the socket is up.
function browserControlGuidance() {
    const sock = process.env.CODEX_BROWSER_SOCK;
    if (!sock) {
        return [];
    }
    return [
        'Embedded browser control (the browser pane the user is watching):',
        `- It is a local HTTP server on the Unix socket at ${sock}. Drive it from your shell; there are no browser tools to call.`,
        '- Run arbitrary JS in the ACTIVE tab and get its return value as JSON (one call can fill+submit+read-back a whole form):',
        `    curl -s --unix-socket "${sock}" http://x/eval --data-binary 'const f=document.forms[0]; f.q.value="hello"; f.submit(); return {url:location.href};'`,
        '  The body IS the JS. `return` a value; returned promises are awaited, so do the whole operation in one program and read the resulting state back.',
        '- Discover tabs: `curl -s --unix-socket "$SOCK" http://x/tabs`. Target a specific tab: add `?tab=<id>` to /eval, or `{"tab":"<id>"}` to /cdp.',
        '- Tab control: POST JSON to http://x/tabs with {"action":"create"|"close"|"activate"|"navigate", url|input, tab}.',
        '- For what page JS cannot do (trusted input events, network intercept, real load-idle waits, screenshots): POST {"method","params","tab"} to http://x/cdp to send a raw Chrome DevTools Protocol command.',
        '- Prefer expressing the whole task as one page program over many small round-trips. Read the DOM once, act once, verify in the same return.'
    ];
}
function buildGuidance() {
    return [...taskShapingGuidance, ...browserControlGuidance()].join('\n');
}
export class CodexClient extends EventEmitter {
    getWindow;
    child = null;
    startPromise = null;
    pending = new Map();
    requestCounter = 0;
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
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            historyMode: 'legacy',
            developerInstructions: buildGuidance()
        });
    }
    async resumeThread(threadId) {
        await this.ensureStarted();
        return this.request('thread/resume', {
            threadId,
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            developerInstructions: buildGuidance()
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
            summary: 'auto',
            additionalContext: {
                codexdesktop_reasoning_guidance: {
                    kind: 'application',
                    value: buildGuidance()
                }
            },
            approvalPolicy: 'never'
        });
        return { ...response, threadId: activeThreadId };
    }
    async interruptTurn(threadId, turnId) {
        await this.ensureStarted();
        return this.request('turn/interrupt', { threadId, turnId });
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
        });
        child.on('error', (error) => {
            this.child = null;
            this.emitStatus('error', error.message);
            this.rejectPending(error);
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
    // The app runs fully unrestricted (approvalPolicy: 'never', danger-full-access)
    // BY DESIGN, so app-server never asks the user to approve commands, file
    // changes, or permissions. We only answer the non-approval server requests it
    // still makes; anything else (including any stray approval request) is denied.
    handleServerRequest(message) {
        switch (message.method) {
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
