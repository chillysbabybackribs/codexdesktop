import type { ServerNotification } from '../../shared/session-protocol'
import type { ReasoningEffort } from '../../shared/session-protocol'
import type { ThreadGoal } from '../../shared/session-protocol'
import type { ThreadTokenUsage } from '../../shared/session-protocol'
import type { Turn } from '../../shared/session-protocol'
import type { ItemMeta } from './activity-model.js'
import {
  isItemNotification,
  reduceItemNotificationItems,
  reduceItemNotificationMeta
} from './item-notifications.js'
import {
  modelCallAttributionForItem,
  reduceTurnTelemetry,
  type ModelCallAttribution,
  type TurnMeta
} from './turn-telemetry.js'
import { stripOptimisticUserMessage } from './optimistic-user-message.js'
import { upsertMany, type ChatItem } from './transcript-model.js'
import { summarizeTurnDiff } from './diff.js'

// Phase 2: one render model for every conversation surface (active main chat,
// background main-chat tabs, dock agents), keyed by session, held outside
// React. This file is the pure core: SessionRenderState generalizes App.tsx's
// MainChatSnapshot, and reduceSessionNotification is the single notification →
// state path (ported from handleBackgroundMainChatNotification /
// reduceBackgroundTurnSnapshot, parameterized so no clocks or refs are read).
// Side effects (OS notifications, trace/memory persistence, tab chip patches)
// stay with callers.

export type ActiveCompaction = {
  itemId: string
  turnId: string
  beforeTokens: number | null
}

export type SessionRenderState = {
  threadId: string | null
  title: string
  turnId: string | null
  goal: ThreadGoal | null
  reasoningEffort: ReasoningEffort | null
  items: ChatItem[]
  itemMeta: Record<string, ItemMeta>
  turnMeta: Record<string, TurnMeta>
  contextUsage: ThreadTokenUsage | null
  isCompacting: boolean
  activeCompaction: ActiveCompaction | null
  precedingModelInputByTurn: ReadonlyMap<string, ModelCallAttribution>
  pendingCompactionByTurn: ReadonlySet<string>
}

export function emptySessionState(init: Partial<SessionRenderState> = {}): SessionRenderState {
  return {
    threadId: null,
    title: '',
    turnId: null,
    goal: null,
    reasoningEffort: null,
    items: [],
    itemMeta: {},
    turnMeta: {},
    contextUsage: null,
    isCompacting: false,
    activeCompaction: null,
    precedingModelInputByTurn: new Map<string, ModelCallAttribution>(),
    pendingCompactionByTurn: new Set<string>(),
    ...init
  }
}

export type SessionReduceContext = {
  /** Wall-clock for telemetry stamps; injected so replays are deterministic. */
  atMs: number
  /** Model recorded on a turn when its telemetry has none yet. */
  fallbackModel?: string | null
  /** Workspace recorded on a turn when its telemetry has none yet. */
  workspace?: string | null
}

function cloneGoal(goal: ThreadGoal | null): ThreadGoal | null {
  return goal ? { ...goal } : null
}

// Persisted/resumed turns enumerate their items as item-0, item-1, … while
// live streams use stable provider ids. The two families never coexist for a
// healthy turn; spotting the transient family is how merges stay one-source.
export function isResumeEnumeratedId(id: string): boolean {
  return /^item-\d+$/.test(id)
}

