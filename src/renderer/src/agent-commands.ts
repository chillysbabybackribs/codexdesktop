import type { ChatAttachment } from '../../shared/ipc'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort'
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
  getSelectedModel: () => string | null
  getSelectedEffort: () => ReasoningEffort | null
  getFastMode: () => boolean
  acceptsImages: (model: string | null) => boolean
  buildMainChatContext: () => string
  cancelRecovery: (key: string) => void
  queueThreadStart: (key: string) => void
  settleThreadStart: (key: string) => void
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
      const agentModel = session.model ?? options.getSelectedModel()
      if (attachments.some((attachment) => attachment.kind === 'image') && !options.acceptsImages(agentModel)) {
        store.appendMessage(key, {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: '⚠ The selected model does not accept image inputs. Choose an image-capable model or remove the image.'
        })
        return false
      }

      const threadId = session.threadId
      const startsNewThread = !threadId
      if (startsNewThread) {
        store.startQueueRef.current.push(key)
        options.queueThreadStart(key)
      }

      store.appendMessage(key, { id: crypto.randomUUID(), role: 'user', text, attachments })
      const outgoingText = session.watchesMain ? `${options.buildMainChatContext()}\n\n${text}` : text
      const response = await window.api.codex.sendMessage({
        threadId,
        text: outgoingText,
        attachments,
        cwd: options.getWorkspace(),
        model: agentModel,
        effort: session.reasoningEffort ?? options.getSelectedEffort(),
        fastMode: options.getFastMode()
      })
      if (startsNewThread) bindAgentThread(key, response.threadId)
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
    } finally {
      store.startQueueRef.current = store.startQueueRef.current.filter((queued) => queued !== key)
      options.settleThreadStart(key)
    }
  }

  async function handleAgentStop(key: string): Promise<void> {
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    if (!session?.threadId || !session.turnId) return
    try {
      await window.api.codex.interruptTurn({ threadId: session.threadId, turnId: session.turnId })
    } catch {
      // The turn may have already finished; notifications settle the state.
    }
  }

  async function handleAgentCompact(key: string): Promise<void> {
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    if (!session?.threadId || session.turnId || session.isCompacting) return
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
      await window.api.codex.steerTurn({
        threadId: session.threadId,
        turnId: session.turnId,
        text: trimmed
      })
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
