import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import type { CodexConnectionStatus, CodexEvent } from '../../shared/ipc.js'
import type { GetAuthStatusResponse } from '../../shared/codex-protocol/GetAuthStatusResponse.js'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort.js'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification.js'
import type { ServerRequest } from '../../shared/codex-protocol/ServerRequest.js'
import type { DynamicToolCallParams } from '../../shared/codex-protocol/v2/DynamicToolCallParams.js'
import type { Model } from '../../shared/codex-protocol/v2/Model.js'
import type { ModelListResponse } from '../../shared/codex-protocol/v2/ModelListResponse.js'
import type { ThreadListResponse } from '../../shared/codex-protocol/v2/ThreadListResponse.js'
import type { ThreadGoal } from '../../shared/codex-protocol/v2/ThreadGoal.js'
import type { ThreadGoalClearResponse } from '../../shared/codex-protocol/v2/ThreadGoalClearResponse.js'
import type { ThreadGoalGetResponse } from '../../shared/codex-protocol/v2/ThreadGoalGetResponse.js'
import type { ThreadGoalSetParams } from '../../shared/codex-protocol/v2/ThreadGoalSetParams.js'
import type { ThreadGoalSetResponse } from '../../shared/codex-protocol/v2/ThreadGoalSetResponse.js'
import type { ThreadReadResponse } from '../../shared/codex-protocol/v2/ThreadReadResponse.js'
import type { ThreadResumeResponse } from '../../shared/codex-protocol/v2/ThreadResumeResponse.js'
import type { ThreadStartResponse } from '../../shared/codex-protocol/v2/ThreadStartResponse.js'
import type { ThreadTokenUsage } from '../../shared/codex-protocol/v2/ThreadTokenUsage.js'
import type { ThreadUnsubscribeResponse } from '../../shared/codex-protocol/v2/ThreadUnsubscribeResponse.js'
import type { TurnStartResponse } from '../../shared/codex-protocol/v2/TurnStartResponse.js'
import type { ChatAttachment } from '../../shared/ipc.js'
import {
  AppServerRpc,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequestMessage
} from './app-server-rpc.js'
import { routeDynamicToolCall } from './dynamic-tool-router.js'
import {
  browserDynamicTools,
  buildGuidance,
  legacyResumeConfig,
  newThreadConfig,
  resolveTurnPolicy
} from './codex-config.js'
import { LocalSkillRegistry } from './local-skill-registry.js'

// Compact between turns once the last model call's context reaches this share
// of the model window, well before codex-core's own end-of-window handling, so
// long threads stay responsive instead of riding the limit.
const autoCompactContextRatio = 0.8

