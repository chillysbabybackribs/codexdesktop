import { randomUUID } from 'node:crypto'
import type { SessionProvider } from '../providers/session-provider.js'
import type { SessionEvent, AgentSpawnedEvent } from '../../shared/ipc.js'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification.js'
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem.js'

export type { AgentSpawnedEvent } from '../../shared/ipc.js'

// The main-process subagent spawn primitive (Phase 1: blocking single).
//
// A lead's `spawn_subagent` tool call lands here. The orchestrator starts a
// child thread on the chosen provider, runs one full turn, and resolves the
// caller's promise with the child's final answer — the parent's tool call
// blocks until then, so the child's result becomes the function result the
// parent model reasons about next (the same synchronous shape research_web
// uses). It is deliberately NOT a fan-out engine yet: parallel gather needs a
// turn-injection mechanism the transport can't express, which is Phase 2.
//
// The orchestrator also (a) mints the roster `agentKey` so main and renderer
// agree on child identity, (b) announces each spawn so the renderer can create
// the worker session before its first event, and (c) cascades interrupts so a
// stopped lead never leaks a running child.

export type SpawnRequest = {
  parentThreadId: string | null
  parentTurnId: string | null
  parentAgentKey: string | null
  task: string
  title?: string | null
  model?: string | null
  cwd?: string | null
}

export type SpawnResult = {
  ok: boolean
  agentKey: string
  threadId: string | null
  finalText: string
  status: 'completed' | 'failed' | 'interrupted'
  error?: string
}

type PendingChild = {
  agentKey: string
  parentThreadId: string | null
  parentTurnId: string | null
  threadId: string | null
  provider: SessionProvider
  resolve: (result: SpawnResult) => void
  settled: boolean
  // The child's latest completed agent message, accumulated from streamed
  // item/completed events. The turn/completed payload arrives with
  // itemsView:'notLoaded' (items:[]), so the final answer must be captured from
  // the stream, not the terminal turn.
  lastAgentText: string
}

type ProviderSelector = (model: string | null | undefined) => SessionProvider

// The narrow view providers depend on for the spawn_subagent tool — kept small
// so a provider only sees "spawn a child and give me its result", not the full
// orchestrator. Breaks the construction cycle (orchestrator needs providers;
// providers need this) via a setter on each provider.
export interface SubagentSpawner {
  spawnAndAwait(request: SpawnRequest): Promise<SpawnResult>
}

// Extract the child's final answer from a completed turn's items — the last
// non-empty agent message, clipped so a runaway child can't flood the parent's
// context. Mirrors the renderer's turnAnswerText, but reads the wire Turn.
function finalAnswerFromItems(items: ThreadItem[], maxChars = 4000): string {
  let answer = ''
  for (const item of items) {
    if (item.type === 'agentMessage' && item.text.trim()) answer = item.text
  }
  return clip(answer, maxChars)
}

