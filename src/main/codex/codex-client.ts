import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { app } from 'electron'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { TurnCheckpointStore } from '../turn-checkpoint.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import type {
  CodexConnectionStatus,
  SessionEvent,
  CodexListThreadTurnsParams,
  CodexPluginAppStatusResponse
} from '../../shared/ipc.js'
import type { GetAuthStatusResponse } from '../../shared/codex-protocol/GetAuthStatusResponse.js'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort.js'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification.js'
import type { DynamicToolCallParams } from '../../shared/codex-protocol/v2/DynamicToolCallParams.js'
import type { Model } from '../../shared/codex-protocol/v2/Model.js'
import type { ModelListResponse } from '../../shared/codex-protocol/v2/ModelListResponse.js'
import type { ThreadListResponse } from '../../shared/codex-protocol/v2/ThreadListResponse.js'
import type { ThreadTurnsListResponse } from '../../shared/codex-protocol/v2/ThreadTurnsListResponse.js'
import type { ThreadGoal } from '../../shared/codex-protocol/v2/ThreadGoal.js'
import type { ThreadGoalClearResponse } from '../../shared/codex-protocol/v2/ThreadGoalClearResponse.js'
import type { ThreadGoalGetResponse } from '../../shared/codex-protocol/v2/ThreadGoalGetResponse.js'
import type { ThreadGoalSetParams } from '../../shared/codex-protocol/v2/ThreadGoalSetParams.js'
import type { ThreadGoalSetResponse } from '../../shared/codex-protocol/v2/ThreadGoalSetResponse.js'
import type { ThreadResumeResponse } from '../../shared/codex-protocol/v2/ThreadResumeResponse.js'
import type { ThreadStartResponse } from '../../shared/codex-protocol/v2/ThreadStartResponse.js'
import type { ThreadTokenUsage } from '../../shared/codex-protocol/v2/ThreadTokenUsage.js'
import type { ThreadUnsubscribeResponse } from '../../shared/codex-protocol/v2/ThreadUnsubscribeResponse.js'
import type { TurnStartResponse } from '../../shared/codex-protocol/v2/TurnStartResponse.js'
import type { PluginInstalledResponse } from '../../shared/codex-protocol/v2/PluginInstalledResponse.js'
import type { PluginListResponse } from '../../shared/codex-protocol/v2/PluginListResponse.js'
import type { PluginInstallParams } from '../../shared/codex-protocol/v2/PluginInstallParams.js'
import type { PluginInstallResponse } from '../../shared/codex-protocol/v2/PluginInstallResponse.js'
import type { PluginReadResponse } from '../../shared/codex-protocol/v2/PluginReadResponse.js'
import type { AppsListResponse } from '../../shared/codex-protocol/v2/AppsListResponse.js'
import type { ChatAttachment } from '../../shared/ipc.js'
import {
  AppServerRpc,
  AppServerRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequestMessage
} from './app-server-rpc.js'
import { AppServerProcess } from './app-server-process.js'
import { routeDynamicToolCall } from './dynamic-tool-router.js'
import {
  browserDynamicTools,
  buildGuidance,
  legacyResumeConfig,
  newThreadConfig,
  resolveTurnPolicy
} from './codex-config.js'
import { LocalSkillRegistry } from './local-skill-registry.js'
import { resumeHistoryPageFor, type ResumeHistoryConsumer } from './resume-history.js'

// Compact between turns once the last model call's context reaches this share
// of the model window, well before codex-core's own end-of-window handling, so
// long threads stay responsive instead of riding the limit.
const autoCompactContextRatio = 0.8