export class CodexClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private readonly rpc: AppServerRpc
  private readonly localSkills = new LocalSkillRegistry(app.getAppPath(), join(app.getAppPath(), 'skills'))
  private readonly threadModels = new Map<string, string>()
  private readonly threadReasoningEfforts = new Map<string, ReasoningEffort | null>()
  private readonly threadTokenUsage = new Map<string, ThreadTokenUsage>()
  private readonly compactionsInFlight = new Set<string>()
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly browserAgent: BrowserAgentController,
    private readonly researchRunner: ResearchRunner
  ) {
    super()
    this.rpc = new AppServerRpc({
      write: (message) => this.writeToChild(message),
      onNotification: (message) => this.handleNotification(message),
      onRequest: (message) => this.handleServerRequest(message)
    })
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
    const response = await this.request<ThreadStartResponse>('thread/start', {
      cwd: cwd ?? process.env.HOME ?? process.cwd(),
      ...(model ? { model } : {}),
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      historyMode: 'legacy',
      config: newThreadConfig,
      dynamicTools: browserDynamicTools,
      developerInstructions: buildGuidance()
    })
    this.threadModels.set(response.thread.id, response.model)
    this.threadReasoningEfforts.set(response.thread.id, response.reasoningEffort)
    return response
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResponse> {
    await this.ensureStarted()
    const response = await this.request<ThreadResumeResponse>('thread/resume', {
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
    this.threadModels.set(threadId, response.model)
    this.threadReasoningEfforts.set(threadId, response.reasoningEffort)
    return response
  }

  async readThread(threadId: string): Promise<ThreadReadResponse> {
    await this.ensureStarted()
    return this.request<ThreadReadResponse>('thread/read', {
      threadId,
      includeTurns: true
    })
  }

  async getGoal(threadId: string): Promise<ThreadGoal | null> {
    await this.ensureStarted()
    const response = await this.request<ThreadGoalGetResponse>('thread/goal/get', { threadId })
    return response.goal
  }

  async setGoal(params: ThreadGoalSetParams): Promise<ThreadGoal> {
    await this.ensureStarted()
    const response = await this.request<ThreadGoalSetResponse>('thread/goal/set', params)
    return response.goal
  }

  async clearGoal(threadId: string): Promise<ThreadGoalClearResponse> {
    await this.ensureStarted()
    return this.request<ThreadGoalClearResponse>('thread/goal/clear', { threadId })
  }

  async sendMessage(
    threadId: string | null | undefined,
    text: string,
    cwd?: string | null,
    model?: string | null,
    attachments: ChatAttachment[] = [],
    effort?: ReasoningEffort | null
  ): Promise<TurnStartResponse & {
    threadId: string
    model: string | null
    reasoningEffort: ReasoningEffort | null
  }> {
    await this.ensureStarted()
    const startedThread = threadId ? null : await this.startThread(cwd, model)
    const activeThreadId = threadId ?? startedThread!.thread.id
    const input = this.localSkills.buildTurnInput(text, !threadId, attachments)

    // `model` overrides this turn and all subsequent turns on the thread, so
    // sending it every turn keeps resumed threads on the picker's selection.
    const response = await this.request<TurnStartResponse>('turn/start', {
      threadId: activeThreadId,
      input,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...resolveTurnPolicy(text),
      approvalPolicy: 'never'
    })
    if (model) this.threadModels.set(activeThreadId, model)
    if (effort) this.threadReasoningEfforts.set(activeThreadId, effort)

    return {
      ...response,
      threadId: activeThreadId,
      model: model ?? this.threadModels.get(activeThreadId) ?? null,
      reasoningEffort: effort ?? startedThread?.reasoningEffort ?? this.threadReasoningEfforts.get(activeThreadId) ?? null
    }
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
      input: this.localSkills.buildTurnInput(text, false)
    })
  }

  // Kicks off server-side history compaction (codex summarizes the thread and
  // drops old items). Deduped per thread; the guard clears when token usage
  // reports the context back under the auto-compact threshold.
  async compactThread(threadId: string): Promise<{ started: boolean }> {
    await this.ensureStarted()

    if (this.compactionsInFlight.has(threadId)) {
      return { started: false }
    }

    this.compactionsInFlight.add(threadId)
    try {
      await this.request('thread/compact/start', { threadId })
      return { started: true }
    } catch (error) {
      this.compactionsInFlight.delete(threadId)
      throw error
    }
  }

  async unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeResponse> {
    await this.ensureStarted()
    return this.request<ThreadUnsubscribeResponse>('thread/unsubscribe', { threadId })
  }

  dispose(): void {
    this.rpc.rejectPending(new Error('Codex app-server stopped'))
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
      this.rpc.rejectPending(new Error(message))
    })

    child.on('error', (error) => {
      this.child = null
      this.emitStatus('error', error.message)
      this.rpc.rejectPending(error)
    })

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.rpc.handleLine(line))

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
      this.rpc.notify('initialized')
      await this.localSkills.register(<T>(method: string, params?: unknown) => this.request<T>(method, params))
      this.emitStatus('ready')
    } catch (error) {
      if (this.child === child) {
        this.child = null
        child.kill()
      }
      throw error
    }
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.rpc.request<T>(method, params)
  }

  private handleNotification(message: JsonRpcMessage & { method: string }): void {
    const notification = message as ServerNotification

    if (notification.method === 'skills/changed') {
      void this.localSkills.refresh(<T>(method: string, params?: unknown) => this.request<T>(method, params), true)
    }

    if (notification.method === 'model/rerouted') {
      this.threadModels.set(notification.params.threadId, notification.params.toModel)
    } else if (notification.method === 'thread/tokenUsage/updated') {
      this.noteThreadTokenUsage(notification.params.threadId, notification.params.tokenUsage)
    } else if (notification.method === 'turn/completed') {
      this.maybeAutoCompact(notification.params.threadId)
    } else if (notification.method === 'thread/compacted') {
      this.compactionsInFlight.delete(notification.params.threadId)
    } else if (
      notification.method === 'thread/deleted' ||
      notification.method === 'thread/closed'
    ) {
      this.threadModels.delete(notification.params.threadId)
      this.threadReasoningEfforts.delete(notification.params.threadId)
      this.threadTokenUsage.delete(notification.params.threadId)
      this.compactionsInFlight.delete(notification.params.threadId)
    }

    this.emit('event', {
      type: 'notification',
      notification
    } satisfies CodexEvent)
  }

  private noteThreadTokenUsage(threadId: string, tokenUsage: ThreadTokenUsage): void {
    this.threadTokenUsage.set(threadId, tokenUsage)

    // Compaction shows up here as the next model call reporting a much
    // smaller context, so this is also where the dedupe guard clears.
    const window = tokenUsage.modelContextWindow
    if (window && tokenUsage.last.totalTokens < window * autoCompactContextRatio) {
      this.compactionsInFlight.delete(threadId)
    }
  }

  // `last` is the most recent model call, so its token count is the current
  // size of the thread's context. Fired from turn/completed so compaction
  // never races an in-flight turn.
  private maybeAutoCompact(threadId: string): void {
    const usage = this.threadTokenUsage.get(threadId)
    const window = usage?.modelContextWindow

    if (!usage || !window || usage.last.totalTokens < window * autoCompactContextRatio) {
      return
    }

    void this.compactThread(threadId).catch((error) => {
      console.warn(`Auto-compaction failed for thread ${threadId}`, error)
    })
  }

  // The app runs fully unrestricted (approvalPolicy: 'never', danger-full-access)
  // BY DESIGN, so app-server never asks the user to approve commands, file
  // changes, or permissions. We only answer the non-approval server requests it
  // still makes; anything else (including any stray approval request) is denied.
  private handleServerRequest(message: JsonRpcRequestMessage): void {
    switch (message.method) {
      case 'item/tool/requestUserInput':
        this.rpc.respond(message.id, { answers: {} })
        return
      case 'currentTime/read':
        this.rpc.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) })
        return
      case 'item/tool/call':
        void this.handleDynamicToolCall(message.id, message.params as DynamicToolCallParams)
        return
      default:
        this.rpc.respondError(message.id, -32601, `Unsupported app-server request: ${message.method}`)
    }
  }

  private async handleDynamicToolCall(id: JsonRpcId, params: DynamicToolCallParams): Promise<void> {
    const response = await routeDynamicToolCall(params, {
      browserAgent: this.browserAgent,
      researchRunner: this.researchRunner
    })
    this.rpc.respond(id, response)
  }

  private writeToChild(message: JsonRpcMessage): void {
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

}
