import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import type { CodexConnectionStatus, CodexEvent } from '../../shared/ipc.js'
import type { GetAuthStatusResponse } from '../../shared/codex-protocol/GetAuthStatusResponse.js'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification.js'
import type { ServerRequest } from '../../shared/codex-protocol/ServerRequest.js'
import type { DynamicToolCallParams } from '../../shared/codex-protocol/v2/DynamicToolCallParams.js'
import type { DynamicToolCallResponse } from '../../shared/codex-protocol/v2/DynamicToolCallResponse.js'
import type { Model } from '../../shared/codex-protocol/v2/Model.js'
import type { ModelListResponse } from '../../shared/codex-protocol/v2/ModelListResponse.js'
import type { ThreadListResponse } from '../../shared/codex-protocol/v2/ThreadListResponse.js'
import type { ThreadReadResponse } from '../../shared/codex-protocol/v2/ThreadReadResponse.js'
import type { ThreadResumeResponse } from '../../shared/codex-protocol/v2/ThreadResumeResponse.js'
import type { ThreadStartResponse } from '../../shared/codex-protocol/v2/ThreadStartResponse.js'
import type { ThreadUnsubscribeResponse } from '../../shared/codex-protocol/v2/ThreadUnsubscribeResponse.js'
import type { TurnStartResponse } from '../../shared/codex-protocol/v2/TurnStartResponse.js'
import {
  browserDynamicTools,
  buildGuidance,
  legacyResumeConfig,
  newThreadConfig,
  resolveTurnPolicy
} from './codex-config.js'

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
  timer: ReturnType<typeof setTimeout>
}

const requestTimeoutMs = 30_000

function localSkillsRoot(): string {
  return join(app.getAppPath(), 'skills')
}

