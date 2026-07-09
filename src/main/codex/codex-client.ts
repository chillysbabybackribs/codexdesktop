import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import type { CodexConnectionStatus, CodexEvent } from '../../shared/ipc.js'
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

export class CodexClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private readonly pending = new Map<string | number, PendingRequest>()
  private requestCounter = 0

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

  async startThread(): Promise<ThreadStartResponse> {
    await this.ensureStarted()
    return this.request<ThreadStartResponse>('thread/start', {
      cwd: process.env.HOME ?? process.cwd(),
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      historyMode: 'legacy'
    })
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    await this.ensureStarted()
    return this.request<ThreadResumeResponse>('thread/resume', {
      threadId,
      approvalPolicy: 'never',
      sandbox: 'workspace-write'
    })
  }

  async readThread(threadId: string): Promise<ThreadReadResponse> {
    await this.ensureStarted()
    return this.request<ThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: true
    })
  }

  async sendMessage(threadId: string | null | undefined, text: string): Promise<TurnStartResponse & { threadId: string }> {
    const activeThreadId = threadId ?? (await this.startThread()).thread.id

    const response = await this.request<TurnStartResponse>('turn/start', {
      threadId: activeThreadId,
      input: [
        {
          type: 'text',
          text,
          text_elements: []
        }
      ],
      approvalPolicy: 'never'
    })

    return { ...response, threadId: activeThreadId }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    await this.ensureStarted()
    return this.request('turn/interrupt', { threadId, turnId })
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
    })

    child.on('error', (error) => {
      this.child = null
      this.emitStatus('error', error.message)
      this.rejectPending(error)
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
        this.respond(message.id!, { decision: 'accept' })
        return
      case 'item/fileChange/requestApproval':
        this.respond(message.id!, { decision: 'accept' })
        return
      case 'applyPatchApproval':
      case 'execCommandApproval':
        this.respond(message.id!, { decision: 'approved' })
        return
      case 'item/permissions/requestApproval':
        this.respond(message.id!, {
          permissions: {
            network: message.params.permissions.network ?? undefined,
            fileSystem: message.params.permissions.fileSystem ?? undefined
          },
          scope: 'session'
        })
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
