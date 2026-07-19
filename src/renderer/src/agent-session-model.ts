import type { ThreadTokenUsage } from '../../shared/session-protocol'
import type { ReasoningEffort } from '../../shared/session-protocol'
import type { ChatAttachment } from '../../shared/ipc'

export type AgentLiteMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments?: ChatAttachment[]
}

export type AgentSession = {
  key: string
  threadId: string | null
  title: string
  status: 'idle' | 'working' | 'done'
  turnId: string | null
  messages: AgentLiteMessage[]
  watchesMain: boolean
  model: string | null
  reasoningEffort: ReasoningEffort | null
  contextUsage: ThreadTokenUsage | null
  isCompacting: boolean
}

export type PersistedAgentSession = {
  threadId?: string | null
  title?: string
  watchesMain?: boolean
  model?: string | null
  reasoningEffort?: ReasoningEffort | null
  open?: boolean
  selected?: boolean
}

export type PersistedAgentDock = {
  counter?: number
  sessions: PersistedAgentSession[]
}

export type AgentDeltaBuffer = ReadonlyMap<string, ReadonlyMap<string, string>>

export function createAgentSession(key: string, title: string): AgentSession {
  return {
    key,
    threadId: null,
    title,
    status: 'idle',
    turnId: null,
    messages: [],
    watchesMain: false,
    model: null,
    reasoningEffort: null,
    contextUsage: null,
    isCompacting: false
  }
}

export function resetAgentSession(session: AgentSession): AgentSession {
  return {
    ...session,
    threadId: null,
    status: 'idle',
    turnId: null,
    messages: [],
    contextUsage: null,
    isCompacting: false
  }
}

export function findAgentSessionByThread(sessions: AgentSession[], threadId: string): AgentSession | null {
  return sessions.find((session) => session.threadId === threadId) ?? null
}

export function updateAgentSession(
  sessions: AgentSession[],
  key: string,
  update: (session: AgentSession) => AgentSession
): AgentSession[] {
  return sessions.map((session) => session.key === key ? update(session) : session)
}

export function appendAgentSessionMessage(
  sessions: AgentSession[],
  key: string,
  message: AgentLiteMessage,
  dedupe = false
): AgentSession[] {
  return updateAgentSession(sessions, key, (session) => {
    if (dedupe && session.messages.some((existing) => existing.id === message.id)) return session
    return { ...session, messages: [...session.messages, message] }
  })
}

export function applyAgentDeltas(sessions: AgentSession[], buffer: AgentDeltaBuffer): AgentSession[] {
  return sessions.map((session) => {
    const perItem = buffer.get(session.key)
    if (!perItem?.size) return session

    const pending = new Map(perItem)
    let changed = false
    let messages = session.messages.map((message) => {
      const delta = pending.get(message.id)
      if (delta === undefined) return message
      pending.delete(message.id)
      changed = true
      return { ...message, text: `${message.text}${delta}` }
    })

    if (pending.size) {
      changed = true
      messages = [
        ...messages,
        ...Array.from(pending, ([id, text]) => ({ id, role: 'assistant' as const, text }))
      ]
    }
    return changed ? { ...session, messages } : session
  })
}

export function completeAgentMessage(
  sessions: AgentSession[],
  key: string,
  itemId: string,
  text: string
): AgentSession[] {
  return updateAgentSession(sessions, key, (session) => {
    const existing = session.messages.some((message) => message.id === itemId)
    const messages = existing
      ? session.messages.map((message) => message.id === itemId ? { ...message, text } : message)
      : [...session.messages, { id: itemId, role: 'assistant' as const, text }]
    return { ...session, messages }
  })
}

export function serializeAgentDock(
  counter: number,
  sessions: AgentSession[],
  openKeys: string[],
  selectedKey: string | null
): string {
  return JSON.stringify({
    counter,
    sessions: sessions.map((session) => ({
      threadId: session.threadId,
      title: session.title,
      watchesMain: session.watchesMain,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      open: openKeys.includes(session.key),
      selected: session.key === selectedKey
    }))
  })
}

export function parseAgentDock(raw: string): PersistedAgentDock | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const record = value as { counter?: unknown; sessions?: unknown }
    return {
      ...(typeof record.counter === 'number' && Number.isFinite(record.counter) ? { counter: record.counter } : {}),
      sessions: Array.isArray(record.sessions)
        ? record.sessions.filter((entry): entry is PersistedAgentSession => Boolean(entry) && typeof entry === 'object')
        : []
    }
  } catch {
    return null
  }
}

export function stripMainChatContext(text: string): string {
  if (!text.startsWith('<main-chat-context>')) return text
  const end = text.indexOf('</main-chat-context>')
  return end === -1 ? text : text.slice(end + '</main-chat-context>'.length).trimStart()
}
