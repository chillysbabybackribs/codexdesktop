import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import {
  getSessionMessages,
  listSessions,
  query,
  type ModelInfo,
  type Query,
  type SDKMessage,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { ChatAttachment } from '../../shared/ipc.js'
import type {
  AgentContextUsage,
  AgentEvent,
  AgentModel,
  AgentSessionSummary,
  AgentTranscriptMessage,
  AgentUsage
} from '../../shared/agent.js'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import { AsyncMessageQueue } from './async-message-queue.js'
import { buildClaudeOptions, type ClaudeEffort } from './claude-options.js'
import { createClaudeBrowserMcpServer } from './claude-tools.js'
import { normalizeClaudeCompletion } from './claude-turn-completion.js'
import type { ConversationMemoryService } from '../conversation-memory-service.js'

type PendingTurn = {
  id: string
  interrupted: boolean
}

type ClaudeRuntime = {
  key: string
  sessionId: string | null
  cwd: string
  model: string | null
  effort: ClaudeEffort | null
  collaborationMode: 'default' | 'plan'
  input: AsyncMessageQueue<SDKUserMessage>
  query: Query
  pendingTurns: PendingTurn[]
  activeTurn: PendingTurn | null
  initialized: Promise<void>
  initializedSettled: boolean
  resolveInitialized: () => void
  rejectInitialized: (error: Error) => void
  closing: boolean
  seenModelMessageIds: Set<string>
  totalUsage: AgentUsage
  idleTimer: NodeJS.Timeout | null
}

const claudeRuntimeIdleMs = 120_000

export class ClaudeClient extends EventEmitter {
  private readonly runtimes = new Map<string, ClaudeRuntime>()
  private cachedModels: AgentModel[] | null = null
  private discoveryInFlight: Promise<ModelInfo[]> | null = null
  private readonly browserAgent: BrowserAgentController
  private readonly researchRunner: ResearchRunner
  private readonly conversationMemory: ConversationMemoryService

  constructor(
    browserAgent: BrowserAgentController,
    researchRunner: ResearchRunner,
    conversationMemory: ConversationMemoryService
  ) {
    super()
    this.browserAgent = browserAgent
    this.researchRunner = researchRunner
    this.conversationMemory = conversationMemory
  }

  async getAuthStatus(cwd?: string | null): Promise<{ authenticated: boolean; source: string | null }> {
    // A resolving model list is our proxy for a working, authenticated SDK.
    await this.sharedDiscovery(cwd)
    return { authenticated: true, source: null }
  }

  async listModels(cwd?: string | null): Promise<AgentModel[]> {
    if (this.cachedModels) return this.cachedModels
    const models = await this.sharedDiscovery(cwd)
    this.cachedModels = models.map(toAgentModel)
    return this.cachedModels
  }

  async listThreads(cwd?: string | null): Promise<{ data: AgentSessionSummary[]; nextCursor: null }> {
    const sessions = await listSessions({ ...(cwd ? { dir: cwd } : {}), limit: 30 })
    return {
      data: sessions.map((session) => ({
        provider: 'claude',
        id: session.sessionId,
        title: session.summary,
        cwd: session.cwd ?? null,
        createdAt: session.createdAt ?? null,
        updatedAt: session.lastModified
      })),
      nextCursor: null
    }
  }

  async readThread(threadId: string, cwd?: string | null): Promise<AgentTranscriptMessage[]> {
    const messages = await getSessionMessages(threadId, { ...(cwd ? { dir: cwd } : {}) })
    return messages.flatMap((entry) => {
      if (entry.type !== 'user' && entry.type !== 'assistant') return []
      const message = asRecord(entry.message)
      const text = extractText(message.content)
      return text ? [{ id: entry.uuid, role: entry.type, text }] : []
    })
  }

  async startThread(
    _cwd?: string | null,
    model?: string | null,
    effort?: ClaudeEffort | null,
    _collaborationMode: 'default' | 'plan' = 'default'
  ): Promise<{ threadId: string | null; model: string | null; effort: ClaudeEffort | null }> {
    // Claude assigns the real session id on the first message. Keep this call
    // metadata-only so opening a new conversation does not spawn a CLI process.
    return { threadId: null, model: model ?? null, effort: effort ?? null }
  }

  async resumeThread(
    threadId: string,
    _cwd?: string | null
  ): Promise<{ threadId: string; model: string | null; effort: ClaudeEffort | null }> {
    // Session files are sufficient for restore. Defer the CLI process until a
    // new turn is actually sent to this thread.
    return { threadId, model: null, effort: null }
  }

  async sendMessage(
    threadId: string | null | undefined,
    text: string,
    cwd?: string | null,
    model?: string | null,
    attachments: ChatAttachment[] = [],
    effort?: ClaudeEffort | null,
    collaborationMode: 'default' | 'plan' = 'default'
  ): Promise<{ threadId: string; turnId: string; model: string | null; effort: ClaudeEffort | null }> {
    // getRuntime does NOT wait for init: the vendored claude CLI only emits its
    // `system/init` message after it receives the first user message on stdin,
    // so blocking on init before we push a message would deadlock (init waits
    // for a message, the message waits for init). We push the turn first, then
    // await init to learn the real session id.
    const runtime = this.getRuntime(threadId, cwd, model, effort, collaborationMode)
    this.clearIdleTimer(runtime)
    const alreadyInitialized = runtime.sessionId !== null && runtime.initializedSettled

    if (alreadyInitialized) {
      if (runtime.collaborationMode !== collaborationMode) {
        await runtime.query.setPermissionMode(collaborationMode === 'plan' ? 'plan' : 'bypassPermissions')
        runtime.collaborationMode = collaborationMode
      }
      if (model && runtime.model !== model) {
        await runtime.query.setModel(model)
        runtime.model = model
      }
      if (effort && runtime.effort !== effort) {
        await runtime.query.applyFlagSettings({ effortLevel: effort === 'max' ? 'xhigh' : effort })
        runtime.effort = effort
      }
    }

    const turn = { id: crypto.randomUUID(), interrupted: false }
    runtime.pendingTurns.push(turn)
    const preparedText = await this.conversationMemory.prepareOpeningText({
      requestText: text,
      visibleText: text,
      workspace: cwd ?? null,
      isNewSession: !threadId
    })
    runtime.input.push(await buildUserMessage(preparedText, attachments))

    // Now that a message is in flight, the CLI will emit init; wait for it so we
    // can report the real session id back to the renderer.
    await runtime.initialized

    this.emitEvent({
      type: 'turn.started',
      provider: 'claude',
      sessionId: runtime.sessionId!,
      turnId: turn.id
    })

    return {
      threadId: runtime.sessionId!,
      turnId: turn.id,
      model: runtime.model,
      effort: runtime.effort
    }
  }

  async steerTurn(threadId: string, _turnId: string, text: string): Promise<void> {
    const runtime = this.requireRuntime(threadId)
    const queued = { id: crypto.randomUUID(), interrupted: false }
    runtime.pendingTurns.push(queued)
    runtime.input.push(await buildUserMessage(text, []))
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const runtime = this.requireRuntime(threadId)
    const turn = runtime.activeTurn ?? runtime.pendingTurns.find((candidate) => candidate.id === turnId)
    if (turn) turn.interrupted = true
    this.researchRunner.cancel(turnId)
    await runtime.query.interrupt()
  }

  unsubscribeThread(threadId: string): void {
    const runtime = this.runtimes.get(threadId)
    if (!runtime) return
    this.clearIdleTimer(runtime)
    runtime.closing = true
    runtime.input.close()
    runtime.query.close()
    this.runtimes.delete(threadId)
    this.runtimes.delete(runtime.key)
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      this.clearIdleTimer(runtime)
      runtime.closing = true
      runtime.input.close()
      runtime.query.close()
    }
    this.runtimes.clear()
  }

  // Get (or lazily create) a runtime WITHOUT waiting for initialization. The
  // caller is responsible for priming a new runtime with a user message before
  // awaiting `runtime.initialized`, since the CLI won't emit `system/init` until
  // it has a message to process.
  private getRuntime(
    threadId?: string | null,
    cwd?: string | null,
    model?: string | null,
    effort?: ClaudeEffort | null,
    collaborationMode: 'default' | 'plan' = 'default'
  ): ClaudeRuntime {
    if (threadId) {
      const existing = this.runtimes.get(threadId)
      if (existing) return existing
    }

    const runtime = this.createRuntime({
      resume: threadId ?? null,
      cwd: cwd ?? process.env.HOME ?? process.cwd(),
      model: model ?? null,
      effort: effort ?? null,
      collaborationMode
    })
    this.runtimes.set(runtime.key, runtime)
    return runtime
  }

  private createRuntime(options: {
    resume: string | null
    cwd: string
    model: string | null
    effort: ClaudeEffort | null
    collaborationMode: 'default' | 'plan'
  }): ClaudeRuntime {
    const key = options.resume ?? crypto.randomUUID()
    const input = new AsyncMessageQueue<SDKUserMessage>()
    let resolveInitialized!: () => void
    let rejectInitialized!: (error: Error) => void
    const initialized = new Promise<void>((resolve, reject) => {
      resolveInitialized = resolve
      rejectInitialized = reject
    })

    const runtime: ClaudeRuntime = {
      key,
      sessionId: options.resume,
      cwd: options.cwd,
      model: options.model,
      effort: options.effort,
      collaborationMode: options.collaborationMode,
      input,
      query: null as unknown as Query,
      pendingTurns: [],
      activeTurn: null,
      initialized,
      initializedSettled: false,
      resolveInitialized,
      rejectInitialized,
      closing: false,
      seenModelMessageIds: new Set(),
      totalUsage: emptyUsage(),
      idleTimer: null
    }

    const mcpServer = createClaudeBrowserMcpServer(
      { browserAgent: this.browserAgent, researchRunner: this.researchRunner },
      () => runtime.activeTurn?.id
    )
    runtime.query = query({
      prompt: input,
      options: buildClaudeOptions(options, mcpServer)
    })

    this.emitStatus('starting')
    void this.consume(runtime)
    return runtime
  }

  private async consume(runtime: ClaudeRuntime): Promise<void> {
    try {
      for await (const message of runtime.query) {
        await this.handleMessage(runtime, message)
      }
      if (!runtime.closing) this.emitStatus('exited')
    } catch (error) {
      if (runtime.closing) return
      const normalized = normalizeError(error)
      runtime.initializedSettled = true
      runtime.rejectInitialized(normalized)
      this.emitStatus('error', normalized.message)
      const turn = runtime.activeTurn ?? runtime.pendingTurns.shift() ?? null
      if (turn && runtime.sessionId) this.emitTurnCompleted(runtime, turn, null, normalized.message, emptyUsage())
    } finally {
      this.clearIdleTimer(runtime)
      if (runtime.sessionId) this.runtimes.delete(runtime.sessionId)
      this.runtimes.delete(runtime.key)
    }
  }

  private async handleMessage(runtime: ClaudeRuntime, message: SDKMessage): Promise<void> {
    if (message.type === 'system' && message.subtype === 'init') {
      runtime.sessionId = message.session_id
      runtime.model = message.model
      this.runtimes.delete(runtime.key)
      this.runtimes.set(message.session_id, runtime)
      runtime.initializedSettled = true
      runtime.resolveInitialized()
      this.emitStatus('ready')
      this.emitEvent({
        type: 'session.started',
        provider: 'claude',
        sessionId: message.session_id,
        model: message.model,
        cwd: message.cwd
      })
      return
    }

    if (!runtime.sessionId) return
    if (!runtime.activeTurn && runtime.pendingTurns.length) runtime.activeTurn = runtime.pendingTurns.shift() ?? null
    const turn = runtime.activeTurn
    if (!turn) return

    if (message.type === 'stream_event') {
      const event = message.event
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        this.emitEvent({
          type: 'message.delta',
          provider: 'claude',
          sessionId: runtime.sessionId,
          turnId: turn.id,
          itemId: message.uuid,
          text: event.delta.text
        })
      } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
        // Reasoning lives in its own block; key the item on the block index so a
        // turn's thinking and answer stream into separate transcript items.
        this.emitEvent({
          type: 'reasoning.delta',
          provider: 'claude',
          sessionId: runtime.sessionId,
          turnId: turn.id,
          itemId: `${message.uuid}-think-${event.index}`,
          text: event.delta.thinking
        })
      }
      return
    }

    if (message.type === 'assistant') {
      this.emitEvent({
        type: 'message.completed',
        provider: 'claude',
        sessionId: runtime.sessionId,
        turnId: turn.id,
        itemId: message.uuid,
        blocks: message.message.content,
        parentToolUseId: message.parent_tool_use_id
      })
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue
        this.emitEvent({
          type: 'tool.started',
          provider: 'claude',
          sessionId: runtime.sessionId,
          turnId: turn.id,
          callId: block.id,
          name: block.name,
          input: block.input
        })
      }
      // Context usage is supplemental telemetry. Do not stop consuming SDK
      // messages while waiting for its control-channel round trip.
      void this.emitTokenUsage(runtime, turn, message.message.id, message.message.usage)
      return
    }

    if (message.type === 'user') {
      const content = typeof message.message.content === 'string' ? [] : message.message.content
      for (const block of content) {
        if (block.type !== 'tool_result') continue
        this.emitEvent({
          type: 'tool.completed',
          provider: 'claude',
          sessionId: runtime.sessionId,
          turnId: turn.id,
          callId: block.tool_use_id,
          failed: block.is_error ?? false,
          content: block.content
        })
      }
      return
    }

    if (message.type === 'tool_progress') {
      this.emitEvent({
        type: 'tool.progress',
        provider: 'claude',
        sessionId: runtime.sessionId,
        turnId: turn.id,
        callId: message.tool_use_id,
        name: message.tool_name,
        elapsedSeconds: message.elapsed_time_seconds
      })
      return
    }

    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      this.emitEvent({
        type: 'compaction.completed',
        provider: 'claude',
        sessionId: runtime.sessionId,
        beforeTokens: message.compact_metadata.pre_tokens,
        afterTokens: message.compact_metadata.post_tokens ?? null
      })
      return
    }

    if (message.type === 'result') {
      const error = message.subtype === 'success' ? null : message.errors.join('\n')
      this.emitTurnCompleted(
        runtime,
        turn,
        message.subtype === 'success' ? message.result : null,
        error,
        toAgentUsage(message.usage, message.total_cost_usd)
      )
      runtime.activeTurn = null
      this.scheduleIdleClose(runtime)
    }
  }

  private scheduleIdleClose(runtime: ClaudeRuntime): void {
    this.clearIdleTimer(runtime)
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = null
      if (!runtime.activeTurn && runtime.pendingTurns.length === 0 && runtime.sessionId) {
        this.unsubscribeThread(runtime.sessionId)
      }
    }, claudeRuntimeIdleMs)
    runtime.idleTimer.unref()
  }

  private clearIdleTimer(runtime: ClaudeRuntime): void {
    if (!runtime.idleTimer) return
    clearTimeout(runtime.idleTimer)
    runtime.idleTimer = null
  }

  private async emitTokenUsage(
    runtime: ClaudeRuntime,
    turn: PendingTurn,
    callId: string,
    rawUsage: unknown
  ): Promise<void> {
    // The SDK can deliver multiple assistant envelopes for one API response.
    // The Anthropic message id is stable across those envelopes; the SDK uuid is not.
    if (runtime.seenModelMessageIds.has(callId)) return
    runtime.seenModelMessageIds.add(callId)

    const usage = toAgentUsage(asRecord(rawUsage), 0)
    runtime.totalUsage = addAgentUsage(runtime.totalUsage, usage)

    let context: AgentContextUsage | null = null
    try {
      const current = await runtime.query.getContextUsage()
      context = {
        currentTokens: current.totalTokens,
        maxTokens: current.maxTokens,
        rawMaxTokens: current.rawMaxTokens,
        percentage: current.percentage,
        autoCompactThreshold: current.autoCompactThreshold ?? null,
        isAutoCompactEnabled: current.isAutoCompactEnabled
      }
    } catch {
      // Per-call usage remains valuable if an older CLI does not support the
      // optional context-usage control request.
    }

    this.emitEvent({
      type: 'tokenUsage.updated',
      provider: 'claude',
      sessionId: runtime.sessionId!,
      turnId: turn.id,
      callId,
      usage,
      totalUsage: runtime.totalUsage,
      context
    })
  }

  private emitTurnCompleted(
    runtime: ClaudeRuntime,
    turn: PendingTurn,
    result: string | null,
    error: string | null,
    usage: AgentUsage
  ): void {
    const completion = normalizeClaudeCompletion(turn.interrupted, error)
    this.emitEvent({
      type: 'turn.completed',
      provider: 'claude',
      sessionId: runtime.sessionId!,
      turnId: turn.id,
      status: completion.status,
      result,
      error: completion.error,
      usage
    })
  }

  private requireRuntime(threadId: string): ClaudeRuntime {
    const runtime = this.runtimes.get(threadId)
    if (!runtime) throw new Error(`Claude session is not active: ${threadId}`)
    return runtime
  }

  private async discover(cwd?: string | null): Promise<ModelInfo[]> {
    const input = new AsyncMessageQueue<SDKUserMessage>()
    const discovery = query({
      prompt: input,
      options: buildClaudeOptions({
        resume: null,
        cwd: cwd ?? process.env.HOME ?? process.cwd(),
        model: null,
        effort: null,
        collaborationMode: 'default'
      })
    })

    try {
      // Do NOT wait for a `system/init` message here: the vendored claude CLI
      // only emits init once it receives its first user message on stdin, and
      // this discovery query never sends one — so awaiting next() hangs forever
      // and the model list never loads. supportedModels() pumps the query on its
      // own and resolves without any input.
      return await discovery.supportedModels()
    } finally {
      input.close()
      discovery.close()
    }
  }

  private sharedDiscovery(cwd?: string | null): Promise<ModelInfo[]> {
    if (!this.discoveryInFlight) {
      this.discoveryInFlight = this.discover(cwd).finally(() => {
        this.discoveryInFlight = null
      })
    }
    return this.discoveryInFlight
  }

  private emitStatus(status: 'starting' | 'ready' | 'exited' | 'error', message?: string): void {
    this.emitEvent({ type: 'status', provider: 'claude', status, message })
  }

  private emitEvent(event: AgentEvent): void {
    this.emit('event', event)
  }
}

