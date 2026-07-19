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

// The spawn tree role. 'reviewer' is the born-a-reviewer dock agent (audit
// pairing); 'lead' and 'worker' form the subagent spawn tree — a lead's
// spawn_subagent tool call creates a 'worker'. Kept to three values on
// purpose: the tree stays shallow (a worker is never itself shown as
// spawnable in the roster).
export type AgentRole = 'lead' | 'worker' | 'reviewer'

export type AgentSession = {
  key: string
  // Main-chat tab that created and owns this agent window. Agent sessions are
  // long-lived, but their mini-window is intentionally scoped to this tab.
  mainChatTabKey: string | null
  // Spawn-tree linkage. `parentAgentKey` keys on the app `key` (not threadId)
  // because a child's threadId is null until its first turn starts, so the
  // parent link must survive the pre-thread window. null = top-level (a lead
  // or a standalone reviewer). `spawnedByTurnId` is the parent turnId whose
  // tool call created this worker — it groups workers under the spawning turn.
  role: AgentRole
  parentAgentKey: string | null
  spawnedByTurnId: string | null
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
    role: 'reviewer',
    parentAgentKey: null,
    spawnedByTurnId: null,
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

// A worker spawned by a lead's spawn_subagent tool call. It inherits the
// spawning session's owning tab so the roster groups it under the right main
// chat, links to its parent by key, and records the turn that created it. It
// is never an auditor (workers do the work; the reviewer pairing is separate).
// The threadId is bound once the orchestrator starts its turn.
export function createWorkerSession(
  key: string,
  title: string,
  mainChatTabKey: string | null,
  parentAgentKey: string,
  spawnedByTurnId: string | null,
  model: string | null
): AgentSession {
  return {
    ...createAgentSession(key, title, mainChatTabKey),
    role: 'worker',
    parentAgentKey,
    spawnedByTurnId,
    model
  }
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

// The card's user-facing role. `role` stays the spawn-tree truth and the
// behavior flags stay the mechanism; this is the one derived value the menu
// radio shows and the one intent a role choice expresses. 'worker' is
// read-only — spawned children keep their role; the radio offers the other
// two.
export type DockRole = 'worker' | 'reviewer' | 'helper'

// Derive the radio's selected value from session state. A top-level agent
// with neither flag (legacy restore) reads as 'reviewer' — the born-a-reviewer
// default; re-picking Reviewer arms the flags via dockRoleFlags, so stale
// snapshots heal on first touch.
export function dockRoleOf(session: AgentSession): DockRole {
  if (session.role === 'worker') return 'worker'
  if (session.watchesMain && !session.auditsMain) return 'helper'
  return 'reviewer'
}

// The flag patch a role choice implies. Reviewer and Helper are mutually
// exclusive behaviors (audit briefings vs context-prepended manual sends), so
// each arms its flag and clears the other.
export function dockRoleFlags(role: 'reviewer' | 'helper'): Pick<AgentSession, 'auditsMain' | 'watchesMain'> {
  return role === 'reviewer'
    ? { auditsMain: true, watchesMain: false }
    : { auditsMain: false, watchesMain: true }
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

// The roster is the master-detail "map": a shallow tree of agents grouped by
// their spawning session. A node's `rollup` folds the whole subtree's status
// into one glyph so a collapsed lead still signals "a child is working" or
// "a child errored".
export type AgentRosterNode = {
  session: AgentSession
  children: AgentRosterNode[]
  rollup: RosterRollupStatus
}

export type RosterRollupStatus = 'idle' | 'working' | 'done' | 'attention'

// Fold a subtree's statuses into one. 'attention' (a descendant that ended in
// an error state we surface as a stuck/idle child after failure) wins over
// everything so problems never hide under a collapsed parent; then 'working'
// (self or any descendant still running); then 'done' if anything completed;
// else 'idle'. `attentionKeys` marks sessions currently flagged for attention
// (e.g. a failed turn awaiting recovery) — the caller owns that signal, so the
// fold takes it as input rather than inventing a new session field.
export function rollupStatus(
  node: AgentRosterNode,
  attentionKeys?: ReadonlySet<string>,
): RosterRollupStatus {
  let working = false
  let done = false
  let attention = false
  const visit = (current: AgentRosterNode): void => {
    if (attentionKeys?.has(current.session.key)) attention = true
    if (current.session.status === 'working') working = true
    else if (current.session.status === 'done') done = true
    for (const child of current.children) visit(child)
  }
  visit(node)
  if (attention) return 'attention'
  if (working) return 'working'
  if (done) return 'done'
  return 'idle'
}

// Build the shallow spawn tree for one owning tab. Children link to parents by
// `parentAgentKey`; a child whose parent is absent (parent closed, or the link
// points outside this tab) is promoted to top-level so it never vanishes from
// the roster. Order is preserved from the input session order at each level.
export function buildAgentRoster(
  sessions: AgentSession[],
  attentionKeys?: ReadonlySet<string>,
): AgentRosterNode[] {
  const byKey = new Map(sessions.map((session) => [session.key, session]))
  const childrenOf = new Map<string, AgentSession[]>()
  const roots: AgentSession[] = []
  for (const session of sessions) {
    const parentKey = session.parentAgentKey
    if (parentKey && byKey.has(parentKey)) {
      const bucket = childrenOf.get(parentKey)
      if (bucket) bucket.push(session)
      else childrenOf.set(parentKey, [session])
    } else {
      roots.push(session)
    }
  }
  const build = (session: AgentSession): AgentRosterNode => {
    const children = (childrenOf.get(session.key) ?? []).map(build)
    const node: AgentRosterNode = { session, children, rollup: 'idle' }
    node.rollup = rollupStatus(node, attentionKeys)
    return node
  }
  return roots.map(build)
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
