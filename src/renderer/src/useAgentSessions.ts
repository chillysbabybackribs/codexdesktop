import { useEffect, useRef, useState } from 'react'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification'
import type { TurnError } from '../../shared/codex-protocol/v2/TurnError'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort'
import {
  appendAgentSessionMessage,
  applyAgentDeltas,
  createAgentSession,
  completeAgentMessage,
  findAgentSessionByThread,
  serializeAgentDock,
  updateAgentSession,
  type AgentLiteMessage,
  type AgentSession
} from './agent-session-model'
import {
  assignTarget,
  collectTargets,
  createDefaultLayout,
  findFirstLeaf,
  findLeaf,
  findLeafForTarget,
  legacySelectionFromTarget,
  normalizeLayout,
  parseLayoutNode,
  removeTarget,
  serializeLayoutNode,
  targetFromLegacySelection,
  type ConversationTarget,
  type LayoutNode
} from './conversation-layout'

export function useAgentSessions(
  storageKey: string,
  recovery: {
    schedule: (key: string, turnId: string, error: TurnError | null) => void
    cancel: (key: string) => void
  }
): {
  agentSessions: AgentSession[]
  selectedAgentKey: string | null
  setSelectedAgentKey: React.Dispatch<React.SetStateAction<string | null>>
  conversationLayout: LayoutNode
  setConversationLayout: React.Dispatch<React.SetStateAction<LayoutNode>>
  focusedLeafId: string
  setFocusedLeafId: React.Dispatch<React.SetStateAction<string>>
  focusedTarget: ConversationTarget
  visibleTargets: ConversationTarget[]
  handleSelectConversation: (target: ConversationTarget) => void
  handleRemoveConversationTarget: (target: ConversationTarget) => void
  restoreConversationLayout: (layout: LayoutNode | null, focusedLeafId: string | null, fallbackTarget: ConversationTarget) => void
  agentSessionsRef: React.MutableRefObject<AgentSession[]>
  agentStartQueueRef: React.MutableRefObject<string[]>
  agentCounterRef: React.MutableRefObject<number>
  agentDockRestoredRef: React.MutableRefObject<boolean>
  updateAgentSessions: (update: (sessions: AgentSession[]) => AgentSession[]) => void
  patchAgentSession: (key: string, update: (session: AgentSession) => AgentSession) => void
  appendAgentMessage: (key: string, message: AgentLiteMessage) => void
  appendAgentMessageOnce: (key: string, message: AgentLiteMessage) => void
  backgroundSessionForThread: (threadId: string) => AgentSession | null
  handleAgentNotification: (session: AgentSession, notification: ServerNotification) => void
  handleNewAgent: () => void
  handleToggleWatchAgent: (key: string) => void
  handleSetAgentModel: (key: string, model: string, effort?: ReasoningEffort) => void
} {
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([])
  const [conversationLayout, setConversationLayout] = useState<LayoutNode>(() => createDefaultLayout())
  const [focusedLeafId, setFocusedLeafId] = useState<string>(() => findFirstLeaf(createDefaultLayout()).id)
  const agentSessionsRef = useRef<AgentSession[]>([])
  const agentDeltaBufferRef = useRef<Map<string, Map<string, string>>>(new Map())
  const agentDeltaTimerRef = useRef<number | null>(null)
  const agentStartQueueRef = useRef<string[]>([])
  const agentCounterRef = useRef(2)
  const agentDockRestoredRef = useRef(false)
  const focusedLeafIdRef = useRef(focusedLeafId)

  const focusedTarget = findLeaf(conversationLayout, focusedLeafId)?.target ?? 'main'
  const selectedAgentKey = legacySelectionFromTarget(focusedTarget)
  const visibleTargets = collectTargets(conversationLayout)

  function validTargets(sessions: AgentSession[]): Set<ConversationTarget> {
    return new Set(['main', ...sessions.map((session) => session.key)])
  }

  function updateAgentSessions(update: (sessions: AgentSession[]) => AgentSession[]): void {
    agentSessionsRef.current = update(agentSessionsRef.current)
    setAgentSessions(agentSessionsRef.current)
  }

  function patchAgentSession(key: string, update: (session: AgentSession) => AgentSession): void {
    updateAgentSessions((sessions) => updateAgentSession(sessions, key, update))
  }

  function appendAgentMessage(key: string, message: AgentLiteMessage): void {
    updateAgentSessions((sessions) => appendAgentSessionMessage(sessions, key, message))
  }

  function appendAgentMessageOnce(key: string, message: AgentLiteMessage): void {
    updateAgentSessions((sessions) => appendAgentSessionMessage(sessions, key, message, true))
  }

  function backgroundSessionForThread(threadId: string): AgentSession | null {
    return findAgentSessionByThread(agentSessionsRef.current, threadId)
  }

  useEffect(() => {
    focusedLeafIdRef.current = focusedLeafId
  }, [focusedLeafId])

  function handleSelectConversation(target: ConversationTarget): void {
    const existing = findLeafForTarget(conversationLayout, target)
    if (existing) {
      setFocusedLeafId(existing.id)
      return
    }
    setConversationLayout((current) => assignTarget(current, focusedLeafIdRef.current, target))
  }

  function handleRemoveConversationTarget(target: ConversationTarget): void {
    setConversationLayout((current) => {
      const next = removeTarget(current, target)
      const nextFocused = findLeaf(next, focusedLeafId) ?? findFirstLeaf(next)
      setFocusedLeafId(nextFocused.id)
      return next
    })
  }

  function restoreConversationLayout(
    layout: LayoutNode | null,
    nextFocusedLeafId: string | null,
    fallbackTarget: ConversationTarget
  ): void {
    const targets = validTargets(agentSessionsRef.current)
    const restored = layout
      ? normalizeLayout(layout, targets)
      : createDefaultLayout(fallbackTarget)
    setConversationLayout(restored)
    const focused = (nextFocusedLeafId ? findLeaf(restored, nextFocusedLeafId) : null)
      ?? findLeafForTarget(restored, fallbackTarget)
      ?? findFirstLeaf(restored)
    setFocusedLeafId(focused.id)
  }

  function setSelectedAgentKey(value: React.SetStateAction<string | null>): void {
    const next = typeof value === 'function' ? value(selectedAgentKey) : value
    handleSelectConversation(targetFromLegacySelection(next))
  }

  function flushAgentDeltas(): void {
    if (agentDeltaTimerRef.current !== null) {
      window.clearTimeout(agentDeltaTimerRef.current)
      agentDeltaTimerRef.current = null
    }
    const buffer = agentDeltaBufferRef.current
    if (!buffer.size) return
    agentDeltaBufferRef.current = new Map()
    updateAgentSessions((sessions) => applyAgentDeltas(sessions, buffer))
  }

  function enqueueAgentDelta(key: string, itemId: string, delta: string): void {
    let perItem = agentDeltaBufferRef.current.get(key)
    if (!perItem) {
      perItem = new Map()
      agentDeltaBufferRef.current.set(key, perItem)
    }
    perItem.set(itemId, `${perItem.get(itemId) ?? ''}${delta}`)
    if (agentDeltaTimerRef.current === null) {
      agentDeltaTimerRef.current = window.setTimeout(flushAgentDeltas, 32)
    }
  }

  function handleAgentNotification(session: AgentSession, notification: ServerNotification): void {
    if (notification.method !== 'item/agentMessage/delta' && agentDeltaBufferRef.current.size > 0) {
      flushAgentDeltas()
    }

    switch (notification.method) {
      case 'turn/started':
        patchAgentSession(session.key, (current) => ({
          ...current,
          status: 'working',
          turnId: notification.params.turn.id
        }))
        return
      case 'turn/completed': {
        const turn = notification.params.turn
        patchAgentSession(session.key, (current) => ({
          ...current,
          status: 'done',
          turnId: null,
          isCompacting: false
        }))
        void window.api.notifications.backgroundTurn({
          threadId: notification.params.threadId,
          title: session.title || 'Background agent',
          status: turn.status === 'failed' ? 'failed' : 'completed',
          message: turn.error?.message ?? null
        })
        if (turn.error?.message) {
          appendAgentMessageOnce(session.key, {
            id: `error-${turn.id}`,
            role: 'assistant',
            text: `⚠ ${turn.error.message}`
          })
        }
        if (turn.status === 'failed') recovery.schedule(session.key, turn.id, turn.error)
        else recovery.cancel(session.key)
        return
      }
      case 'item/agentMessage/delta':
        enqueueAgentDelta(session.key, notification.params.itemId, notification.params.delta)
        return
      case 'item/completed': {
        const item = notification.params.item
        if (item.type === 'contextCompaction') {
          patchAgentSession(session.key, (current) => ({ ...current, isCompacting: false }))
        } else if (item.type === 'agentMessage') {
          updateAgentSessions((sessions) => completeAgentMessage(sessions, session.key, item.id, item.text))
        }
        return
      }
      case 'item/started':
        if (notification.params.item.type === 'contextCompaction') {
          patchAgentSession(session.key, (current) => ({ ...current, isCompacting: true }))
        }
        return
      case 'thread/tokenUsage/updated':
        patchAgentSession(session.key, (current) => ({
          ...current,
          contextUsage: notification.params.tokenUsage
        }))
        return
      case 'error': {
        const { turnId, error, willRetry } = notification.params
        if (willRetry) return
        appendAgentMessageOnce(session.key, {
          id: `error-${turnId}`,
          role: 'assistant',
          text: `⚠ ${error.message}`
        })
        patchAgentSession(session.key, (current) =>
          current.turnId === turnId ? { ...current, status: 'done', turnId: null } : current
        )
        recovery.schedule(session.key, turnId, error)
        return
      }
      default:
        return
    }
  }

  function handleNewAgent(): void {
    const key = crypto.randomUUID()
    updateAgentSessions((sessions) => [
      ...sessions,
      createAgentSession(key, `Agent ${agentCounterRef.current++}`)
    ])
    setConversationLayout((current) => assignTarget(current, focusedLeafIdRef.current, key))
  }

  function handleToggleWatchAgent(key: string): void {
    patchAgentSession(key, (session) => ({ ...session, watchesMain: !session.watchesMain }))
  }

  function handleSetAgentModel(key: string, model: string, effort?: ReasoningEffort): void {
    patchAgentSession(key, (session) => ({
      ...session,
      model,
      ...(effort ? { reasoningEffort: effort } : {})
    }))
  }

  useEffect(() => () => {
    if (agentDeltaTimerRef.current !== null) window.clearTimeout(agentDeltaTimerRef.current)
  }, [])

  useEffect(() => {
    if (!agentDockRestoredRef.current) return
    window.localStorage.setItem(storageKey, serializeAgentDock(
      agentCounterRef.current,
      agentSessions,
      selectedAgentKey,
      serializeLayoutNode(conversationLayout),
      focusedLeafId
    ))
  }, [agentSessions, selectedAgentKey, conversationLayout, focusedLeafId, storageKey])

  return {
    agentSessions,
    selectedAgentKey,
    setSelectedAgentKey,
    conversationLayout,
    setConversationLayout,
    focusedLeafId,
    setFocusedLeafId,
    focusedTarget,
    visibleTargets,
    handleSelectConversation,
    handleRemoveConversationTarget,
    restoreConversationLayout,
    agentSessionsRef,
    agentStartQueueRef,
    agentCounterRef,
    agentDockRestoredRef,
    updateAgentSessions,
    patchAgentSession,
    appendAgentMessage,
    appendAgentMessageOnce,
    backgroundSessionForThread,
    handleAgentNotification,
    handleNewAgent,
    handleToggleWatchAgent,
    handleSetAgentModel
  }
}

export function parseStoredConversationLayout(raw: unknown): LayoutNode | null {
  return parseLayoutNode(raw)
}