export class CodexClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private readonly pending = new Map<string | number, PendingRequest>()
  private requestCounter = 0

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly browserAgent: BrowserAgentController,
    private readonly researchRunner: ResearchRunner
  ) {
    super()
  }

  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    await this.ensureStarted()
    return this.request<GetAuthStatusResponse>('getAuthStatus', {
      includeToken: false,
      refreshToken: false
    })
  }

  async listModels(): Promise<Model[]> {
    await this.ensureStarted()
    const models: Model[] = []
    let cursor: string | null = null

    do {
      const page: ModelListResponse = await this.request<ModelListResponse>('model/list', {
        ...(cursor ? { cursor } : {})
      })
      models.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)

    return models.filter((model) => !model.hidden)
  }

  async listThreads(options?: { cursor?: string | null; cwd?: string | null }): Promise<ThreadListResponse> {
    await this.ensureStarted()
    return this.request<ThreadListResponse>('thread/list', {
      limit: 30,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: false,
      ...(options?.cursor ? { cursor: options.cursor } : {}),
      ...(options?.cwd ? { cwd: options.cwd } : {})
    })
  }

  async startThread(cwd?: string | null, model?: string | null): Promise<ThreadStartResponse> {
    await this.ensureStarted()
    return this.request<ThreadStartResponse>('thread/start', {
      cwd: cwd ?? process.env.HOME ?? process.cwd(),
      ...(model ? { model } : {}),
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      historyMode: 'legacy',
      config: newThreadConfig,
      dynamicTools: browserDynamicTools,
      developerInstructions: buildGuidance()
    })
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    await this.ensureStarted()
    return this.request<ThreadResumeResponse>('thread/resume', {
      threadId,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: legacyResumeConfig,
      developerInstructions: buildGuidance(),
      // Keep resume metadata small. The initial page is the renderer's
      // bounded bootstrap payload; requesting populated thread.turns as well
      // duplicates that history and makes large persisted chats feel frozen.
      excludeTurns: true,
      initialTurnsPage: {
        limit: 500,
        sortDirection: 'asc',
        itemsView: 'full'
      }
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
    cwd?: string | null,
    model?: string | null
  ): Promise<TurnStartResponse & { threadId: string }> {
    const activeThreadId = threadId ?? (await this.startThread(cwd, model)).thread.id

    // `model` overrides this turn and all subsequent turns on the thread, so
    // sending it every turn keeps resumed threads on the picker's selection.
    const response = await this.request<TurnStartResponse>('turn/start', {
      threadId: activeThreadId,
      input: [
        {
          type: 'text',
          text,
          text_elements: []
        }
      ],
      ...(model ? { model } : {}),
      ...resolveTurnPolicy(text),
      approvalPolicy: 'never'
    })

    return { ...response, threadId: activeThreadId }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    await this.ensureStarted()
    this.researchRunner.cancel(turnId)
    return this.request('turn/interrupt', { threadId, turnId })
  }

  async steerTurn(threadId: string, turnId: string, text: string): Promise<unknown> {
    await this.ensureStarted()
    return this.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text, text_elements: [] }]
    })
  }

  async unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeResponse> {
    await this.ensureStarted()
    return this.request<ThreadUnsubscribeResponse>('thread/unsubscribe', { threadId })
  }

  dispose(): void {
    this.rejectPending(new Error('Codex app-server stopped'))
    this.child?.kill()
    this.child = null
  }

  private async ensureStarted(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise
    }

    if (this.child && !this.child.killed) {
      this.emitStatus('ready')
      return
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

    try {
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
      await this.registerLocalSkills()
      this.notify('initialized')
      this.emitStatus('ready')
    } catch (error) {
      if (this.child === child) {
        this.child = null
        child.kill()
      }
      throw error
    }
  }

  private async registerLocalSkills(): Promise<void> {
    const skillsRoot = localSkillsRoot()

    if (!existsSync(skillsRoot)) {
      console.warn(`Local Codex skills root not found: ${skillsRoot}`)
      return
    }

    try {
      await this.request('skills/extraRoots/set', {
        extraRoots: [skillsRoot]
      })
      await this.request('skills/list', {
        cwds: [app.getAppPath()],
        forceReload: true
      })
    } catch (error) {
      console.warn('Failed to register local Codex skills root', error)
    }
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = `codexdesktop-${++this.requestCounter}`

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) {
          return
        }

        this.pending.delete(id)
        pending.reject(new Error(`Codex request timed out: ${method}`))
      }, requestTimeoutMs)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })

      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
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
    clearTimeout(pending.timer)

    if (message.error) {
      pending.reject(new Error(message.error.message))
    } else {
      pending.resolve(message.result)
    }
  }

  // The app runs fully unrestricted (approvalPolicy: 'never', danger-full-access)
  // BY DESIGN, so app-server never asks the user to approve commands, file
  // changes, or permissions. We only answer the non-approval server requests it
  // still makes; anything else (including any stray approval request) is denied.
  private handleServerRequest(message: ServerRequest & JsonRpcMessage): void {
    switch (message.method) {
      case 'item/tool/requestUserInput':
        this.respond(message.id!, { answers: {} })
        return
      case 'currentTime/read':
        this.respond(message.id!, { currentTimeAt: Math.floor(Date.now() / 1000) })
        return
      case 'item/tool/call':
        void this.handleDynamicToolCall(message.id!, message.params as DynamicToolCallParams)
        return
      default:
        this.respondError(message.id!, -32601, `Unsupported app-server request: ${message.method}`)
    }
  }

  private async handleDynamicToolCall(id: string | number, params: DynamicToolCallParams): Promise<void> {
    try {
      const args = asRecord(params.arguments)
      let result

      if (params.namespace !== null) {
        result = { ok: false, error: `unsupported dynamic tool namespace: ${params.namespace}` }
      } else if (params.tool === 'browser_run') {
        const code = readString(args.code)
        result = code
          ? await this.browserAgent.run(code, {
              tabId: readString(args.tab),
              timeoutMs: readNumber(args.timeoutMs),
              maxResultChars: readNumber(args.maxResultChars)
            })
          : { ok: false, error: 'browser_run requires a string "code" argument' }
      } else if (params.tool === 'browser_extract_page') {
        result = await this.browserAgent.extractPage({
          tabId: readString(args.tab),
          timeoutMs: readNumber(args.timeoutMs),
          maxResultChars: readNumber(args.maxResultChars)
        })
      } else if (params.tool === 'browser_cdp') {
        const method = readString(args.method)
        result = method
          ? await this.browserAgent.cdp(method, asRecord(args.params), {
              tabId: readString(args.tab),
              timeoutMs: readNumber(args.timeoutMs),
              maxResultChars: readNumber(args.maxResultChars)
            })
          : { ok: false, error: 'browser_cdp requires a string "method" argument' }
      } else if (params.tool === 'research_web') {
        result = await this.researchRunner.run({
          queries: readStringArray(args.queries),
          maxResults: readNumber(args.maxResults),
          maxPages: readNumber(args.maxPages),
          snippetChars: readNumber(args.snippetChars)
        }, params.turnId)
      } else {
        result = { ok: false, error: `unsupported browser tool: ${params.tool}` }
      }

      const response: DynamicToolCallResponse = {
        success: result.ok,
        contentItems: [{ type: 'inputText', text: JSON.stringify(result) }]
      }
      this.respond(id, response)
    } catch (error) {
      this.respond(id, {
        success: false,
        contentItems: [{
          type: 'inputText',
          text: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }]
      } satisfies DynamicToolCallResponse)
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
      clearTimeout(pending.timer)
      pending.reject(error)
    }

    this.pending.clear()
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
