import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort.js';
import type { GetAuthStatusResponse } from '../../shared/codex-protocol/GetAuthStatusResponse.js';
import type { Model } from '../../shared/session-protocol/index.js';
import type { ThreadListResponse } from '../../shared/codex-protocol/v2/ThreadListResponse.js';
import type { ThreadTurnsListResponse } from '../../shared/codex-protocol/v2/ThreadTurnsListResponse.js';
import type { ThreadGoal } from '../../shared/codex-protocol/v2/ThreadGoal.js';
import type { ThreadGoalClearResponse } from '../../shared/codex-protocol/v2/ThreadGoalClearResponse.js';
import type { ThreadGoalSetParams } from '../../shared/codex-protocol/v2/ThreadGoalSetParams.js';
import type { ThreadResumeResponse } from '../../shared/codex-protocol/v2/ThreadResumeResponse.js';
import type { ThreadStartResponse } from '../../shared/codex-protocol/v2/ThreadStartResponse.js';
import type { ThreadUnsubscribeResponse } from '../../shared/codex-protocol/v2/ThreadUnsubscribeResponse.js';
import type { TokenUsageBreakdown } from '../../shared/codex-protocol/v2/TokenUsageBreakdown.js';
import type { Turn } from '../../shared/codex-protocol/v2/Turn.js';
import type { TurnStartResponse } from '../../shared/codex-protocol/v2/TurnStartResponse.js';
import type { PluginInstalledResponse } from '../../shared/codex-protocol/v2/PluginInstalledResponse.js';
import type { PluginListResponse } from '../../shared/codex-protocol/v2/PluginListResponse.js';
import type { PluginInstallParams } from '../../shared/codex-protocol/v2/PluginInstallParams.js';
import type { PluginInstallResponse } from '../../shared/codex-protocol/v2/PluginInstallResponse.js';
import type { PluginReadResponse } from '../../shared/codex-protocol/v2/PluginReadResponse.js';
import type {
  ChatAttachment,
  CodexListThreadTurnsParams,
  CodexPluginAppStatusResponse,
  SessionEvent,
} from '../../shared/ipc.js';
import type { ProviderCapabilities } from '../../shared/session-protocol/provider.js';
import type { ResumeHistoryConsumer } from '../codex/resume-history.js';
import type { TurnCheckpointStore } from '../turn-checkpoint.js';
import type { BrowserAgentController } from '../browser/browser-agent.js';
import type { ResearchRunner } from '../browser/research-runner.js';
import { runBrowserTool } from '../tools/browser-tool-registry.js';
import { buildClaudeBrowserMcpServer } from './claude-mcp-tools.js';
import {
  buildClaudeQueryOptions,
  synchronizeClaudeRuntimeSettings,
} from './claude-options.js';
import {
  buildClaudeModelCatalog,
  claudeDefaultModel,
  claudeRuntimeModel,
  normalizeClaudeEffort,
  type ClaudeEffort,
  type ClaudeSdkModelInfo,
} from './claude-models.js';
import type { SessionProvider } from './session-provider.js';
import {
  ClaudeTurnTranslator,
  claudeContextWindowFor,
  turnStartedNotification,
  type ClaudeTurnContext,
} from '../../shared/claude-events.js';

// The Claude adapter: SessionProvider #2, driving the Agent SDK under the
// approved lifecycle policy (docs/claude-prep-step7-process-policy-2026-07-19.md):
// bounded per-session processes (cap 3 live, queued beyond), 15-minute
// idle-kill (never mid-turn), resume via persisted session-id mapping, and the
// SDK's vendored version-pinned runtime (D4/D5). Unrestricted per the standing
// dev directive: bypassPermissions — parity with codex danger-full-access.

export const claudeCapabilities: ProviderCapabilities = {
  steering: false,
  reasoningEfforts: true,
  compaction: 'none',
  toolTransport: 'mcp',
  resume: true,
  goals: false,
  plugins: false,
  processModel: 'per-session',
  tokenTelemetry: true,
};

const maxLiveSessions = 3;
const idleKillMs = 15 * 60 * 1000;

type InputStream = {
  push: (message: unknown) => void;
  end: () => void;
  stream: () => AsyncGenerator<unknown>;
};

type LiveRuntime = {
  input: InputStream;
  interrupt: () => Promise<void>;
  setModel: (model: string | null) => Promise<void>;
  applySettings: (settings: { effort: ClaudeEffort | null; fastMode: boolean }) => Promise<void>;
  model: string | null;
  effort: ClaudeEffort | null;
  fastMode: boolean;
};

