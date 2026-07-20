import type { ChatAttachment } from '../../shared/ipc'
import type { ReasoningEffort } from '../../shared/session-protocol'
import type { AgentLiteMessage, AgentSession } from './agent-session-model.js'
import type { AuditRequestSummary } from './audit-trigger.js'

// Extra send options. `audit` is set only by the auto-audit trigger so the
// card can show a compact card while the model still gets the full prompt.
export type AgentSendOptions = { audit?: AuditRequestSummary }

type MutableRef<T> = { current: T }

type AgentCommandStore = {
  sessionsRef: MutableRef<AgentSession[]>
  startQueueRef: MutableRef<string[]>
  patchSession: (key: string, update: (session: AgentSession) => AgentSession) => void
  appendMessage: (key: string, message: AgentLiteMessage) => void
}

export function createAgentCommands(options: {
  store: AgentCommandStore
  getWorkspace: (session: AgentSession) => string | null
  getSelectedModel: () => string | null
  getSelectedEffort: () => ReasoningEffort | null
  getFastMode: () => boolean
  acceptsImages: (model: string | null) => boolean
  buildMainChatContext: () => string
  cancelRecovery: (key: string) => void
  isTurnTerminal: (key: string, turnId: string) => boolean
  queueThreadStart: (key: string) => void
  settleThreadStart: (key: string) => void
}): {
  bindAgentThread: (key: string, threadId: string) => void
  handleAgentSend: (
    key: string,
    text: string,
    attachments?: ChatAttachment[],
    opts?: AgentSendOptions
  ) => Promise<boolean>
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
    attachments: ChatAttachment[] = [],
    opts: AgentSendOptions = {}
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

      store.appendMessage(key, { id: crypto.randomUUID(), role: 'user', text, attachments, audit: opts.audit })
      const outgoingText = session.watchesMain ? `${options.buildMainChatContext()}\n\n${text}` : text
      const response = await window.api.session.sendMessage({
        threadId,
        text: outgoingText,
        attachments,
        cwd: options.getWorkspace(session),
        model: agentModel,
        effort: session.reasoningEffort ?? options.getSelectedEffort(),
        fastMode: options.getFastMode()
      })
      if (startsNewThread) bindAgentThread(key, response.threadId)
      if (!options.isTurnTerminal(key, response.turn.id)) {
        store.patchSession(key, (current) => ({
          ...current,
          status: 'working',
          turnId: response.turn.id
        }))
      }
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
    if (
      (session?.sourceProvider === 'claude' || session?.sourceProvider === 'codex') &&
      session.runParentThreadId &&
      session.nativeRunId &&
      session.status === 'working'
    ) {
      try {
        await window.api.session.cancelAgentRun({
          provider: session.sourceProvider,
          parentThreadId: session.runParentThreadId,
          nativeId: session.nativeRunId
        })
      } catch (error) {
        store.appendMessage(key, {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: `⚠ Could not stop the native ${session.sourceProvider === 'codex' ? 'Codex' : 'Claude'} task: ${(error as Error).message}`
        })
      }
      return
    }
    if (!session?.threadId || !session.turnId) return
    try {
      await window.api.session.interruptTurn({ threadId: session.threadId, turnId: session.turnId })
    } catch (error) {
      // A completed turn is harmless, but a transport/server failure used to
      // leave the still-visible agent looking like it was stopped when it was
      // not. Keep the notification path authoritative and give the user a
      // retryable, actionable signal.
      store.appendMessage(key, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `⚠ Could not stop the running turn: ${(error as Error).message}. It may have already finished; wait for the status update or try Stop again.`
      })
    }
  }

  async function handleAgentCompact(key: string): Promise<void> {
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    if (!session?.threadId || session.turnId || session.isCompacting) return
    try {
      await window.api.session.compactThread(session.threadId)
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
      await window.api.session.steerTurn({
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