// Port of App.tsx reduceBackgroundTurnSnapshot: fold a full Turn payload
// (turn/started or turn/completed) into the session.
export function reduceSessionTurn(
  state: SessionRenderState,
  turn: Turn,
  completed: boolean,
  context: SessionReduceContext
): SessionRenderState {
  const nextItemMeta = { ...state.itemMeta }
  for (const item of turn.items) {
    nextItemMeta[item.id] = { ...nextItemMeta[item.id], turnId: turn.id }
  }
  const status = completed
    ? (turn.status === 'inProgress' ? 'completed' : turn.status)
    : 'inProgress'
  const nextTurnMeta = reduceTurnTelemetry(state.turnMeta, {
    type: 'patch',
    turnId: turn.id,
    patch: {
      status,
      origin: 'live',
      model: state.turnMeta[turn.id]?.model ?? context.fallbackModel ?? undefined,
      reasoningEffort: state.turnMeta[turn.id]?.reasoningEffort ?? state.reasoningEffort,
      workspace: state.turnMeta[turn.id]?.workspace ?? context.workspace ?? undefined,
      startedAtMs: turn.startedAt ? turn.startedAt * 1000 : state.turnMeta[turn.id]?.startedAtMs,
      ...(completed ? {
        completedAtMs: turn.completedAt ? turn.completedAt * 1000 : context.atMs,
        durationMs: turn.durationMs ?? undefined,
        errorMessage: turn.error?.message,
        goalAtEnd: cloneGoal(state.goal)
      } : {
        goalAtStart: cloneGoal(state.goal),
        goalAtEnd: cloneGoal(state.goal)
      })
    }
  })

  return {
    ...state,
    turnId: completed ? null : turn.id,
    items: upsertMany(state.items, turn.items),
    itemMeta: nextItemMeta,
    turnMeta: nextTurnMeta,
    isCompacting: completed ? false : state.isCompacting,
    activeCompaction: completed ? null : state.activeCompaction
  }
}

// The single notification → session-state path. Returns the SAME reference
// when the notification does not change this session, so subscribers can use
// identity checks.
export function reduceSessionNotification(
  state: SessionRenderState,
  notification: ServerNotification,
  context: SessionReduceContext
): SessionRenderState {
  if (isItemNotification(notification)) {
    const nextPrecedingModelInput = new Map(state.precedingModelInputByTurn)
    const nextPendingCompaction = new Set(state.pendingCompactionByTurn)
    let nextActiveCompaction = state.activeCompaction
    let compactionBeforeTokens: number | null | undefined

    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      const item = notification.params.item
      if (item.type === 'contextCompaction') {
        nextPendingCompaction.add(notification.params.turnId)
      } else {
        const attribution = modelCallAttributionForItem(item)
        if (attribution) nextPrecedingModelInput.set(notification.params.turnId, attribution)
      }
      if (notification.method === 'item/started' && item.type === 'contextCompaction') {
        compactionBeforeTokens = state.contextUsage?.last.totalTokens ?? null
        nextActiveCompaction = {
          itemId: item.id,
          turnId: notification.params.turnId,
          beforeTokens: compactionBeforeTokens
        }
      }
    }

    const optimisticId = state.items.find((item) => item.id.startsWith('optimistic-user-'))?.id ?? null
    const incomingItems = notification.method === 'item/started' || notification.method === 'item/completed'
      ? [notification.params.item]
      : []
    // The app-server names the same items differently live vs persisted:
    // streams carry stable ids (rs_*/msg_*/exec-*/uuid) while resumed turns
    // re-enumerate as item-N. A turn seeded from resume that then streams live
    // (reload mid-turn) would keep both copies, doubling every row — so the
    // first live item for a turn evicts that turn's resume-shaped rows.
    const incomingId = incomingItems[0]?.id
    const baseItems = incomingId !== undefined && !isResumeEnumeratedId(incomingId)
      ? state.items.filter(
          (item) =>
            !(
              isResumeEnumeratedId(item.id) &&
              state.itemMeta[item.id]?.turnId === notification.params.turnId
            )
        )
      : state.items
    const nextItems = reduceItemNotificationItems(
      stripOptimisticUserMessage(baseItems, optimisticId, incomingItems),
      notification
    )
    const nextItemMeta = reduceItemNotificationMeta(state.itemMeta, notification, { compactionBeforeTokens })
    const compactionStarted = notification.method === 'item/started' && notification.params.item.type === 'contextCompaction'
    const compactionCompleted = notification.method === 'item/completed' && notification.params.item.type === 'contextCompaction'

    return {
      ...state,
      items: nextItems,
      itemMeta: nextItemMeta,
      isCompacting: compactionStarted ? true : compactionCompleted ? false : state.isCompacting,
      activeCompaction: compactionCompleted ? null : nextActiveCompaction,
      precedingModelInputByTurn: nextPrecedingModelInput,
      pendingCompactionByTurn: nextPendingCompaction
    }
  }

  switch (notification.method) {
    case 'thread/name/updated':
      return { ...state, title: notification.params.threadName || 'New Chat' }
    case 'turn/started':
      return reduceSessionTurn(state, notification.params.turn, false, context)
    case 'turn/completed':
      return reduceSessionTurn(state, notification.params.turn, true, context)
    case 'thread/goal/updated':
      return { ...state, goal: cloneGoal(notification.params.goal) }
    case 'thread/goal/cleared':
      return { ...state, goal: null }
    case 'thread/tokenUsage/updated': {
      const existing = state.turnMeta[notification.params.turnId]?.tokens
      const isNewCall = existing
        ? notification.params.tokenUsage.total.totalTokens > existing.threadTotalAtEnd.totalTokens
        : notification.params.tokenUsage.last.totalTokens > 0
      const nextPendingCompaction = new Set(state.pendingCompactionByTurn)
      const compactedBeforeCall = isNewCall
        ? nextPendingCompaction.delete(notification.params.turnId)
        : false
      return {
        ...state,
        contextUsage: notification.params.tokenUsage,
        pendingCompactionByTurn: nextPendingCompaction,
        turnMeta: reduceTurnTelemetry(state.turnMeta, {
          type: 'tokenUsage',
          turnId: notification.params.turnId,
          tokenUsage: notification.params.tokenUsage,
          atMs: context.atMs,
          precedingItem: state.precedingModelInputByTurn.get(notification.params.turnId) ?? null,
          compactedBeforeCall
        })
      }
    }
    case 'model/rerouted':
      return {
        ...state,
        turnMeta: reduceTurnTelemetry(state.turnMeta, {
          type: 'modelRerouted',
          turnId: notification.params.turnId,
          atMs: context.atMs,
          fromModel: notification.params.fromModel,
          toModel: notification.params.toModel,
          reason: notification.params.reason
        })
      }
    case 'turn/diff/updated':
      return {
        ...state,
        turnMeta: reduceTurnTelemetry(state.turnMeta, {
          type: 'patch',
          turnId: notification.params.turnId,
          patch: { diffSummary: summarizeTurnDiff(notification.params.diff) }
        })
      }
    case 'error':
      if (!notification.params.willRetry && state.turnId !== null) {
        return { ...state, turnId: null }
      }
      return state
    default:
      return state
  }
}

