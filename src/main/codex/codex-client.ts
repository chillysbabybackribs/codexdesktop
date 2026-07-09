import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import type {
  CodexApprovalDecision,
  CodexApprovalMethod,
  CodexApprovalRequest,
  CodexConnectionStatus,
  CodexEvent
} from '../../shared/ipc.js'
import type { ApplyPatchApprovalParams } from '../../shared/codex-protocol/ApplyPatchApprovalParams.js'
import type { ExecCommandApprovalParams } from '../../shared/codex-protocol/ExecCommandApprovalParams.js'
import type { CommandExecutionRequestApprovalParams } from '../../shared/codex-protocol/v2/CommandExecutionRequestApprovalParams.js'
import type { FileChangeRequestApprovalParams } from '../../shared/codex-protocol/v2/FileChangeRequestApprovalParams.js'
import type { PermissionsRequestApprovalParams } from '../../shared/codex-protocol/v2/PermissionsRequestApprovalParams.js'
import type { GetAuthStatusResponse } from '../../shared/codex-protocol/GetAuthStatusResponse.js'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification.js'
import type { ServerRequest } from '../../shared/codex-protocol/ServerRequest.js'
import type { ThreadListResponse } from '../../shared/codex-protocol/v2/ThreadListResponse.js'
import type { ThreadReadResponse } from '../../shared/codex-protocol/v2/ThreadReadResponse.js'
import type { ThreadResumeResponse } from '../../shared/codex-protocol/v2/ThreadResumeResponse.js'
import type { ThreadStartResponse } from '../../shared/codex-protocol/v2/ThreadStartResponse.js'
import type { TurnStartResponse } from '../../shared/codex-protocol/v2/TurnStartResponse.js'