async function buildUserMessage(text: string, attachments: ChatAttachment[]): Promise<SDKUserMessage> {
  const fileMentions: string[] = []
  const content: Array<Record<string, unknown>> = []
  if (text.trim()) content.push({ type: 'text', text: text.trim() })

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mediaType,
          data: await readFile(attachment.path, 'base64')
        }
      })
    } else {
      fileMentions.push(`${attachment.name}: ${attachment.path}`)
    }
  }

  if (fileMentions.length) {
    content.push({ type: 'text', text: `Attached files:\n${fileMentions.join('\n')}` })
  }

  return {
    type: 'user',
    message: { role: 'user', content } as unknown as SDKUserMessage['message'],
    parent_tool_use_id: null,
    uuid: crypto.randomUUID()
  }
}

function toAgentModel(model: ModelInfo, index: number): AgentModel {
  return {
    provider: 'claude',
    id: model.value,
    displayName: model.displayName,
    description: model.description,
    isDefault: index === 0,
    inputModalities: ['text', 'image'],
    supportedEfforts: model.supportedEffortLevels ?? (model.supportsEffort ? ['low', 'medium', 'high'] : [])
  }
}

function toAgentUsage(usage: Record<string, unknown>, costUsd: number): AgentUsage {
  return {
    inputTokens: readUsageNumber(usage.input_tokens),
    outputTokens: readUsageNumber(usage.output_tokens),
    cacheReadInputTokens: readUsageNumber(usage.cache_read_input_tokens),
    cacheCreationInputTokens: readUsageNumber(usage.cache_creation_input_tokens),
    costUsd
  }
}

function readUsageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function emptyUsage(): AgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0
  }
}

function addAgentUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    costUsd: left.costUsd + right.costUsd
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map(asRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text as string).trim())
    .filter(Boolean)
    .join('\n')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