// Subscribable map of session key → render state. Snapshot references are
// stable (only update() replaces them), so this plugs directly into
// useSyncExternalStore at wiring time.
export class SessionStore {
  private readonly sessions = new Map<string, SessionRenderState>()
  private readonly keyListeners = new Map<string, Set<() => void>>()
  private readonly anyListeners = new Set<() => void>()

  get(key: string): SessionRenderState {
    let state = this.sessions.get(key)
    if (!state) {
      state = emptySessionState()
      this.sessions.set(key, state)
    }
    return state
  }

  peek(key: string): SessionRenderState | undefined {
    return this.sessions.get(key)
  }

  keys(): string[] {
    return [...this.sessions.keys()]
  }

  set(key: string, state: SessionRenderState): void {
    if (this.sessions.get(key) === state) return
    this.sessions.set(key, state)
    this.notify(key)
  }

  update(key: string, updater: (state: SessionRenderState) => SessionRenderState): SessionRenderState {
    const current = this.get(key)
    const next = updater(current)
    if (next !== current) {
      this.sessions.set(key, next)
      this.notify(key)
    }
    return next
  }

  remove(key: string): void {
    if (!this.sessions.delete(key)) return
    this.notify(key)
  }

  subscribe(key: string, listener: () => void): () => void {
    let listeners = this.keyListeners.get(key)
    if (!listeners) {
      listeners = new Set()
      this.keyListeners.set(key, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.keyListeners.delete(key)
    }
  }

  subscribeAll(listener: () => void): () => void {
    this.anyListeners.add(listener)
    return () => {
      this.anyListeners.delete(listener)
    }
  }

  private notify(key: string): void {
    for (const listener of this.keyListeners.get(key) ?? []) listener()
    for (const listener of this.anyListeners) listener()
  }
}
