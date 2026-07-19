import { attachmentsFromUserInput } from './Attachments.js'
import { collapseAdjacentAssistantDuplicates, parseAgentDock, stripMainChatContext, type AgentLiteMessage, type AgentSession } from './agent-session-model.js'
import { isAuditPrompt, parseAuditPrompt } from './audit-trigger.js'
import type { ChatItem } from './transcript-model.js'
import { emptySessionState, type SessionRenderState } from './session-store.js'

type MutableRef<T> = { current: T }

type AgentDockStore = {
  counterRef: MutableRef<number>
  restoredRef: MutableRef<boolean>
  updateSessions: (update: (sessions: AgentSession[]) => AgentSession[]) => void
  setOpenKeys: (update: (keys: string[]) => string[]) => void
  setSelectedKey: (update: (key: string | null) => string | null) => void
  patchSession: (key: string, update: (session: AgentSession) => AgentSession) => void
  appendMessage: (key: string, message: AgentLiteMessage) => void
  setRenderState: (key: string, state: SessionRenderState) => void
}

export function liteMessagesFromItems(source: ChatItem[]): AgentLiteMessage[] {
  const messages: AgentLiteMessage[] = []
  for (const item of source) {
    if (item.type === 'userMessage') {
      const text = item.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text)
        .join('\n')
      const attachments = attachmentsFromUserInput(item.content)
      if (isAuditPrompt(text)) {
        messages.push({ id: item.id, role: 'user', text, attachments, audit: parseAuditPrompt(text) })
      } else if (text || attachments.length) {
        messages.push({ id: item.id, role: 'user', text: stripMainChatContext(text), attachments })
      }
    } else if (item.type === 'agentMessage' && item.text) {
      messages.push({ id: item.id, role: 'assistant', text: item.text })
    }
  }
  return collapseAdjacentAssistantDuplicates(messages)
}

export async function restoreAgentDock(options: {
  storageKey: string
  mainThreadIds: ReadonlySet<string>
  mainChatTabKeys: ReadonlySet<string>
  activeMainChatTabKey: string
  store: AgentDockStore
}): Promise<void> {
  const { storageKey, mainThreadIds, mainChatTabKeys, activeMainChatTabKey, store } = options
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return
    const parsed = parseAgentDock(raw)
    if (!parsed) return
    if (typeof parsed.counter === 'number' && parsed.counter > store.counterRef.current) {
      store.counterRef.current = parsed.counter
    }
    const entries = parsed.sessions.filter(
      (entry) =>
        (!entry.threadId || !mainThreadIds.has(entry.threadId)) &&
        (!entry.mainChatTabKey || mainChatTabKeys.has(entry.mainChatTabKey))
    )
    if (!entries.length) return

    const restored: AgentSession[] = entries.map((entry) => ({
      key: crypto.randomUUID(),
      // Pre-ownership dock records are legacy global agents. Keep them
      // reachable in the chat that was active during restore; newer records
      // retain their exact owning tab.
      mainChatTabKey: typeof entry.mainChatTabKey === 'string' && entry.mainChatTabKey
        ? entry.mainChatTabKey
        : activeMainChatTabKey,
      workspace: typeof entry.workspace === 'string' && entry.workspace ? entry.workspace : null,
      // Phase 1 does not persist the spawn tree, so a restored session is
      // always a top-level agent (reviewer or a promoted lead), never a
      // spawned worker — the parent link and spawning turn are intentionally
      // dropped on reload.
      role: 'reviewer',
      parentAgentKey: null,
      spawnedByTurnId: null,
      threadId: typeof entry.threadId === 'string' && entry.threadId ? entry.threadId : null,
      title: entry.title || `Agent ${store.counterRef.current++}`,
      status: 'idle',
      turnId: null,
      messages: [],
      // Radio model: Reviewer and Helper are exclusive — audit wins when a
      // legacy snapshot carried both flags.
      watchesMain: Boolean(entry.watchesMain) && !entry.auditsMain,
      auditsMain: Boolean(entry.auditsMain),
      reportsToMain: Boolean(entry.reportsToMain),
      // Legacy records predate the first-flag prompt: auto-send on was an
      // explicit decision; off means the prompt never existed, so ask once.
      sendPolicyDecided: Boolean(entry.sendPolicyDecided ?? entry.reportsToMain),
      lastAuditNote: null,
      model: entry.model ?? null,
      reasoningEffort: entry.reasoningEffort ?? null,
      contextUsage: null,
      isCompacting: false
    }))

    // Register before resuming so incoming events route to the dock.
    store.updateSessions((current) => [...current, ...restored])
    for (const session of restored) {
      store.setRenderState(session.key, emptySessionState({
        threadId: session.threadId,
        title: session.title,
        reasoningEffort: session.reasoningEffort
      }))
    }
    const anyOpenFlag = entries.some((entry) => entry.open)
    const openKeys = anyOpenFlag
      ? restored.filter((_, index) => entries[index].open).map((session) => session.key)
      : restored.map((session) => session.key)
    if (openKeys.length) store.setOpenKeys((current) => [...current, ...openKeys])
    const selectedIndex = entries.findIndex((entry) => entry.selected)
    if (selectedIndex >= 0) store.setSelectedKey(() => restored[selectedIndex].key)

    await Promise.all(restored.map(async (session) => {
      if (!session.threadId) return
      try {
        const resumed = await window.api.session.resumeThread({ threadId: session.threadId, history: 'agent' })
        const turns: Array<{ id: string; items: ChatItem[] }> = resumed.thread.turns.length > 0
          ? resumed.thread.turns
          // The shared resume request asks for newest-first to keep startup
          // payloads small. Rebuild the compact agent transcript in reading
          // order before taking its recent tail.
          : [...(resumed.initialTurnsPage?.data ?? [])].reverse()

        const items = turns.flatMap((turn) => turn.items)
        const itemMeta = Object.fromEntries(
          turns.flatMap((turn) => turn.items.map((item) => [item.id, { turnId: turn.id }]))
        )
        store.setRenderState(session.key, emptySessionState({
          threadId: session.threadId,
          title: session.title,
          items,
          itemMeta,
          reasoningEffort: resumed.reasoningEffort ?? session.reasoningEffort
        }))
        store.patchSession(session.key, (current) => ({
          ...current,
          reasoningEffort: resumed.reasoningEffort ?? current.reasoningEffort
        }))
      } catch (error) {
        console.warn('Agent thread rehydration failed', session.threadId, error)
        store.appendMessage(session.key, {
          id: `restore-${session.key}`,
          role: 'assistant',
          text: '⚠ Could not restore this conversation’s history. Sending a message will retry the thread; close this agent if it no longer exists.'
        })
      }
    }))
  } catch (error) {
    console.warn('Agent dock restore failed', error)
  } finally {
    store.restoredRef.current = true
  }
}
