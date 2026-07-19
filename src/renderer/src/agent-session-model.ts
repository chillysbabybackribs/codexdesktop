import type { ThreadTokenUsage } from '../../shared/session-protocol'
import type { ReasoningEffort } from '../../shared/session-protocol'
import type { ChatAttachment } from '../../shared/ipc'
import type { AuditRequestSummary } from './audit-trigger'

export type AgentLiteMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments?: ChatAttachment[]
  // Present only on the auto-audit request message. When set, the card renders
  // a compact collapsible "Auditing turn" card instead of the raw prompt text.
  audit?: AuditRequestSummary
}

export type AgentSession = {
  key: string
  // Main-chat tab that created and owns this agent window. Agent sessions are
  // long-lived, but their mini-window is intentionally scoped to this tab.
  mainChatTabKey: string | null
  threadId: string | null
  title: string
  status: 'idle' | 'working' | 'done'
  turnId: string | null
  messages: AgentLiteMessage[]
  watchesMain: boolean
  auditsMain: boolean
  // Flagged audit reports auto-send into the main chat for the doer to act
  // on (verdict-gated, one bounce per user turn). Implies auditsMain.
  reportsToMain: boolean
  // Transient: why the last completed main-chat turn did not trigger an audit
  // (no changes detected / detection unavailable). Shown in the standby view
  // so an armed auditor never silently looks hung. Not persisted.
  lastAuditNote: string | null
  model: string | null
  reasoningEffort: ReasoningEffort | null
  contextUsage: ThreadTokenUsage | null
  isCompacting: boolean
}

export type PersistedAgentSession = {
  mainChatTabKey?: string | null
  threadId?: string | null
  title?: string
  watchesMain?: boolean
  auditsMain?: boolean
  reportsToMain?: boolean
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

export function createAgentSession(key: string, title: string, mainChatTabKey: string | null = null): AgentSession {
  return {
    key,
    mainChatTabKey,
    threadId: null,
    title,
    status: 'idle',
    turnId: null,
    messages: [],
    watchesMain: false,
    auditsMain: false,
    reportsToMain: false,
    lastAuditNote: null,
    model: null,
    reasoningEffort: null,
    contextUsage: null,
    isCompacting: false
  }
}

// Adjacent identical assistant messages are stream-restate artifacts (the
// Claude translator dedupes new turns at the source; this also cleans threads
// persisted before that fix). A model genuinely repeating itself verbatim
// back-to-back carries no information worth double-rendering.
export function collapseAdjacentAssistantDuplicates(messages: AgentLiteMessage[]): AgentLiteMessage[] {
  return messages.filter((message, index) => {
    if (message.role !== 'assistant') return true
    const previous = messages[index - 1]
    return !(previous?.role === 'assistant' && previous.text === message.text)
  })
}

export function resetAgentSession(session: AgentSession): AgentSession {
  return {
    ...session,
    threadId: null,
    status: 'idle',
    turnId: null,
    messages: [],
    lastAuditNote: null,
    contextUsage: null,
    isCompacting: false
  }
}

export function findAgentSessionByThread(sessions: AgentSession[], threadId: string): AgentSession | null {
  return sessions.find((session) => session.threadId === threadId) ?? null
}

export function agentSessionsForMainChatTab(
  sessions: AgentSession[],
  mainChatTabKey: string,
): AgentSession[] {
  return sessions.filter((session) => session.mainChatTabKey === mainChatTabKey)
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
      mainChatTabKey: session.mainChatTabKey,
      threadId: session.threadId,
      title: session.title,
      watchesMain: session.watchesMain,
      auditsMain: session.auditsMain,
      reportsToMain: session.reportsToMain,
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