type SlotWaiter = {
  session: ClaudeSession;
  resolve: () => void;
  reject: (error: Error) => void;
};

type ClaudeSession = {
  threadId: string;
  claudeSessionId: string | null;
  cwd: string;
  model: string | null;
  effort: ClaudeEffort | null;
  fastMode: boolean;
  resolvedModel: string | null;
  runtime: LiveRuntime | null;
  startPromise: Promise<void> | null;
  slotReserved: boolean;
  waitingForSlot: boolean;
  working: boolean;
  activeTurnId: string | null;
  translator: ClaudeTurnTranslator | null;
  lastActivityMs: number;
  idleTimer: NodeJS.Timeout | null;
  total: TokenUsageBreakdown;
};

type PersistedSessions = Record<
  string,
  {
    claudeSessionId: string | null;
    cwd: string;
    model: string | null;
    effort?: ClaudeEffort | null;
    fastMode?: boolean;
  }
>;

function createInputStream(): InputStream {
  const queue: unknown[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  return {
    push(message) {
      queue.push(message);
      notify?.();
    },
    end() {
      done = true;
      notify?.();
    },
    async *stream() {
      while (true) {
        while (queue.length) yield queue.shift();
        if (done) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    },
  };
}

function emptyBreakdown(): TokenUsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ClaudeProvider extends EventEmitter implements SessionProvider {
  readonly id = 'claude' as const;
  readonly capabilities = claudeCapabilities;

  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly slotWaiters: SlotWaiter[] = [];
  private readonly statePath: string;
  private persisted: PersistedSessions | null = null;
  private readonly checkpoints: TurnCheckpointStore | null;
  private readonly browserAgent: BrowserAgentController | null;
  private readonly researchRunner: ResearchRunner | null;
  private mcpServerConfig: unknown | null = null;
  private modelCatalogPromise: Promise<Model[]> | null = null;
  private readonly modelsById = new Map<string, Model>();
  private disposed = false;

  constructor(
    checkpoints: TurnCheckpointStore | null = null,
    browserAgent: BrowserAgentController | null = null,
    researchRunner: ResearchRunner | null = null,
  ) {
    super();
    this.checkpoints = checkpoints;
    this.browserAgent = browserAgent;
    this.researchRunner = researchRunner;
    this.statePath = join(app.getPath('userData'), 'claude-sessions.json');
  }

  async warmUp(): Promise<void> {
    // Per policy: optional single pre-spawn is allowed but not required.
  }

  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    return { authMethod: null, authToken: null, requiresOpenaiAuth: false };
  }

  async listModels(): Promise<Model[]> {
    if (!this.modelCatalogPromise) {
      this.modelCatalogPromise = this.discoverModels()
        .catch((error) => {
          console.warn(
            'failed to discover Claude models; using the account default only:',
            (error as Error).message,
          );
          return [claudeDefaultModel()];
        })
        .then((models) => {
          this.modelsById.clear();
          for (const model of models) this.modelsById.set(model.model, model);
          return models;
        });
    }
    return this.modelCatalogPromise;
  }

  async listThreads(): Promise<ThreadListResponse> {
    return { data: [], nextCursor: null } as unknown as ThreadListResponse;
  }

  async startThread(cwd?: string | null, model?: string | null): Promise<ThreadStartResponse> {
    const threadId = `claude-${randomUUID()}`;
    const session = this.ensureSessionRecord(
      threadId,
      cwd ?? process.env.HOME ?? process.cwd(),
      model ?? null,
    );
    await this.persistSessions();
    return {
      thread: {
        id: session.threadId,
        turns: [],
        cwd: session.cwd,
      } as unknown as ThreadStartResponse['thread'],
      model: session.model,
      reasoningEffort: session.effort,
    } as unknown as ThreadStartResponse;
  }

  async resumeThread(
    threadId: string,
    _history?: ResumeHistoryConsumer,
  ): Promise<ThreadResumeResponse> {
    const persisted = (await this.loadPersisted())[threadId];
    if (!persisted && !this.sessions.has(threadId)) {
      throw new Error(`unknown claude session for thread ${threadId}`);
    }
    const session = this.ensureSessionRecord(
      threadId,
      persisted?.cwd ?? this.sessions.get(threadId)?.cwd ?? process.env.HOME ?? process.cwd(),
      persisted?.model ?? this.sessions.get(threadId)?.model ?? null,
      persisted?.effort ?? this.sessions.get(threadId)?.effort ?? null,
      persisted?.fastMode ?? this.sessions.get(threadId)?.fastMode ?? false,
    );
    if (persisted?.claudeSessionId) session.claudeSessionId = persisted.claudeSessionId;
    // History pages stay empty: the renderer paints from the transcript cache
    // and reconciles; live turns stream from here on.
    return {
      thread: {
        id: threadId,
        turns: [],
        cwd: session.cwd,
      } as unknown as ThreadResumeResponse['thread'],
      model: session.model,
      reasoningEffort: session.effort,
      cwd: session.cwd,
      initialTurnsPage: { data: [], nextCursor: null },
    } as unknown as ThreadResumeResponse;
  }

  async listThreadTurns(_params: CodexListThreadTurnsParams): Promise<ThreadTurnsListResponse> {
    return { data: [], nextCursor: null } as unknown as ThreadTurnsListResponse;
  }

  async sendMessage(
    threadId: string | null | undefined,
    text: string,
    cwd?: string | null,
    model?: string | null,
    _attachments: ChatAttachment[] = [],
    effort?: ReasoningEffort | null,
    fastMode = false,
  ): Promise<
    TurnStartResponse & {
      threadId: string;
      model: string | null;
      reasoningEffort: ReasoningEffort | null;
    }
  > {
    const activeThreadId = threadId ?? (await this.startThread(cwd, model)).thread.id;
    const session = this.ensureSessionRecord(
      activeThreadId,
      cwd ?? this.sessions.get(activeThreadId)?.cwd ?? process.env.HOME ?? process.cwd(),
      model ?? this.sessions.get(activeThreadId)?.model ?? null,
      normalizeClaudeEffort(effort),
      fastMode,
    );
    if (session.working) throw new Error('a turn is already running on this claude session');

    // Reversibility parity with the codex path: checkpoint before the turn,
    // fire-and-forget, bind once the turn id exists.
    const turnId = `claude-turn-${randomUUID()}`;
    if (this.checkpoints) {
      void this.checkpoints
        .createCheckpoint(session.cwd, activeThreadId, `before turn (${new Date().toISOString()})`)
        .then((record) => record && this.checkpoints!.assignTurn(record.id, turnId))
        .catch((error) => console.warn('claude turn checkpoint failed:', (error as Error).message));
    }

    const context: ClaudeTurnContext = {
      threadId: activeThreadId,
      turnId,
      nowMs: () => Date.now(),
      tokens: {
        contextWindow: claudeContextWindowFor(claudeRuntimeModel(session.model) ?? session.model),
        addLast: (last) => {
          session.total = {
            totalTokens: session.total.totalTokens + last.totalTokens,
            inputTokens: session.total.inputTokens + last.inputTokens,
            cachedInputTokens: session.total.cachedInputTokens + last.cachedInputTokens,
            outputTokens: session.total.outputTokens + last.outputTokens,
            reasoningOutputTokens: 0,
          };
          return { total: session.total, last };
        },
      },
    };
    session.translator = new ClaudeTurnTranslator(context);
    session.working = true;
    session.activeTurnId = turnId;
    session.lastActivityMs = Date.now();
    this.clearIdleTimer(session);

    this.emitNotification(turnStartedNotification(context, text));
    const response = {
      turn: {
        id: turnId,
        items: [],
        itemsView: 'full',
        status: 'inProgress',
        error: null,
        startedAt: Math.floor(Date.now() / 1000),
        completedAt: null,
        durationMs: null,
      } as unknown as Turn,
      threadId: activeThreadId,
      model: session.model,
      reasoningEffort: session.effort,
    } as unknown as TurnStartResponse & {
      threadId: string;
      model: string | null;
      reasoningEffort: ReasoningEffort | null;
    };

    try {
      await this.ensureLive(session);
      await synchronizeClaudeRuntimeSettings(session.runtime!, session);
      void this.persistSessions();
      session.runtime!.input.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: session.claudeSessionId ?? 'pending',
      });
    } catch (error) {
      if (session.working && session.activeTurnId === turnId) {
        this.emitNotification(
          this.failedTurnNotification(
            session,
            turnId,
            `claude runtime failed to start: ${(error as Error).message}`,
          ),
        );
        this.finishTurn(session);
      }
    }

    return response;
  }

  async interruptTurn(threadId: string, _turnId: string): Promise<unknown> {
    const session = this.sessions.get(threadId);
    if (session?.waitingForSlot && session.working && session.activeTurnId) {
      const waiterIndex = this.slotWaiters.findIndex((waiter) => waiter.session === session);
      if (waiterIndex >= 0) {
        const [waiter] = this.slotWaiters.splice(waiterIndex, 1);
        session.waitingForSlot = false;
        this.emitNotification(this.interruptedTurnNotification(session, session.activeTurnId));
        this.finishTurn(session);
        waiter.reject(new Error('claude turn interrupted while queued'));
      }
      return {};
    }
    if (session?.runtime && session.working) await session.runtime.interrupt();
    return {};
  }

  async steerTurn(): Promise<unknown> {
    throw new Error('the claude provider does not support mid-turn steering');
  }

  async compactThread(): Promise<{ started: boolean }> {
    return { started: false };
  }

  async unsubscribeThread(threadId: string): Promise<ThreadUnsubscribeResponse> {
    const session = this.sessions.get(threadId);
    if (session && !session.working) this.killSession(session);
    return {} as ThreadUnsubscribeResponse;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.slotWaiters.splice(0)) {
      waiter.session.waitingForSlot = false;
      waiter.reject(new Error('claude provider disposed'));
    }
    for (const session of this.sessions.values()) {
      this.clearIdleTimer(session);
      session.runtime?.input.end();
      session.runtime = null;
      session.slotReserved = false;
      session.waitingForSlot = false;
      session.working = false;
      session.activeTurnId = null;
      session.translator = null;
    }
  }

  async getGoal(_threadId: string): Promise<ThreadGoal | null> {
    return null;
  }

  async setGoal(_params: ThreadGoalSetParams): Promise<ThreadGoal> {
    throw new Error('the claude provider does not support thread goals');
  }

  async clearGoal(_threadId: string): Promise<ThreadGoalClearResponse> {
    return {} as ThreadGoalClearResponse;
  }

  async listInstalledPlugins(): Promise<PluginInstalledResponse> {
    return { plugins: [] } as unknown as PluginInstalledResponse;
  }

  async listPlugins(): Promise<PluginListResponse> {
    return { marketplaces: [] } as unknown as PluginListResponse;
  }

  async readPlugin(_params: PluginInstallParams): Promise<PluginReadResponse> {
    throw new Error('the claude provider does not support plugins');
  }

  async getPluginAppStatuses(): Promise<CodexPluginAppStatusResponse> {
    return { apps: [] } as unknown as CodexPluginAppStatusResponse;
  }

  async installPlugin(_params: PluginInstallParams): Promise<PluginInstallResponse> {
    throw new Error('the claude provider does not support plugins');
  }

  async uninstallPlugin(_pluginId: string): Promise<void> {
    throw new Error('the claude provider does not support plugins');
  }

  private async discoverModels(): Promise<Model[]> {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const input = createInputStream();
    const handle = sdk.query({
      prompt: input.stream() as AsyncIterable<never>,
      options: {
        ...buildClaudeQueryOptions(
          {
            cwd: process.env.HOME ?? process.cwd(),
            model: null,
            effort: null,
            fastMode: false,
            claudeSessionId: null,
          },
          null,
        ),
        persistSession: false,
      },
    });
    try {
      const models = await withTimeout(
        handle.supportedModels(),
        15_000,
        'Claude model discovery timed out',
      );
      return buildClaudeModelCatalog(models as ClaudeSdkModelInfo[]);
    } finally {
      input.end();
      handle.close();
    }
  }

  private supportsFastMode(model: string | null, requested: boolean): boolean {
    return requested && this.modelsById.get(model ?? '')?.supportsFastMode === true;
  }

  // ---- lifecycle internals -------------------------------------------------

  private ensureSessionRecord(
    threadId: string,
    cwd: string,
    model: string | null,
    effort?: ClaudeEffort | null,
    fastMode?: boolean,
  ): ClaudeSession {
    let session = this.sessions.get(threadId);
    if (!session) {
      session = {
        threadId,
        claudeSessionId: null,
        cwd,
        model,
        effort: effort ?? null,
        fastMode: this.supportsFastMode(model, fastMode === true),
        resolvedModel: null,
        runtime: null,
        startPromise: null,
        slotReserved: false,
        waitingForSlot: false,
        working: false,
        activeTurnId: null,
        translator: null,
        lastActivityMs: Date.now(),
        idleTimer: null,
        total: emptyBreakdown(),
      };
      this.sessions.set(threadId, session);
    }
    if (model) session.model = model;
    if (effort !== undefined) session.effort = effort;
    if (fastMode !== undefined) session.fastMode = this.supportsFastMode(session.model, fastMode);
    return session;
  }

  private liveSessions(): ClaudeSession[] {
    return [...this.sessions.values()].filter((session) => session.slotReserved);
  }

  private async ensureLive(session: ClaudeSession): Promise<void> {
    if (session.runtime) return;
    if (session.startPromise) return session.startPromise;

    const startPromise = this.startLive(session);
    session.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (session.startPromise === startPromise) session.startPromise = null;
    }
  }

  private async startLive(session: ClaudeSession): Promise<void> {
    await this.acquireSlot(session);
    if (this.disposed) {
      this.releaseSlot(session);
      throw new Error('claude provider disposed');
    }

    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      if (this.disposed) throw new Error('claude provider disposed');
      const { query } = sdk;
      // In-process MCP browser tools (built once): Claude sessions drive the
      // SAME embedded browser through the SAME neutral dispatch the codex
      // dynamic tools use — ownerless, like the socket transport.
      if (!this.mcpServerConfig && this.browserAgent) {
        const browserAgent = this.browserAgent;
        const researchRunner = this.researchRunner ?? undefined;
        this.mcpServerConfig = buildClaudeBrowserMcpServer(sdk as never, (tool, args) =>
          runBrowserTool(
            { tool, args, owner: null, callId: `claude-mcp-${randomUUID()}` },
            { browserAgent, researchRunner },
          ),
        );
      }
      const input = createInputStream();
      const handle = query({
        prompt: input.stream() as AsyncIterable<never>,
        options: buildClaudeQueryOptions(session, this.mcpServerConfig),
      });
      const runtime: LiveRuntime = {
        input,
        interrupt: async () => {
          await handle.interrupt();
        },
        setModel: async (model) => {
          await handle.setModel(model ?? undefined);
        },
        applySettings: async (settings) => {
          await handle.applyFlagSettings({
            effortLevel: settings.effort,
            fastMode: settings.fastMode,
            fastModePerSessionOptIn: true,
          } as never);
        },
        model: claudeRuntimeModel(session.model),
        effort: session.effort,
        fastMode: session.fastMode,
      };
      session.runtime = runtime;
      void this.consume(session, runtime, handle as AsyncIterable<unknown>);
    } catch (error) {
      this.releaseSlot(session);
      throw error;
    }
  }

  private async consume(
    session: ClaudeSession,
    runtime: LiveRuntime,
    stream: AsyncIterable<unknown>,
  ): Promise<void> {
    try {
      for await (const message of stream) {
        if (session.runtime !== runtime) break;
        session.lastActivityMs = Date.now();
        const translation = session.translator?.handle(message);
        if (!translation) continue;
        if (translation.sessionId && translation.sessionId !== session.claudeSessionId) {
          session.claudeSessionId = translation.sessionId;
          void this.persistSessions();
        }
        if (translation.model) session.resolvedModel = translation.model;
        for (const notification of translation.notifications) this.emitNotification(notification);
        if (translation.turnEnded) this.finishTurn(session);
      }
      if (
        !this.disposed &&
        session.runtime === runtime &&
        session.working &&
        session.activeTurnId
      ) {
        this.emitNotification(
          this.failedTurnNotification(
            session,
            session.activeTurnId,
            'claude stream ended before the turn completed',
          ),
        );
        this.finishTurn(session);
      }
    } catch (error) {
      console.warn(`claude session ${session.threadId} stream failed:`, (error as Error).message);
      if (
        !this.disposed &&
        session.runtime === runtime &&
        session.working &&
        session.activeTurnId
      ) {
        // Surface the failure as a failed turn so the UI never hangs on a
        // silent stream death (Phase 5 rules).
        this.emitNotification(
          this.failedTurnNotification(
            session,
            session.activeTurnId,
            `claude stream failed: ${(error as Error).message}`,
          ),
        );
        this.finishTurn(session);
      }
    } finally {
      // Stream closed (idle-kill, interrupt-exit, or crash): free the slot.
      if (session.runtime === runtime) {
        session.runtime = null;
        this.releaseSlot(session);
      }
    }
  }

  private finishTurn(session: ClaudeSession): void {
    session.working = false;
    session.activeTurnId = null;
    session.translator = null;
    session.lastActivityMs = Date.now();
    if (!this.disposed) this.scheduleIdleKill(session);
    this.drainSlotWaiters();
  }

  private scheduleIdleKill(session: ClaudeSession): void {
    this.clearIdleTimer(session);
    session.idleTimer = setTimeout(() => {
      // D3: never mid-turn.
      if (!session.working) this.killSession(session);
    }, idleKillMs);
  }

  private clearIdleTimer(session: ClaudeSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  private killSession(session: ClaudeSession, drain = true): void {
    this.clearIdleTimer(session);
    session.runtime?.input.end();
    session.runtime = null;
    this.releaseSlot(session, drain);
  }

  private acquireSlot(session: ClaudeSession): Promise<void> {
    if (session.slotReserved) return Promise.resolve();
    if (this.disposed) return Promise.reject(new Error('claude provider disposed'));

    if (this.liveSessions().length >= maxLiveSessions) {
      const idle = this.liveSessions()
        .filter((candidate) => candidate.runtime && !candidate.working)
        .sort((a, b) => a.lastActivityMs - b.lastActivityMs)[0];
      if (idle) this.killSession(idle, false);
    }
    if (this.liveSessions().length < maxLiveSessions) {
      session.slotReserved = true;
      return Promise.resolve();
    }

    session.waitingForSlot = true;
    return new Promise<void>((resolve, reject) =>
      this.slotWaiters.push({ session, resolve, reject }),
    );
  }

  private releaseSlot(session: ClaudeSession, drain = true): void {
    session.slotReserved = false;
    if (drain) this.drainSlotWaiters();
  }

  private drainSlotWaiters(): void {
    while (this.slotWaiters.length > 0) {
      const waiter = this.slotWaiters[0];
      if (this.disposed || !waiter.session.working) {
        this.slotWaiters.shift();
        waiter.session.waitingForSlot = false;
        waiter.reject(
          new Error(
            this.disposed ? 'claude provider disposed' : 'claude turn was cancelled while queued',
          ),
        );
        continue;
      }
      if (this.liveSessions().length >= maxLiveSessions) {
        const idle = this.liveSessions()
          .filter((candidate) => candidate.runtime && !candidate.working)
          .sort((a, b) => a.lastActivityMs - b.lastActivityMs)[0];
        if (!idle) return;
        this.killSession(idle, false);
      }
      this.slotWaiters.shift();
      waiter.session.waitingForSlot = false;
      waiter.session.slotReserved = true;
      waiter.resolve();
    }
  }

  private failedTurnNotification(session: ClaudeSession, turnId: string, message: string): unknown {
    return {
      method: 'turn/completed',
      params: {
        threadId: session.threadId,
        turn: {
          id: turnId,
          items: [],
          itemsView: 'full',
          status: 'failed',
          error: { message, codexErrorInfo: 'other', additionalDetails: null },
          startedAt: null,
          completedAt: Math.floor(Date.now() / 1000),
          durationMs: null,
        },
      },
    };
  }

  private interruptedTurnNotification(session: ClaudeSession, turnId: string): unknown {
    return {
      method: 'turn/completed',
      params: {
        threadId: session.threadId,
        turn: {
          id: turnId,
          items: [],
          itemsView: 'full',
          status: 'interrupted',
          error: null,
          startedAt: null,
          completedAt: Math.floor(Date.now() / 1000),
          durationMs: null,
        },
      },
    };
  }

  private emitNotification(notification: unknown): void {
    this.emit('event', { type: 'notification', notification } satisfies SessionEvent);
  }

  private async loadPersisted(): Promise<PersistedSessions> {
    if (this.persisted) return this.persisted;
    try {
      this.persisted = JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedSessions;
    } catch {
      this.persisted = {};
    }
    return this.persisted;
  }

  private async persistSessions(): Promise<void> {
    const persisted = await this.loadPersisted();
    for (const session of this.sessions.values()) {
      persisted[session.threadId] = {
        claudeSessionId: session.claudeSessionId,
        cwd: session.cwd,
        model: session.model,
        effort: session.effort,
        fastMode: session.fastMode,
      };
    }
    try {
      await mkdir(dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
      await rename(temporary, this.statePath);
    } catch (error) {
      console.warn('failed to persist claude session map:', (error as Error).message);
    }
  }
}