type JsonRpcMessage = {
  jsonrpc?: '2.0'
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

type PendingApproval = {
  method: CodexApprovalMethod
  threadId: string
  params: unknown
}

const reasoningGuidance = [
  'Codex Desktop task-shaping guidance:',
  '- Start by organizing the task in the visible reasoning or plan stream before tool use when the task benefits from planning.',
  '- Decide whether a formal plan is necessary. For trivial tasks, briefly note the direct path and proceed.',
  '- For non-trivial tasks, reason about the goal, available tools, needed context, efficient execution order, and verification before acting.',
  '- Keep the plan updated when observations from tools change the best path.',
  '- Treat this as task-process shaping only; do not change personality, tone, or final-answer style.'
].join('\n')

export class CodexClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private readonly pending = new Map<string | number, PendingRequest>()
  private readonly pendingApprovals = new Map<string | number, PendingApproval>()
  private requestCounter = 0
  private autoApprove = false

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    super()
  }

  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    await this.ensureStarted()
    return this.request<GetAuthStatusResponse>('getAuthStatus', {
      includeToken: false,
      refreshToken: false
    })
  }

  async listThreads(): Promise<ThreadListResponse> {
    await this.ensureStarted()
    return this.request<ThreadListResponse>('thread/list', {
      limit: 30,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: false
    })
  }

  async startThread(cwd?: string | null): Promise<ThreadStartResponse> {
    await this.ensureStarted()
    return this.request<ThreadStartResponse>('thread/start', {
      cwd: cwd ?? process.env.HOME ?? process.cwd(),
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      historyMode: 'legacy',
      developerInstructions: reasoningGuidance
    })
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    await this.ensureStarted()
    return this.request<ThreadResumeResponse>('thread/resume', {
      threadId,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      developerInstructions: reasoningGuidance
    })
  }

  async readThread(threadId: string): Promise<ThreadReadResponse> {
    await this.ensureStarted()
    return this.request<ThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: true
    })
  }

  async sendMessage(
    threadId: string | null | undefined,
    text: string,
    cwd?: string | null
  ): Promise<TurnStartResponse & { threadId: string }> {
    const activeThreadId = threadId ?? (await this.startThread(cwd)).thread.id

    const response = await this.request<TurnStartResponse>('turn/start', {
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
          value: reasoningGuidance
        }
      },
      approvalPolicy: 'on-request'
    })

    return { ...response, threadId: activeThreadId }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    await this.ensureStarted()
    this.cancelPendingApprovals(threadId)
    return this.request('turn/interrupt', { threadId, turnId })
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled

    if (!enabled) {
      return
    }

    // Flipping auto-approve on resolves anything already waiting on the user.
    for (const [id, approval] of this.pendingApprovals) {
      this.pendingApprovals.delete(id)
      this.respond(id, this.approvalResponse(approval, 'accept'))
      this.emit('event', { type: 'approvalResolved', requestId: id } satisfies CodexEvent)
    }
  }

  respondToApproval(requestId: string | number, decision: CodexApprovalDecision): void {
    const approval = this.pendingApprovals.get(requestId)

    if (!approval) {
      return
    }

    this.pendingApprovals.delete(requestId)
    this.respond(requestId, this.approvalResponse(approval, decision))
    this.emit('event', { type: 'approvalResolved', requestId } satisfies CodexEvent)
  }

  dispose(): void {
    this.child?.kill()
    this.child = null
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.emitStatus('ready')
      return
    }

    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.start()

    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async start(): Promise<void> {
    this.emitStatus('starting')

    const child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })

    this.child = child

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trim()

      if (message) {
        console.warn(`codex app-server: ${message}`)
      }
    })

    child.on('exit', (code, signal) => {
      this.child = null
      const message = `codex app-server exited (${code ?? signal ?? 'unknown'})`
      this.emitStatus('exited', message)
      this.rejectPending(new Error(message))
      this.dropPendingApprovals()
    })

    child.on('error', (error) => {
      this.child = null
      this.emitStatus('error', error.message)
      this.rejectPending(error)
      this.dropPendingApprovals()
    })

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.handleLine(line))

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
    })
    this.notify('initialized')
    this.emitStatus('ready')
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = `codexdesktop-${++this.requestCounter}`

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return
    }

    let message: JsonRpcMessage

    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch (error) {
      console.warn('Ignoring non-JSON app-server line', { line, error })
      return
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      this.handleResponse(message)
      return
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message as ServerRequest & JsonRpcMessage)
      return
    }

    if (message.method) {
      const notification = message as ServerNotification
      this.emit('event', {
        type: 'notification',
        notification
      } satisfies CodexEvent)
    }
  }

  private handleResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id!)

    if (!pending) {
      return
    }

    this.pending.delete(message.id!)

    if (message.error) {
      pending.reject(new Error(message.error.message))
    } else {
      pending.resolve(message.result)
    }
  }

  private handleServerRequest(message: ServerRequest & JsonRpcMessage): void {
    switch (message.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
      case 'applyPatchApproval':
      case 'execCommandApproval':
        this.handleApprovalRequest(message.id!, message.method, message.params)
        return
      case 'item/tool/requestUserInput':
        this.respond(message.id!, { answers: {} })
        return
      case 'currentTime/read':
        this.respond(message.id!, { currentTimeAt: Math.floor(Date.now() / 1000) })
        return
      default:
        this.respondError(message.id!, -32601, `Unsupported app-server request: ${message.method}`)
    }
  }

  private handleApprovalRequest(id: string | number, method: CodexApprovalMethod, params: unknown): void {
    const request = describeApproval(id, method, params)
    const approval: PendingApproval = { method, threadId: request.threadId, params }

    if (this.autoApprove) {
      this.respond(id, this.approvalResponse(approval, 'accept'))
      return
    }

    this.pendingApprovals.set(id, approval)
    this.emit('event', { type: 'approvalRequest', request } satisfies CodexEvent)
  }

  private approvalResponse(approval: PendingApproval, decision: CodexApprovalDecision): unknown {
    switch (approval.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision }
      case 'applyPatchApproval':
      case 'execCommandApproval':
        return {
          decision:
            decision === 'accept' ? 'approved' : decision === 'acceptForSession' ? 'approved_for_session' : 'denied'
        }
      case 'item/permissions/requestApproval': {
        if (decision === 'decline') {
          return { permissions: {}, scope: 'turn' }
        }

        const params = approval.params as PermissionsRequestApprovalParams
        return {
          permissions: {
            network: params.permissions.network ?? undefined,
            fileSystem: params.permissions.fileSystem ?? undefined
          },
          scope: decision === 'acceptForSession' ? 'session' : 'turn'
        }
      }
    }
  }

  private cancelPendingApprovals(threadId: string): void {
    for (const [id, approval] of this.pendingApprovals) {
      if (approval.threadId !== threadId) {
        continue
      }

      this.pendingApprovals.delete(id)
      this.respond(id, cancelResponse(approval.method))
      this.emit('event', { type: 'approvalResolved', requestId: id } satisfies CodexEvent)
    }
  }

  private dropPendingApprovals(): void {
    for (const id of this.pendingApprovals.keys()) {
      this.emit('event', { type: 'approvalResolved', requestId: id } satisfies CodexEvent)
    }

    this.pendingApprovals.clear()
  }

  private respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  private respondError(id: string | number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child) {
      throw new Error('codex app-server is not running')
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private emitStatus(status: CodexConnectionStatus, message?: string): void {
    this.emit('event', {
      type: 'status',
      status,
      message
    } satisfies CodexEvent)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }

    this.pending.clear()
  }
}

function describeApproval(id: string | number, method: CodexApprovalMethod, params: unknown): CodexApprovalRequest {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const p = params as CommandExecutionRequestApprovalParams
      return {
        requestId: id,
        method,
        threadId: p.threadId,
        command: p.command ?? undefined,
        cwd: p.cwd ?? undefined,
        reason: p.reason ?? undefined
      }
    }
    case 'item/fileChange/requestApproval': {
      const p = params as FileChangeRequestApprovalParams
      return {
        requestId: id,
        method,
        threadId: p.threadId,
        reason: p.reason ?? undefined,
        grantRoot: p.grantRoot ?? undefined
      }
    }
    case 'item/permissions/requestApproval': {
      const p = params as PermissionsRequestApprovalParams
      return {
        requestId: id,
        method,
        threadId: p.threadId,
        cwd: p.cwd,
        reason: p.reason ?? undefined,
        permissionsSummary: JSON.stringify(p.permissions, null, 2)
      }
    }
    case 'applyPatchApproval': {
      const p = params as ApplyPatchApprovalParams
      return {
        requestId: id,
        method,
        threadId: p.conversationId,
        reason: p.reason ?? undefined,
        grantRoot: p.grantRoot ?? undefined,
        files: Object.keys(p.fileChanges)
      }
    }
    case 'execCommandApproval': {
      const p = params as ExecCommandApprovalParams
      return {
        requestId: id,
        method,
        threadId: p.conversationId,
        command: p.command.join(' '),
        cwd: p.cwd,
        reason: p.reason ?? undefined
      }
    }
  }
}

function cancelResponse(method: CodexApprovalMethod): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'cancel' }
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { decision: 'abort' }
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' }
  }
}
