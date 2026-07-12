import type { UserInput } from '../../shared/codex-protocol/v2/UserInput'
import { attachmentsFromUserInput } from './Attachments.js'
import { parseAgentDock, stripMainChatContext, type AgentLiteMessage, type AgentSession } from './agent-session-model.js'
import type { ChatItem } from './transcript-model.js'

type MutableRef<T> = { current: T }

type AgentDockStore = {
  counterRef: MutableRef<number>
  restoredRef: MutableRef<boolean>
  updateSessions: (update: (sessions: AgentSession[]) => AgentSession[]) => void
  setSelectedKey: (update: (key: string | null) => string | null) => void
  restoreLayout: (layout: unknown, focusedLeafId: string | null, fallbackTarget: 'main' | string) => void
  patchSession: (key: string, update: (session: AgentSession) => AgentSession) => void
  appendMessage: (key: string, message: AgentLiteMessage) => void
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
      if (text || attachments.length) messages.push({ id: item.id, role: 'user', text, attachments })
    } else if (item.type === 'agentMessage' && item.text) {
      messages.push({ id: item.id, role: 'assistant', text: item.text })
    }
  }
  return messages
}

export async function restoreAgentDock(options: {
  storageKey: string
  activeThreadId: string | null
  workspace: string | null
  store: AgentDockStore
}): Promise<void> {
  const { storageKey, activeThreadId, store } = options
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return
    const parsed = parseAgentDock(raw)
    if (!parsed) return
    if (typeof parsed.counter === 'number' && parsed.counter > store.counterRef.current) {
      store.counterRef.current = parsed.counter
    }
    const entries = parsed.sessions.filter((entry) => !entry.threadId || entry.threadId !== activeThreadId)
    if (!entries.length) return

    const restored: AgentSession[] = entries.map((entry) => ({
      key: crypto.randomUUID(),
      provider: entry.provider === 'claude' ? 'claude' : 'codex',
      threadId: typeof entry.threadId === 'string' && entry.threadId ? entry.threadId : null,
      title: entry.title || `Agent ${store.counterRef.current++}`,
      status: 'idle',
      turnId: null,
      messages: [],
      watchesMain: Boolean(entry.watchesMain),
      model: entry.model ?? null,
      reasoningEffort: entry.reasoningEffort ?? null,
      contextUsage: null,
      isCompacting: false
    }))

    // Register before resuming so incoming events route to the dock.
    store.updateSessions((current) => [...current, ...restored])
    const selectedIndex = entries.findIndex((entry) => entry.selected)
    const fallbackTarget = selectedIndex >= 0 ? restored[selectedIndex].key : 'main'
    if (selectedIndex >= 0) store.setSelectedKey(() => restored[selectedIndex].key)
    store.restoreLayout(parsed.layout ?? null, parsed.focusedLeafId ?? null, fallbackTarget)

    await Promise.all(restored.map(async (session) => {
      if (!session.threadId) return
      try {
        if (session.provider === 'claude') {
          // Registers the runtime so later sends resume this session; the
          // transcript comes from the session file rather than a turns page.
          await window.api.claude.resumeThread(session.threadId, options.workspace)
          const transcript = await window.api.claude.readThread(session.threadId, options.workspace)
          const messages: AgentLiteMessage[] = transcript.map((message) => ({
            id: message.id,
            role: message.role,
            text: message.role === 'user' ? stripMainChatContext(message.text) : message.text
          }))
          store.patchSession(session.key, (current) => ({
            ...current,
            messages: messages.slice(-4)
          }))
          return
        }

        const resumed = await window.api.codex.resumeThread(session.threadId)
        let turns = resumed.thread.turns.length > 0
          ? resumed.thread.turns
          // The shared resume request asks for newest-first to keep startup
          // payloads small. Rebuild the compact agent transcript in reading
          // order before taking its recent tail.
          : [...(resumed.initialTurnsPage?.data ?? [])].reverse()

        const messages: AgentLiteMessage[] = []
        for (const turn of turns) {
          for (const item of turn.items) {
            if (item.type === 'userMessage') {
              const text = item.content
                .flatMap((content: UserInput) => content.type === 'text' ? [content.text] : [])
                .join('\n')
              const attachments = attachmentsFromUserInput(item.content)
              if (text || attachments.length) {
                messages.push({ id: item.id, role: 'user', text: stripMainChatContext(text), attachments })
              }
            } else if (item.type === 'agentMessage' && item.text) {
              messages.push({ id: item.id, role: 'assistant', text: item.text })
            }
          }
        }
        store.patchSession(session.key, (current) => ({
          ...current,
          messages: messages.slice(-4),
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
