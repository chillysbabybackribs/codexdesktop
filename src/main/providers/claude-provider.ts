import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort.js'
import type { GetAuthStatusResponse } from '../../shared/codex-protocol/GetAuthStatusResponse.js'
import type { Model } from '../../shared/codex-protocol/v2/Model.js'
import type { ThreadListResponse } from '../../shared/codex-protocol/v2/ThreadListResponse.js'
import type { ThreadTurnsListResponse } from '../../shared/codex-protocol/v2/ThreadTurnsListResponse.js'
import type { ThreadGoal } from '../../shared/codex-protocol/v2/ThreadGoal.js'
import type { ThreadGoalClearResponse } from '../../shared/codex-protocol/v2/ThreadGoalClearResponse.js'
import type { ThreadGoalSetParams } from '../../shared/codex-protocol/v2/ThreadGoalSetParams.js'
import type { ThreadResumeResponse } from '../../shared/codex-protocol/v2/ThreadResumeResponse.js'
import type { ThreadStartResponse } from '../../shared/codex-protocol/v2/ThreadStartResponse.js'
import type { ThreadUnsubscribeResponse } from '../../shared/codex-protocol/v2/ThreadUnsubscribeResponse.js'
import type { TokenUsageBreakdown } from '../../shared/codex-protocol/v2/TokenUsageBreakdown.js'
import type { Turn } from '../../shared/codex-protocol/v2/Turn.js'
import type { TurnStartResponse } from '../../shared/codex-protocol/v2/TurnStartResponse.js'
import type { PluginInstalledResponse } from '../../shared/codex-protocol/v2/PluginInstalledResponse.js'
import type { PluginListResponse } from '../../shared/codex-protocol/v2/PluginListResponse.js'
import type { PluginInstallParams } from '../../shared/codex-protocol/v2/PluginInstallParams.js'
import type { PluginInstallResponse } from '../../shared/codex-protocol/v2/PluginInstallResponse.js'
import type { PluginReadResponse } from '../../shared/codex-protocol/v2/PluginReadResponse.js'
import type {
  ChatAttachment,
  CodexListThreadTurnsParams,
  CodexPluginAppStatusResponse,
  SessionEvent
} from '../../shared/ipc.js'
import type { ProviderCapabilities } from '../../shared/session-protocol/provider.js'
import type { ResumeHistoryConsumer } from '../codex/resume-history.js'
import type { TurnCheckpointStore } from '../turn-checkpoint.js'
import type { SessionProvider } from './session-provider.js'
import {
  ClaudeTurnTranslator,
  claudeContextWindowFor,
  turnStartedNotification,
  type ClaudeTurnContext
} from '../../shared/claude-events.js'

// The Claude adapter: SessionProvider #2, driving the Agent SDK under the
// approved lifecycle policy (docs/claude-prep-step7-process-policy-2026-07-19.md):
// bounded per-session processes (cap 3 live, queued beyond), 15-minute
// idle-kill (never mid-turn), resume via persisted session-id mapping, and the
// SDK's vendored version-pinned runtime (D4/D5). Unrestricted per the standing
// dev directive: bypassPermissions — parity with codex danger-full-access.

export const claudeCapabilities: ProviderCapabilities = {
  steering: false,
  reasoningEfforts: false,
  compaction: 'none',
  toolTransport: 'mcp',
  resume: true,
  goals: false,
  plugins: false,
  processModel: 'per-session',
  tokenTelemetry: true
}

const maxLiveSessions = 3
const idleKillMs = 15 * 60 * 1000
export const claudeDefaultModelId = 'claude-default'

type InputStream = {
  push: (message: unknown) => void
  end: () => void
  stream: () => AsyncGenerator<unknown>
}

type LiveRuntime = {
  input: InputStream
  interrupt: () => Promise<void>
}

type ClaudeSession = {
  threadId: string
  claudeSessionId: string | null
  cwd: string
  model: string | null
  runtime: LiveRuntime | null
  working: boolean
  translator: ClaudeTurnTranslator | null
  lastActivityMs: number
  idleTimer: NodeJS.Timeout | null
  total: TokenUsageBreakdown
}

type PersistedSessions = Record<string, { claudeSessionId: string | null; cwd: string; model: string | null }>

