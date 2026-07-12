import type { ChatAttachment } from '../../shared/ipc'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort'
import type { AgentProvider } from '../../shared/agent'
import { asClaudeEffort } from './claude-items.js'
import type { AgentLiteMessage, AgentSession } from './agent-session-model.js'

type MutableRef<T> = { current: T }

type AgentCommandStore = {
  sessionsRef: MutableRef<AgentSession[]>
  startQueueRef: MutableRef<string[]>
  patchSession: (key: string, update: (session: AgentSession) => AgentSession) => void
  appendMessage: (key: string, message: AgentLiteMessage) => void
}

export function createAgentCommands(options: {
  store: AgentCommandStore
  getWorkspace: () => string | null
  // Fallback model when the session has no explicit pick — the main selection
  // for the main provider, that provider's catalog default otherwise.
  getDefaultModel: (provider: AgentProvider) => string | null
  getSelectedEffort: () => ReasoningEffort | null
  acceptsImages: (model: string | null) => boolean
  buildMainChatContext: () => string
  cancelRecovery: (key: string) => void
}): {
  bindAgentThread: (key: string, threadId: string) => void
  handleAgentSend: (key: string, text: string, attachments?: ChatAttachment[]) => Promise<boolean>
  handleAgentStop: (key: string) => Promise<void>
  handleAgentCompact: (key: string) => Promise<void>
  handleAgentSteer: (key: string, text: string) => Promise<boolean>
} {
  const { store } = options

  function bindAgentThread(key: string, threadId: string): void {
    store.patchSession(key, (session) => ({
      ...session,
      threadId: session.threadId ?? threadId
    }))
  }

  async function handleAgentSend(
    key: string,
    text: string,
    attachments: ChatAttachment[] = []
  ): Promise<boolean> {
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    if (!session) return false
    options.cancelRecovery(key)

    try {
      const agentModel = session.model ?? options.getDefaultModel(session.provider)
      if (attachments.some((attachment) => attachment.kind === 'image') && !options.acceptsImages(agentModel)) {
        store.appendMessage(key, {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: '⚠ The selected model does not accept image inputs. Choose an image-capable model or remove the image.'
        })
        return false
      }

      const outgoing = (): string =>
        session.watchesMain ? `${options.buildMainChatContext()}\n\n${text}` : text

      if (session.provider === 'claude') {
        // Claude has no separate startThread: the first sendMessage creates the
        // session and returns its id. Queue the key so a session.started event
        // that beats the IPC response still binds to this tab.
        const needsThread = !session.threadId
        if (needsThread) store.startQueueRef.current.push(key)
        store.appendMessage(key, { id: crypto.randomUUID(), role: 'user', text, attachments })
        try {
          const response = await window.api.claude.sendMessage({
            threadId: session.threadId,
            text: outgoing(),
            attachments,
            cwd: options.getWorkspace(),
            model: agentModel,
            effort: asClaudeEffort(session.reasoningEffort ?? options.getSelectedEffort()),
            collaborationMode: 'default'
          })
          bindAgentThread(key, response.threadId)
          store.patchSession(key, (current) => ({
            ...current,
            status: 'working',
            turnId: response.turnId
          }))
        } finally {
          if (needsThread) {
            store.startQueueRef.current = store.startQueueRef.current.filter((queued) => queued !== key)
          }
        }
        return true
      }

      let threadId = session.threadId
      if (!threadId) {
        store.startQueueRef.current.push(key)
        const started = await window.api.codex.startThread({
          cwd: options.getWorkspace(),
          model: agentModel
        })
        threadId = started.thread.id
        store.startQueueRef.current = store.startQueueRef.current.filter((queued) => queued !== key)
        if (!threadId) throw new Error('Thread start returned no thread id')
        bindAgentThread(key, threadId)
      }

      store.appendMessage(key, { id: crypto.randomUUID(), role: 'user', text, attachments })
      const response = await window.api.codex.sendMessage({
        threadId,
        text: outgoing(),
        attachments,
        cwd: options.getWorkspace(),
        model: agentModel,
        effort: session.reasoningEffort ?? options.getSelectedEffort()
      })
      store.patchSession(key, (current) => ({
        ...current,
        status: 'working',
        turnId: response.turn.id
      }))
      return true
    } catch (error) {
      store.appendMessage(key, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `⚠ Agent turn failed to start: ${(error as Error).message}`
      })
      return false
    }
  }

  async function handleAgentStop(key: string): Promise<void> {
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    if (!session?.threadId || !session.turnId) return
    try {
      const params = { threadId: session.threadId, turnId: session.turnId }
      if (session.provider === 'claude') await window.api.claude.interruptTurn(params)
      else await window.api.codex.interruptTurn(params)
    } catch {
      // The turn may have already finished; notifications settle the state.
    }
  }

  async function handleAgentCompact(key: string): Promise<void> {
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    if (!session?.threadId || session.turnId || session.isCompacting) return
    if (session.provider === 'claude') {
      store.appendMessage(key, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: 'Claude manages context compaction automatically in this integration.'
      })
      return
    }
    try {
      await window.api.codex.compactThread(session.threadId)
    } catch (error) {
      store.appendMessage(key, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `⚠ Compaction failed: ${(error as Error).message}`
      })
    }
  }

  async function handleAgentSteer(key: string, text: string): Promise<boolean> {
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    const trimmed = text.trim()
    if (!trimmed || !session?.threadId || !session.turnId) return false
    try {
      const params = {
        threadId: session.threadId,
        turnId: session.turnId,
        text: trimmed
      }
      if (session.provider === 'claude') await window.api.claude.steerTurn(params)
      else await window.api.codex.steerTurn(params)
      store.appendMessage(key, { id: crypto.randomUUID(), role: 'user', text: trimmed })
      return true
    } catch (error) {
      store.appendMessage(key, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `⚠ Could not add guidance to the running turn: ${(error as Error).message}`
      })
      return false
    }
  }

  return { bindAgentThread, handleAgentSend, handleAgentStop, handleAgentCompact, handleAgentSteer }
}
