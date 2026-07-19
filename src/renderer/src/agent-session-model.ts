import type { ThreadTokenUsage } from '../../shared/session-protocol'
import type { ReasoningEffort } from '../../shared/session-protocol'
import type { Model } from '../../shared/session-protocol'
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
  // Whether the user has settled the send-to-main policy. False until the
  // first flagged report asks (Send / Always send / Keep here) or the user
  // toggles auto-send explicitly — the decision happens at the moment of
  // first value, with a real finding on screen, not as an abstract pre-toggle.
  sendPolicyDecided: boolean
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
  sendPolicyDecided?: boolean
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
    sendPolicyDecided: false,
    lastAuditNote: null,
    model: null,
    reasoningEffort: null,
    contextUsage: null,
    isCompacting: false
  }
}

// Born-a-reviewer: the dock's default birth. Audit mode armed from the first
// paint (the standby card is the empty state, zero configuration), model
// pre-derived cross-family, send policy deliberately undecided — the first
// flagged report asks.
export function createReviewerSession(
  key: string,
  title: string,
  mainChatTabKey: string | null,
  model: string | null
): AgentSession {
  return { ...createAgentSession(key, title, mainChatTabKey), auditsMain: true, model }
}

// "Reviewer", then "Reviewer 2"… per owning tab — identity over enumeration
// (the old "Agent 79" told the user nothing about what the window does).
export function reviewerTitle(sessions: AgentSession[], mainChatTabKey: string | null): string {
  const peers = sessions.filter(
    (session) =>
      session.mainChatTabKey === mainChatTabKey && /^Reviewer( \d+)?$/.test(session.title)
  ).length
  return peers === 0 ? 'Reviewer' : `Reviewer ${peers + 1}`
}

// The reviewer's model default: cross-family by construction, never a lock.
// Picks a visible model from a different provider than the main chat's
// current model, so the doer is reviewed by uncorrelated weights whichever
// direction the pairing runs. Returns null when no other family is
// configured — a null agent model follows the main chat's model, which is
// the correct single-provider default. Callers only apply this when the
// session has no explicit model; a user's choice is never overridden.
export function defaultReviewerModel(mainModel: string | null, models: Model[]): string | null {
  const mainEntry = mainModel ? models.find((model) => model.id === mainModel) : undefined
  // A null main model means the CLI-configured default — the codex runtime.
  const mainProvider = mainEntry?.providerId ?? 'codex'
  const candidates = models.filter(
    (model) => !model.hidden && (model.providerId ?? 'codex') !== mainProvider
  )
  if (!candidates.length) return null
  return (
    // Account-default entries first ('claude-default' resolves to whatever the
    // user's Claude account prefers), then the catalog default, then anything.
    candidates.find((model) => model.id === 'claude-default') ??
    candidates.find((model) => model.isDefault) ??
    candidates[0]
  ).id
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

// The most recent audit exchange's report: the FINAL assistant message after
// the last audit briefing. Interim narration ("let me diff the commits…")
// stays out — the audit prompt demands a self-contained concise close, and
// joining interims duplicated content in the forwarded feedback. null when
// the latest exchange is not an audit (manual chats never count as one).
export function latestAuditReport(messages: AgentLiteMessage[]): string | null {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex === -1 || !messages[lastUserIndex].audit) return null
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.text.trim()) return message.text.trim()
  }
  return null
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
      sendPolicyDecided: session.sendPolicyDecided,
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