function createInputStream(): InputStream {
  const queue: unknown[] = []
  let notify: (() => void) | null = null
  let done = false
  return {
    push(message) {
      queue.push(message)
      notify?.()
    },
    end() {
      done = true
      notify?.()
    },
    async *stream() {
      while (true) {
        while (queue.length) yield queue.shift()
        if (done) return
        await new Promise<void>((resolve) => {
          notify = resolve
        })
        notify = null
      }
    }
  }
}

function emptyBreakdown(): TokenUsageBreakdown {
  return { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
}

export class ClaudeProvider extends EventEmitter implements SessionProvider {
  readonly id = 'claude' as const
  readonly capabilities = claudeCapabilities

  private readonly sessions = new Map<string, ClaudeSession>()
  private readonly slotWaiters: Array<() => void> = []
  private readonly statePath: string
  private persisted: PersistedSessions | null = null
  private readonly checkpoints: TurnCheckpointStore | null

  constructor(checkpoints: TurnCheckpointStore | null = null) {
    super()
    this.checkpoints = checkpoints
    this.statePath = join(app.getPath('userData'), 'claude-sessions.json')
  }

  async warmUp(): Promise<void> {
    // Per policy: optional single pre-spawn is allowed but not required.
  }

  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    return { authMethod: null, authToken: null, requiresOpenaiAuth: false }
  }

  async listModels(): Promise<Model[]> {
    // The SDK exposes no model-list API; a single spike-proven default entry
    // keeps the pill honest. Empty efforts hide the effort submenu; text-only
    // modality makes the composer reject image attachments (unsupported v1).
    return [{
      id: claudeDefaultModelId,
      model: claudeDefaultModelId,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: 'Claude (Agent SDK)',
      description: 'Claude Code runtime via the vendored Agent SDK',
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: 'medium',
      inputModalities: ['text'],
      supportsPersonality: false,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: false
    } as unknown as Model]
  }

  async listThreads(): Promise<ThreadListResponse> {
    return { data: [], nextCursor: null } as unknown as ThreadListResponse
  }

  async startThread(cwd?: string | null, model?: string | null): Promise<ThreadStartResponse> {
    const threadId = `claude-${randomUUID()}`
    const session = this.ensureSessionRecord(threadId, cwd ?? process.env.HOME ?? process.cwd(), model ?? null)
    await this.persistSessions()
    return {
      thread: { id: session.threadId, turns: [], cwd: session.cwd } as unknown as ThreadStartResponse['thread'],
      model: session.model,
      reasoningEffort: null
    } as unknown as ThreadStartResponse
  }

  async resumeThread(threadId: string, _history?: ResumeHistoryConsumer): Promise<ThreadResumeResponse> {
    const persisted = (await this.loadPersisted())[threadId]
    if (!persisted && !this.sessions.has(threadId)) {
      throw new Error(`unknown claude session for thread ${threadId}`)
    }
    const session = this.ensureSessionRecord(
      threadId,
      persisted?.cwd ?? this.sessions.get(threadId)?.cwd ?? process.env.HOME ?? process.cwd(),
      persisted?.model ?? this.sessions.get(threadId)?.model ?? null
    )
    if (persisted?.claudeSessionId) session.claudeSessionId = persisted.claudeSessionId
    // History pages stay empty: the renderer paints from the transcript cache
    // and reconciles; live turns stream from here on.
    return {
      thread: { id: threadId, turns: [], cwd: session.cwd } as unknown as ThreadResumeResponse['thread'],
      model: session.model,
      reasoningEffort: null,
      cwd: session.cwd,
      initialTurnsPage: { data: [], nextCursor: null }
    } as unknown as ThreadResumeResponse
  }

  async listThreadTurns(_params: CodexListThreadTurnsParams): Promise<ThreadTurnsListResponse> {
    return { data: [], nextCursor: null } as unknown as ThreadTurnsListResponse
  }

  async sendMessage(
    threadId: string | null | undefined,
    text: string,
    cwd?: string | null,
    model?: string | null,
    _attachments: ChatAttachment[] = [],
    _effort?: ReasoningEffort | null,
    _fastMode = false
  ): Promise<TurnStartResponse & { threadId: string; model: string | null; reasoningEffort: ReasoningEffort | null }> {
    const activeThreadId = threadId ?? (await this.startThread(cwd, model)).thread.id
    const session = this.ensureSessionRecord(
      activeThreadId,
      cwd ?? this.sessions.get(activeThreadId)?.cwd ?? process.env.HOME ?? process.cwd(),
      model ?? this.sessions.get(activeThreadId)?.model ?? null
    )
    if (session.working) throw new Error('a turn is already running on this claude session')

    // Reversibility parity with the codex path: checkpoint before the turn,
    // fire-and-forget, bind once the turn id exists.
    const turnId = `claude-turn-${randomUUID()}`
    if (this.checkpoints) {
      void this.checkpoints
        .createCheckpoint(session.cwd, activeThreadId, `before turn (${new Date().toISOString()})`)
        .then((record) => record && this.checkpoints!.assignTurn(record.id, turnId))
        .catch((error) => console.warn('claude turn checkpoint failed:', (error as Error).message))
    }

    await this.ensureLive(session)

    const context: ClaudeTurnContext = {
      threadId: activeThreadId,
      turnId,
      nowMs: () => Date.now(),
      tokens: {
        contextWindow: claudeContextWindowFor(session.model),
        addLast: (last) => {
          session.total = {
            totalTokens: session.total.totalTokens + last.totalTokens,
            inputTokens: session.total.inputTokens + last.inputTokens,
            cachedInputTokens: session.total.cachedInputTokens + last.cachedInputTokens,
            outputTokens: session.total.outputTokens + last.outputTokens,
            reasoningOutputTokens: 0
          }
          return { total: session.total, last }
        }
      }
    }
    session.translator = new ClaudeTurnTranslator(context)
    session.working = true
    session.lastActivityMs = Date.now()
    this.clearIdleTimer(session)

    this.emitNotification(turnStartedNotification(context, text))
    session.runtime!.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: session.claudeSessionId ?? 'pending'
    })

    return {
      turn: {
        id: turnId,
        items: [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: Math.floor(Date.now() / 1000),
        completedAt: null,
        durationMs: null
      } as unknown as Turn,
      threadId: activeThreadId,
      model: session.model,
      reasoningEffort: null
    } as unknown as TurnStartResponse & { threadId: string; model: string | null; reasoningEffort: ReasoningEffort | null }
  }

  async interruptTurn(threadId: string, _turnId: string): Promise<unknown> {
    const session = this.sessions.get(threadId)
    if (session?.runtime && session.working) await session.runtime.interrupt()
    return {}
  }

  async steerTurn(): Promise<unknown> {
    throw new Error('the claude provider does not support mid-turn steering')
  }

  async compactThread(): Promise<{ started: boolean }> {
    return { started: false }
  }

  async unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeResponse> {
    const session = this.sessions.get(threadId)
    if (session && !session.working) this.killSession(session)
    return {} as ThreadUnsubscribeResponse
  }

  async getGoal(_threadId: string): Promise<ThreadGoal | null> {
    return null
  }

  async setGoal(_params: ThreadGoalSetParams): Promise<ThreadGoal> {
    throw new Error('the claude provider does not support thread goals')
  }

  async clearGoal(_threadId: string): Promise<ThreadGoalClearResponse> {
    return {} as ThreadGoalClearResponse
  }

  async listInstalledPlugins(): Promise<PluginInstalledResponse> {
    return { plugins: [] } as unknown as PluginInstalledResponse
  }

  async listPlugins(): Promise<PluginListResponse> {
    return { marketplaces: [] } as unknown as PluginListResponse
  }

  async readPlugin(_params: PluginInstallParams): Promise<PluginReadResponse> {
    throw new Error('the claude provider does not support plugins')
  }

  async getPluginAppStatuses(): Promise<CodexPluginAppStatusResponse> {
    return { apps: [] } as unknown as CodexPluginAppStatusResponse
  }

  async installPlugin(_params: PluginInstallParams): Promise<PluginInstallResponse> {
    throw new Error('the claude provider does not support plugins')
  }

  async uninstallPlugin(_pluginId: string): Promise<void> {
    throw new Error('the claude provider does not support plugins')
  }

  // ---- lifecycle internals -------------------------------------------------

  private ensureSessionRecord(threadId: string, cwd: string, model: string | null): ClaudeSession {
    let session = this.sessions.get(threadId)
    if (!session) {
      session = {
        threadId,
        claudeSessionId: null,
        cwd,
        model,
        runtime: null,
        working: false,
        translator: null,
        lastActivityMs: Date.now(),
        idleTimer: null,
        total: emptyBreakdown()
      }
      this.sessions.set(threadId, session)
    }
    if (model) session.model = model
    return session
  }

  private liveSessions(): ClaudeSession[] {
    return [...this.sessions.values()].filter((session) => session.runtime !== null)
  }

  private async ensureLive(session: ClaudeSession): Promise<void> {
    if (session.runtime) return

    // D2: cap live processes; evict the oldest idle, else wait for a slot.
    while (this.liveSessions().length >= maxLiveSessions) {
      const idle = this.liveSessions()
        .filter((candidate) => !candidate.working)
        .sort((a, b) => a.lastActivityMs - b.lastActivityMs)[0]
      if (idle) {
        this.killSession(idle)
        break
      }
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve))
    }

    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const input = createInputStream()
    const handle = query({
      prompt: input.stream() as AsyncIterable<never>,
      options: {
        cwd: session.cwd,
        ...(session.model && session.model !== claudeDefaultModelId ? { model: session.model } : {}),
        ...(session.claudeSessionId ? { resume: session.claudeSessionId } : {}),
        includePartialMessages: true,
        // Unrestricted dev parity with codex `danger-full-access` (standing
        // directive; Phase 6 revisits before launch).
        permissionMode: 'bypassPermissions',
        // Spike-verified isolation: the user's ~/.claude settings never bleed
        // into app sessions.
        settingSources: []
      }
    })
    session.runtime = {
      input,
      interrupt: async () => {
        await handle.interrupt()
      }
    }
    void this.consume(session, handle as AsyncIterable<unknown>)
  }

  private async consume(session: ClaudeSession, stream: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const message of stream) {
        session.lastActivityMs = Date.now()
        const translation = session.translator?.handle(message)
        if (!translation) continue
        if (translation.sessionId && translation.sessionId !== session.claudeSessionId) {
          session.claudeSessionId = translation.sessionId
          void this.persistSessions()
        }
        for (const notification of translation.notifications) this.emitNotification(notification)
        if (translation.turnEnded) this.finishTurn(session)
      }
    } catch (error) {
      console.warn(`claude session ${session.threadId} stream failed:`, (error as Error).message)
      if (session.working && session.translator) {
        // Surface the failure as a failed turn so the UI never hangs on a
        // silent stream death (Phase 5 rules).
        this.emitNotification({
          method: 'turn/completed',
          params: {
            threadId: session.threadId,
            turn: {
              id: 'unknown',
              items: [],
              itemsView: 'full',
              status: 'failed',
              error: { message: `claude stream failed: ${(error as Error).message}` },
              startedAt: null,
              completedAt: Math.floor(Date.now() / 1000),
              durationMs: null
            }
          }
        } as never)
      }
      this.finishTurn(session)
    } finally {
      // Stream closed (idle-kill, interrupt-exit, or crash): free the slot.
      if (session.runtime) {
        session.runtime = null
        this.wakeSlotWaiter()
      }
    }
  }

  private finishTurn(session: ClaudeSession): void {
    session.working = false
    session.translator = null
    session.lastActivityMs = Date.now()
    this.scheduleIdleKill(session)
    this.wakeSlotWaiter()
  }

  private scheduleIdleKill(session: ClaudeSession): void {
    this.clearIdleTimer(session)
    session.idleTimer = setTimeout(() => {
      // D3: never mid-turn.
      if (!session.working) this.killSession(session)
    }, idleKillMs)
  }

  private clearIdleTimer(session: ClaudeSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
  }

  private killSession(session: ClaudeSession): void {
    this.clearIdleTimer(session)
    session.runtime?.input.end()
    session.runtime = null
    this.wakeSlotWaiter()
  }

  private wakeSlotWaiter(): void {
    const waiter = this.slotWaiters.shift()
    waiter?.()
  }

  private emitNotification(notification: unknown): void {
    this.emit('event', { type: 'notification', notification } satisfies SessionEvent)
  }

  private async loadPersisted(): Promise<PersistedSessions> {
    if (this.persisted) return this.persisted
    try {
      this.persisted = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedSessions
    } catch {
      this.persisted = {}
    }
    return this.persisted
  }

  private async persistSessions(): Promise<void> {
    const persisted = await this.loadPersisted()
    for (const session of this.sessions.values()) {
      persisted[session.threadId] = {
        claudeSessionId: session.claudeSessionId,
        cwd: session.cwd,
        model: session.model
      }
    }
    try {
      await mkdir(dirname(this.statePath), { recursive: true })
      const temporary = `${this.statePath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
      await rename(temporary, this.statePath)
    } catch (error) {
      console.warn('failed to persist claude session map:', (error as Error).message)
    }
  }
}
