import type { TurnError } from '../../shared/codex-protocol/v2/TurnError'
import type { AgentLiteMessage, AgentSession } from './agent-session-model.js'

type MutableRef<T> = { current: T }

export type AgentRecoveryState = {
  attempts: number
  handledTurnIds: Set<string>
  timer: number | null
}

type AgentLifecycleStore = {
  sessionsRef: MutableRef<AgentSession[]>
  startQueueRef: MutableRef<string[]>
  recoveryRef: MutableRef<Map<string, AgentRecoveryState>>
  updateSessions: (update: (sessions: AgentSession[]) => AgentSession[]) => void
  patchSession: (key: string, update: (session: AgentSession) => AgentSession) => void
  appendMessage: (key: string, message: AgentLiteMessage) => void
  appendMessageOnce: (key: string, message: AgentLiteMessage) => void
  setOpenKeys: (update: (keys: string[]) => string[]) => void
  setSelectedKey: (update: (key: string | null) => string | null) => void
}

export function createAgentLifecycle(options: {
  store: AgentLifecycleStore
  maxRecoveryAttempts: number
  recoveryDelayMs: number
  recoveryPrompt: string
  isRecoverable: (error: TurnError | null) => boolean
  getWorkspace: () => string | null
  getSelectedModel: () => string | null
  getActiveThreadId: () => string | null
  pickFallbackModel: (model: string | null) => string | null
  selectMainModel: (model: string) => void
  createMainThread: () => boolean
  resumeMainThread: (threadId: string) => Promise<boolean>
}): {
  cancelRecovery: (key: string) => void
  scheduleRecovery: (key: string, turnId: string, error: TurnError | null) => void
  handleCloseAgentSession: (key: string) => void
  handleResetAgentSession: (key: string) => void
  handlePromoteAgent: (key: string) => Promise<void>
} {
  const { store } = options

  function cancelRecovery(key: string): void {
    const state = store.recoveryRef.current.get(key)
    if (state?.timer !== null && state?.timer !== undefined) window.clearTimeout(state.timer)
    store.recoveryRef.current.delete(key)
  }

  function scheduleRecovery(key: string, turnId: string, error: TurnError | null): void {
    if (!options.isRecoverable(error)) return
    const existing = store.recoveryRef.current.get(key)
    if (existing?.handledTurnIds.has(turnId)) return

    const state = existing ?? { attempts: 0, handledTurnIds: new Set<string>(), timer: null }
    state.handledTurnIds.add(turnId)
    store.recoveryRef.current.set(key, state)
    if (state.attempts >= options.maxRecoveryAttempts) {
      store.appendMessageOnce(key, {
        id: `recovery-stopped-${turnId}`,
        role: 'assistant',
        text: `⚠ Auto-recovery stopped after ${options.maxRecoveryAttempts} attempts. Send a message to continue the task.`
      })
      return
    }

    state.attempts += 1
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    const currentModel = session?.model ?? options.getSelectedModel()
    const nextModel = state.attempts === 1 ? currentModel : options.pickFallbackModel(currentModel)
    const switching = nextModel !== null && nextModel !== currentModel
    const delaySeconds = Math.round(options.recoveryDelayMs / 1000)
    store.appendMessageOnce(key, {
      id: `recovery-${turnId}`,
      role: 'assistant',
      text: switching
        ? `${currentModel ?? 'The model'} is under heavy load — continuing on ${nextModel} in ${delaySeconds}s (attempt ${state.attempts}/${options.maxRecoveryAttempts}).`
        : `The model is under heavy load — retrying in ${delaySeconds}s (attempt ${state.attempts}/${options.maxRecoveryAttempts}).`
    })
    state.timer = window.setTimeout(() => {
      state.timer = null
      void runRecovery(key, nextModel)
    }, options.recoveryDelayMs)
  }

  async function runRecovery(key: string, model: string | null): Promise<void> {
    if (!store.recoveryRef.current.has(key)) return
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    if (!session?.threadId || session.turnId) return
    if (model && model !== session.model) {
      store.patchSession(key, (current) => ({ ...current, model }))
    }

    try {
      const response = await window.api.codex.sendMessage({
        threadId: session.threadId,
        text: options.recoveryPrompt,
        cwd: options.getWorkspace(),
        model: model ?? session.model ?? options.getSelectedModel(),
        effort: session.reasoningEffort
      })
      store.patchSession(key, (current) => ({
        ...current,
        status: 'working',
        turnId: response.turn.id
      }))
    } catch (error) {
      store.appendMessage(key, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `⚠ Auto-recovery could not restart the turn: ${(error as Error).message}`
      })
      cancelRecovery(key)
    }
  }

  function removeSession(key: string): AgentSession | null {
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key) ?? null
    cancelRecovery(key)
    store.updateSessions((sessions) => sessions.filter((candidate) => candidate.key !== key))
    store.setOpenKeys((current) => current.filter((candidate) => candidate !== key))
    store.setSelectedKey((current) => current === key ? null : current)
    return session
  }

  function handleCloseAgentSession(key: string): void {
    const session = removeSession(key)
    if (session?.threadId && session.threadId !== options.getActiveThreadId()) {
      if (session.turnId) {
        void window.api.codex.interruptTurn({ threadId: session.threadId, turnId: session.turnId }).catch(() => {})
      }
      void window.api.codex.unsubscribeThread(session.threadId).catch(() => {})
    }
  }

  function handleResetAgentSession(key: string): void {
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    if (!session || session.status === 'working') return
    cancelRecovery(key)
    store.startQueueRef.current = store.startQueueRef.current.filter((candidate) => candidate !== key)
    store.patchSession(key, (current) => ({
      ...current,
      threadId: null,
      status: 'idle',
      turnId: null,
      messages: [],
      contextUsage: null,
      isCompacting: false
    }))
    if (session.threadId && session.threadId !== options.getActiveThreadId()) {
      void window.api.codex.unsubscribeThread(session.threadId).catch(() => {})
    }
  }

  async function handlePromoteAgent(key: string): Promise<void> {
    const session = store.sessionsRef.current.find((candidate) => candidate.key === key)
    if (!session) return

    if (!session.threadId) {
      if (!options.createMainThread()) return
      if (session.model && session.model !== options.getSelectedModel()) options.selectMainModel(session.model)
      removeSession(key)
      return
    }
    if (!await options.resumeMainThread(session.threadId)) return
    if (session.model && session.model !== options.getSelectedModel()) options.selectMainModel(session.model)
    removeSession(key)
  }

  return {
    cancelRecovery,
    scheduleRecovery,
    handleCloseAgentSession,
    handleResetAgentSession,
    handlePromoteAgent
  }
}
