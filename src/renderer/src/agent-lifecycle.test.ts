import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentLifecycle, type AgentRecoveryState } from './agent-lifecycle.ts'
import { createAgentSession, type AgentLiteMessage, type AgentSession } from './agent-session-model.ts'

function lifecycleHarness(session: AgentSession): {
  sessions: AgentSession[]
  messages: AgentLiteMessage[]
  selectedModels: string[]
  createdMainThreads: string[]
  crossProviderFocuses: AgentSession[]
  lifecycle: ReturnType<typeof createAgentLifecycle>
} {
  const sessions = [session]
  const messages: AgentLiteMessage[] = []
  const selectedModels: string[] = []
  const createdMainThreads: string[] = []
  const crossProviderFocuses: AgentSession[] = []
  let selectedKey: string | null = session.key
  const recoveryRef = { current: new Map<string, AgentRecoveryState>() }

  const lifecycle = createAgentLifecycle({
    store: {
      sessionsRef: { current: sessions },
      startQueueRef: { current: [] },
      recoveryRef,
      updateSessions: (update) => sessions.splice(0, sessions.length, ...update(sessions)),
      patchSession: (key, update) => {
        const index = sessions.findIndex((candidate) => candidate.key === key)
        if (index >= 0) sessions[index] = update(sessions[index])
      },
      appendMessage: (_key, message) => messages.push(message),
      appendMessageOnce: (_key, message) => {
        if (!messages.some((existing) => existing.id === message.id)) messages.push(message)
      },
      setSelectedKey: (update) => { selectedKey = update(selectedKey) }
    },
    maxRecoveryAttempts: 3,
    recoveryDelayMs: 10_000,
    recoveryPrompt: 'Continue',
    isRecoverable: () => false,
    getWorkspace: () => '/workspace',
    getSelectedModel: () => 'main-model',
    getMainProvider: () => 'codex',
    getActiveThreadId: () => null,
    pickFallbackModel: (model) => model,
    selectMainModel: (model) => selectedModels.push(model),
    clearActiveTurn: () => {},
    createMainThread: () => createdMainThreads.push('created'),
    resumeMainThread: async () => {},
    focusCrossProvider: (focused) => crossProviderFocuses.push(focused)
  })

  return { sessions, messages, selectedModels, createdMainThreads, crossProviderFocuses, lifecycle }
}

test('reset agent session clears conversation state but keeps its window', () => {
  const session = {
    ...createAgentSession('agent-1', 'Agent 2'),
    messages: [{ id: 'answer', role: 'assistant' as const, text: 'Done' }],
    status: 'done' as const,
    contextUsage: { total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 }, last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 }, modelContextWindow: 100 }
  }
  const { sessions, lifecycle } = lifecycleHarness(session)
  lifecycle.handleResetAgentSession('agent-1')

  assert.equal(sessions[0]?.status, 'idle')
  assert.deepEqual(sessions[0]?.messages, [])
  assert.equal(sessions[0]?.contextUsage, null)
})

test('promoting a blank agent selects its model and creates a main thread', async () => {
  const session = { ...createAgentSession('agent-1', 'Agent 2'), model: 'agent-model' }
  const { sessions, selectedModels, createdMainThreads, lifecycle } = lifecycleHarness(session)
  await lifecycle.handlePromoteAgent('agent-1')

  assert.deepEqual(selectedModels, ['agent-model'])
  assert.deepEqual(createdMainThreads, ['created'])
  assert.deepEqual(sessions, [])
})

test('promoting a claude chat while codex owns the main view keeps and focuses its tab', async () => {
  const session = {
    ...createAgentSession('agent-1', 'Agent 2', 'claude'),
    threadId: 'claude-session-1',
    model: 'claude-model'
  }
  const { sessions, selectedModels, createdMainThreads, crossProviderFocuses, lifecycle } = lifecycleHarness(session)
  await lifecycle.handlePromoteAgent('agent-1')

  assert.deepEqual(selectedModels, [])
  assert.deepEqual(createdMainThreads, [])
  assert.equal(crossProviderFocuses[0]?.threadId, 'claude-session-1')
  assert.equal(sessions[0]?.threadId, 'claude-session-1')
})
