import { useEffect, useRef, useState } from 'react'
import {
  appendAgentSessionMessage,
  applyAgentDeltas,
  createAgentSession,
  findAgentSessionByThread,
  serializeAgentDock,
  updateAgentSession,
  type AgentLiteMessage,
  type AgentSession
} from './agent-session-model'

export function useAgentSessions(storageKey: string): {
  agentSessions: AgentSession[]
  openAgentKeys: string[]
  selectedAgentKey: string | null
  setOpenAgentKeys: React.Dispatch<React.SetStateAction<string[]>>
  setSelectedAgentKey: React.Dispatch<React.SetStateAction<string | null>>
  agentSessionsRef: React.MutableRefObject<AgentSession[]>
  agentDeltaBufferRef: React.MutableRefObject<Map<string, Map<string, string>>>
  agentStartQueueRef: React.MutableRefObject<string[]>
  agentCounterRef: React.MutableRefObject<number>
  agentDockRestoredRef: React.MutableRefObject<boolean>
  updateAgentSessions: (update: (sessions: AgentSession[]) => AgentSession[]) => void
  patchAgentSession: (key: string, update: (session: AgentSession) => AgentSession) => void
  appendAgentMessage: (key: string, message: AgentLiteMessage) => void
  appendAgentMessageOnce: (key: string, message: AgentLiteMessage) => void
  backgroundSessionForThread: (threadId: string) => AgentSession | null
  flushAgentDeltas: () => void
  enqueueAgentDelta: (key: string, itemId: string, delta: string) => void
  handleNewAgent: () => void
  handleOpenAgent: (key: string) => void
  handleMinimizeAgent: (key: string) => void
  handleToggleWatchAgent: (key: string) => void
  handleSetAgentModel: (key: string, model: string) => void
} {
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([])
  const [openAgentKeys, setOpenAgentKeys] = useState<string[]>([])
  const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(null)
  const agentSessionsRef = useRef<AgentSession[]>([])
  const agentDeltaBufferRef = useRef<Map<string, Map<string, string>>>(new Map())
  const agentDeltaTimerRef = useRef<number | null>(null)
  const agentStartQueueRef = useRef<string[]>([])
  const agentCounterRef = useRef(2)
  const agentDockRestoredRef = useRef(false)

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

  function handleNewAgent(): void {
    const key = crypto.randomUUID()
    updateAgentSessions((sessions) => [
      ...sessions,
      createAgentSession(key, `Agent ${agentCounterRef.current++}`)
    ])
    setOpenAgentKeys((current) => [...current, key])
    setSelectedAgentKey(key)
  }

  function handleOpenAgent(key: string): void {
    setOpenAgentKeys((current) => current.includes(key) ? current : [...current, key])
  }

  function handleMinimizeAgent(key: string): void {
    setOpenAgentKeys((current) => current.filter((candidate) => candidate !== key))
  }

  function handleToggleWatchAgent(key: string): void {
    patchAgentSession(key, (session) => ({ ...session, watchesMain: !session.watchesMain }))
  }

  function handleSetAgentModel(key: string, model: string): void {
    patchAgentSession(key, (session) => ({ ...session, model }))
  }

  useEffect(() => () => {
    if (agentDeltaTimerRef.current !== null) window.clearTimeout(agentDeltaTimerRef.current)
  }, [])

  useEffect(() => {
    if (!agentDockRestoredRef.current) return
    window.localStorage.setItem(storageKey, serializeAgentDock(
      agentCounterRef.current,
      agentSessions,
      openAgentKeys,
      selectedAgentKey
    ))
  }, [agentSessions, openAgentKeys, selectedAgentKey, storageKey])

  return {
    agentSessions,
    openAgentKeys,
    selectedAgentKey,
    setOpenAgentKeys,
    setSelectedAgentKey,
    agentSessionsRef,
    agentDeltaBufferRef,
    agentStartQueueRef,
    agentCounterRef,
    agentDockRestoredRef,
    updateAgentSessions,
    patchAgentSession,
    appendAgentMessage,
    appendAgentMessageOnce,
    backgroundSessionForThread,
    flushAgentDeltas,
    enqueueAgentDelta,
    handleNewAgent,
    handleOpenAgent,
    handleMinimizeAgent,
    handleToggleWatchAgent,
    handleSetAgentModel
  }
}