// Clip a child answer so a runaway subagent can't flood the parent's context.
function clip(text: string, maxChars = 4000): string {
  const flat = text.trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars).trimEnd()}…` : flat
}

export class SubagentOrchestrator {
  // Keyed by child threadId (known once the child's turn starts). Children
  // whose thread hasn't started yet are tracked in `pendingByAgentKey` until
  // their threadId is bound.
  private readonly byThreadId = new Map<string, PendingChild>()
  private readonly pendingByAgentKey = new Map<string, PendingChild>()
  private readonly selectProvider: ProviderSelector
  private readonly emit: (event: SessionEvent | AgentSpawnedEvent) => void

  constructor(
    selectProvider: ProviderSelector,
    emit: (event: SessionEvent | AgentSpawnedEvent) => void,
  ) {
    this.selectProvider = selectProvider
    this.emit = emit
  }

  // Called from the provider event bridge for EVERY event. Returns the event to
  // forward — for a child-thread notification it returns a tagged copy so the
  // renderer roster can nest it; for everything else it returns the event
  // unchanged. Also resolves the pending spawn promise on the child's terminal
  // event. Kept synchronous and side-effect-light so it can sit in the hot
  // bridge path.
  tagEvent(event: SessionEvent): SessionEvent {
    if (event.type !== 'notification') return event
    const notification = event.notification as ServerNotification | undefined
    const threadId = notificationThreadId(notification)
    if (!threadId) return event
    const child = this.byThreadId.get(threadId)
    if (!child) return event

    // Capture the child's answer as it streams: the terminal turn/completed
    // arrives with itemsView:'notLoaded', so the final text lives in the
    // item/completed events, not the turn payload.
    if (notification?.method === 'item/completed') {
      const item = notification.params.item
      if (item.type === 'agentMessage' && item.text.trim()) {
        child.lastAgentText = item.text
      }
    }

    this.maybeSettle(child, notification)

    // Tag at the envelope only — the wire ServerNotification is never mutated.
    return {
      ...event,
      parentThreadId: child.parentThreadId,
      parentAgentKey: child.agentKey === child.parentThreadId ? null : child.agentKey,
      agentKey: child.agentKey,
    }
  }

  // Start a child turn and resolve when it finishes. The returned promise never
  // rejects on a child failure — the parent model must SEE the failure as a
  // tool result, so failures resolve with { ok:false }. It rejects only on an
  // orchestration bug (provider start throwing), which the router turns into an
  // error result.
  async spawnAndAwait(request: SpawnRequest): Promise<SpawnResult> {
    const agentKey = randomUUID()
    const title = (request.title?.trim() || 'Subagent').slice(0, 80)
    const provider = this.selectProvider(request.model)

    const pending: PendingChild = {
      agentKey,
      parentThreadId: request.parentThreadId,
      parentTurnId: request.parentTurnId,
      threadId: null,
      provider,
      resolve: () => {},
      settled: false,
      lastAgentText: '',
    }
    this.pendingByAgentKey.set(agentKey, pending)

    const done = new Promise<SpawnResult>((resolve) => {
      pending.resolve = resolve
    })

    // Announce before any turn events so the renderer can create the worker
    // session and route the child's stream to it.
    this.emit({
      type: 'agentSpawned',
      agentKey,
      parentAgentKey: request.parentAgentKey,
      parentThreadId: request.parentThreadId,
      title,
      model: request.model ?? null,
    })

    try {
      const response = await provider.sendMessage(
        null,
        request.task,
        request.cwd,
        request.model ?? null,
      )
      pending.threadId = response.threadId
      this.byThreadId.set(response.threadId, pending)
      this.pendingByAgentKey.delete(agentKey)
    } catch (error) {
      this.pendingByAgentKey.delete(agentKey)
      const message = error instanceof Error ? error.message : String(error)
      const result: SpawnResult = {
        ok: false,
        agentKey,
        threadId: null,
        finalText: '',
        status: 'failed',
        error: message,
      }
      // Resolve rather than throw so a start failure is still a tool result.
      this.settle(pending, result)
      return done
    }

    return done
  }

  // Interrupt every in-flight child of a parent turn and settle their promises.
  // Called when the parent turn is interrupted so a stopped lead never leaves
  // orphan children burning tokens. When turnId is omitted, cascades to all of
  // the parent thread's children (parent thread closing).
  interruptChildrenOf(parentThreadId: string, parentTurnId?: string): void {
    for (const child of this.childrenOf(parentThreadId, parentTurnId)) {
      if (child.threadId) {
        // Best-effort: the child may already be completing.
        void child.provider
          .interruptTurn(child.threadId, child.threadId)
          .catch(() => {})
      }
      this.settle(child, {
        ok: false,
        agentKey: child.agentKey,
        threadId: child.threadId,
        finalText: '',
        status: 'interrupted',
      })
    }
  }

  private childrenOf(parentThreadId: string, parentTurnId?: string): PendingChild[] {
    const all = [...this.byThreadId.values(), ...this.pendingByAgentKey.values()]
    return all.filter(
      (child) =>
        !child.settled &&
        child.parentThreadId === parentThreadId &&
        (parentTurnId === undefined || child.parentTurnId === parentTurnId),
    )
  }

  private maybeSettle(child: PendingChild, notification: ServerNotification | undefined): void {
    if (!notification || child.settled) return
    if (notification.method === 'turn/completed') {
      const turn = notification.params.turn
      // Prefer the answer accumulated from the stream; fall back to the turn
      // payload's items on the rare chance they are loaded.
      const finalText = child.lastAgentText.trim()
        ? clip(child.lastAgentText)
        : finalAnswerFromItems(turn.items ?? [])
      const failed = turn.status === 'failed'
      this.settle(child, {
        ok: !failed,
        agentKey: child.agentKey,
        threadId: child.threadId,
        finalText,
        status: failed ? 'failed' : 'completed',
        ...(failed && turn.error?.message ? { error: turn.error.message } : {}),
      })
      return
    }
    // A terminal (non-retrying) error also ends the child.
    if (notification.method === 'error' && !notification.params.willRetry) {
      this.settle(child, {
        ok: false,
        agentKey: child.agentKey,
        threadId: child.threadId,
        finalText: '',
        status: 'failed',
        error: notification.params.error?.message,
      })
    }
  }

  private settle(child: PendingChild, result: SpawnResult): void {
    if (child.settled) return
    child.settled = true
    if (child.threadId) this.byThreadId.delete(child.threadId)
    this.pendingByAgentKey.delete(child.agentKey)
    child.resolve(result)
  }
}

// Best-effort threadId extraction from any notification whose params carry one.
// The wire notifications that matter here (turn/*, item/*, error) all include
// threadId in params; anything else returns null and is forwarded untagged.
function notificationThreadId(notification: ServerNotification | undefined): string | null {
  if (!notification || typeof notification !== 'object') return null
  const params = (notification as { params?: unknown }).params
  if (!params || typeof params !== 'object') return null
  const threadId = (params as { threadId?: unknown }).threadId
  return typeof threadId === 'string' ? threadId : null
}