export class CodexClient extends EventEmitter {
  private readonly appServer: AppServerProcess
  private readonly rpc: AppServerRpc
  private readonly localSkills = new LocalSkillRegistry(app.getAppPath(), join(app.getAppPath(), 'skills'))
  private readonly threadModels = new Map<string, string>()
  private readonly threadCwds = new Map<string, string>()
  private readonly threadReasoningEfforts = new Map<string, ReasoningEffort | null>()
  private readonly modelReasoningEfforts = new Map<string, ReasoningEffort[]>()
  private readonly threadTokenUsage = new Map<string, ThreadTokenUsage>()
  private readonly compactionsInFlight = new Set<string>()
  constructor(
    private readonly browserAgent: BrowserAgentController,
    private readonly researchRunner: ResearchRunner,
    private readonly checkpoints: TurnCheckpointStore | null = null
  ) {
    super()
    this.appServer = new AppServerProcess({
      onLine: (line) => this.rpc.handleLine(line),
      onStopped: (error) => this.rpc.rejectPending(error),
      onStatus: (status, message) => this.emitStatus(status, message)
    })
    this.rpc = new AppServerRpc({
      write: (message) => this.appServer.write(message),
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

    const visible = models.filter((model) => !model.hidden)
    for (const model of visible) {
      this.modelReasoningEfforts.set(
        model.model,
        model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
      )
    }
    return visible
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

  async listInstalledPlugins(cwd?: string | null): Promise<PluginInstalledResponse> {
    await this.ensureStarted()
    return this.request<PluginInstalledResponse>('plugin/installed', {
      ...(cwd ? { cwds: [cwd] } : {})
    })
  }

  async listPlugins(cwd?: string | null): Promise<PluginListResponse> {
    await this.ensureStarted()
    return this.request<PluginListResponse>('plugin/list', {
      ...(cwd ? { cwds: [cwd] } : {})
    })
  }

  async readPlugin(params: PluginInstallParams): Promise<PluginReadResponse> {
    await this.ensureStarted()
    return this.request<PluginReadResponse>('plugin/read', params)
  }

  async getPluginAppStatuses(
    appIds: string[],
    forceRefetch = false
  ): Promise<CodexPluginAppStatusResponse> {
    await this.ensureStarted()
    const wanted = new Set(appIds.filter(Boolean).slice(0, 24))
    const apps: CodexPluginAppStatusResponse['apps'] = []
    let cursor: string | null = null
    let page = 0

    while (wanted.size && page < 24) {
      const response: AppsListResponse = await this.request<AppsListResponse>('app/list', {
        cursor,
        limit: 500,
        ...(forceRefetch && page === 0 ? { forceRefetch: true } : {})
      })

      for (const appInfo of response.data) {
        if (!wanted.delete(appInfo.id)) continue
        apps.push({
          id: appInfo.id,
          name: appInfo.name,
          installUrl: appInfo.installUrl,
          isAccessible: appInfo.isAccessible,
          isEnabled: appInfo.isEnabled
        })
      }

      cursor = response.nextCursor
      page += 1
      if (!cursor) break
    }

    return { apps }
  }

  async installPlugin(params: PluginInstallParams): Promise<PluginInstallResponse> {
    await this.ensureStarted()
    const result = await this.request<PluginInstallResponse>('plugin/install', params)
    await this.localSkills.refresh(<T>(method: string, requestParams?: unknown) => this.request<T>(method, requestParams), true)
    return result
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    await this.ensureStarted()
    await this.request('plugin/uninstall', { pluginId })
    await this.localSkills.refresh(<T>(method: string, requestParams?: unknown) => this.request<T>(method, requestParams), true)
  }

  async startThread(cwd?: string | null, model?: string | null): Promise<ThreadStartResponse> {
    await this.ensureStarted()
    const resolvedCwd = cwd ?? process.env.HOME ?? process.cwd()
    const response = await this.request<ThreadStartResponse>('thread/start', {
      cwd: resolvedCwd,
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
    this.threadCwds.set(response.thread.id, resolvedCwd)
    return response
  }

  async resumeThread(threadId: string, history: ResumeHistoryConsumer = 'main'): Promise<ThreadResumeResponse> {
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
      initialTurnsPage: resumeHistoryPageFor(history)
    })
    this.threadModels.set(threadId, response.model)
    this.threadReasoningEfforts.set(threadId, response.reasoningEffort)
    if (response.cwd) this.threadCwds.set(threadId, response.cwd)
    return response
  }

  async listThreadTurns(params: CodexListThreadTurnsParams): Promise<ThreadTurnsListResponse> {
    await this.ensureStarted()
    return this.request<ThreadTurnsListResponse>('thread/turns/list', {
      ...params,
      limit: params.limit ?? 10,
      sortDirection: 'desc',
      itemsView: 'full'
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
    effort?: ReasoningEffort | null,
    fastMode = false
  ): Promise<TurnStartResponse & {
    threadId: string
    model: string | null
    reasoningEffort: ReasoningEffort | null
  }> {
    await this.ensureStarted()
    const startedThread = threadId ? null : await this.startThread(cwd, model)
    const activeThreadId = threadId ?? startedThread!.thread.id
    const input = this.localSkills.buildTurnInput(text, !threadId, attachments)
    const requestedEffort = effort ?? startedThread?.reasoningEffort ?? this.threadReasoningEfforts.get(activeThreadId) ?? null
    const activeModel = model ?? startedThread?.model ?? this.threadModels.get(activeThreadId) ?? null
    const summaryPolicy = resolveTurnPolicy(text, {
      fastMode,
      requestedEffort,
      supportedEfforts: activeModel ? this.modelReasoningEfforts.get(activeModel) : undefined
    })
    const turnEffort = summaryPolicy.effort ?? effort
    const effectiveEffort = turnEffort ?? requestedEffort
    const includeSummaryPolicy = this.isReasoningSummarySupportedForModel(activeModel)

    // Reversibility (Phase 4): snapshot the workspace before the turn can
    // touch it. Fire-and-forget — a checkpoint failure or a slow `git add`
    // must never gate or delay a send; that turn simply offers no revert.
    const checkpointCwd = this.threadCwds.get(activeThreadId)
    const checkpointPromise = this.checkpoints && checkpointCwd
      ? this.checkpoints
          .createCheckpoint(checkpointCwd, activeThreadId, `before turn (${new Date().toISOString()})`)
          .catch((error) => {
            console.warn('turn checkpoint failed:', (error as Error).message)
            return null
          })
      : null

    // `model` overrides this turn and all subsequent turns on the thread, so
    // sending it every turn keeps resumed threads on the picker's selection.
    const response = await this.startTurnWithSummaryFallback({
      threadId: activeThreadId,
      input,
      ...(model ? { model } : {}),
      ...(turnEffort ? { effort: turnEffort } : {}),
      ...(includeSummaryPolicy ? summaryPolicy : {}),
      approvalPolicy: 'never'
    })
    if (model) this.threadModels.set(activeThreadId, model)
    if (effectiveEffort) this.threadReasoningEfforts.set(activeThreadId, effectiveEffort)
    if (checkpointPromise) {
      const boundTurnId = response.turn.id
      void checkpointPromise.then((record) => {
        if (record) return this.checkpoints!.assignTurn(record.id, boundTurnId)
        return undefined
      })
    }

    return {
      ...response,
      threadId: activeThreadId,
      model: model ?? this.threadModels.get(activeThreadId) ?? null,
      reasoningEffort: effectiveEffort
    }
  }

  private isReasoningSummarySupportedForModel(model: string | null): boolean {
    if (!model) return true
    return !/gpt-5\.3-codex-spark/i.test(model)
  }

  private async startTurnWithSummaryFallback(
    params: Record<string, unknown> & { summary?: 'auto' | 'concise' }
  ): Promise<TurnStartResponse> {
    try {
      return await this.request<TurnStartResponse>('turn/start', params)
    } catch (error) {
      if (params.summary === undefined || !this.isUnsupportedReasoningSummaryError(error)) {
        throw error
      }

      const { summary: _summary, ...fallbackParams } = params
      console.warn('Retrying Codex turn without reasoning summary after provider rejected reasoning.summary')
      return this.request<TurnStartResponse>('turn/start', fallbackParams)
    }
  }

  private isUnsupportedReasoningSummaryError(error: unknown): boolean {
    const haystack = [
      error instanceof Error ? error.message : String(error),
      error instanceof AppServerRpcError ? JSON.stringify(error.data) : ''
    ].join('\n')

    return (
      /unsupported_parameter/i.test(haystack) &&
      /reasoning\.summary|model_reasoning_summary|\bsummary\b/i.test(haystack)
    )
  }

  async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    await this.ensureStarted()
    this.browserAgent.cancelTurn(threadId, turnId)
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
    this.appServer.dispose()
  }

  // Spawn and initialize the app-server at app launch so the first message or
  // resume never pays the cold start. Failure is non-fatal: the next real
  // request retries the spawn and status events surface the state.
  async warmUp(): Promise<void> {
    try {
      await this.ensureStarted()
    } catch (error) {
      console.warn('codex app-server warm-up failed:', (error as Error).message)
    }
  }

  private async ensureStarted(): Promise<void> {
    return this.appServer.ensureStarted(() => this.initialize())
  }

  private async initialize(): Promise<void> {
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
      this.browserAgent.completeTurn(notification.params.threadId, notification.params.turn.id)
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
    } satisfies SessionEvent)
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
      researchRunner: this.researchRunner,
      onResearchProgress: (progress) => {
        this.emit('event', {
          type: 'researchProgress',
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.callId,
          progress
        } satisfies SessionEvent)
      }
    })
    this.rpc.respond(id, response)
  }

  private emitStatus(status: CodexConnectionStatus, message?: string): void {
    this.emit('event', {
      type: 'status',
      status,
      message
    } satisfies SessionEvent)
  }
}
