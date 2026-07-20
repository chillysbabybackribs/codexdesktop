import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentLifecycle, type AgentRecoveryState } from './agent-lifecycle.ts'
import { createAgentSession, type AgentLiteMessage, type AgentSession } from './agent-session-model.ts'

function lifecycleHarness(
  session: AgentSession,
  options: {
    createMainThread?: () => boolean
    resumeMainThread?: (threadId: string) => Promise<boolean>
  } = {}
): {
  sessions: AgentSession[]
  messages: AgentLiteMessage[]
  selectedModels: string[]
  createdMainThreads: string[]
  lifecycle: ReturnType<typeof createAgentLifecycle>
} {
  const sessions = [session]
  const messages: AgentLiteMessage[] = []
  const selectedModels: string[] = []
  const createdMainThreads: string[] = []
  const openKeys = [session.key]
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
      resetRenderState: () => {},
      removeRenderState: () => {},
      setOpenKeys: (update) => openKeys.splice(0, openKeys.length, ...update(openKeys)),
      setSelectedKey: (update) => { selectedKey = update(selectedKey) }
    },
    maxRecoveryAttempts: 3,
    recoveryDelayMs: 10_000,
    recoveryPrompt: 'Continue',
    isRecoverable: () => false,
    isTurnTerminal: () => false,
    getWorkspace: () => '/workspace',
    getSelectedModel: () => 'main-model',
    getActiveThreadId: () => null,
    pickFallbackModel: (model) => model,
    selectMainModel: (model) => selectedModels.push(model),
    createMainThread: options.createMainThread ?? (() => {
      createdMainThreads.push('created')
      return true
    }),
    resumeMainThread: options.resumeMainThread ?? (async () => true)
  })

  return { sessions, messages, selectedModels, createdMainThreads, lifecycle }
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

test('failed agent promotion keeps the agent session as the thread owner', async () => {
  const session = {
    ...createAgentSession('agent-1', 'Agent 2'),
    threadId: 'thread-agent',
    model: 'agent-model'
  }
  const { sessions, selectedModels, lifecycle } = lifecycleHarness(session, {
    resumeMainThread: async () => false
  })

  await lifecycle.handlePromoteAgent('agent-1')

  assert.equal(sessions[0]?.threadId, 'thread-agent')
  assert.deepEqual(selectedModels, [])
})

test('closing a background agent logs interrupt and unsubscribe cleanup failures with its thread id', async () => {
  const previousWindow = globalThis.window
  const previousWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        session: {
          interruptTurn: async () => { throw new Error('interrupt transport failed') },
          unsubscribeThread: async () => { throw new Error('unsubscribe transport failed') }
        }
      }
    }
  })

  try {
    const session = {
      ...createAgentSession('agent-1', 'Agent 2'),
      threadId: 'thread-agent',
      turnId: 'turn-agent',
      status: 'working' as const
    }
    const { sessions, lifecycle } = lifecycleHarness(session)

    lifecycle.handleCloseAgentSession('agent-1')
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(sessions, [])
    assert.match(String(warnings[0]?.[0] ?? ''), /interrupt background agent thread thread-agent/)
    assert.match(String(warnings[1]?.[0] ?? ''), /unsubscribe background agent thread thread-agent/)
  } finally {
    console.warn = previousWarn
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  }
})

test('closing a working native Codex agent stops its native turn', async () => {
  const previousWindow = globalThis.window
  const cancelled: unknown[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        session: {
          cancelAgentRun: async (params: unknown) => { cancelled.push(params) }
        }
      }
    }
  })

  try {
    const session = {
      ...createAgentSession('agent-1', 'Codex agent'),
      sourceProvider: 'codex' as const,
      runParentThreadId: 'parent-thread',
      nativeRunId: 'child-thread',
      status: 'working' as const
    }
    const { lifecycle } = lifecycleHarness(session)

    lifecycle.handleCloseAgentSession('agent-1')
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(cancelled, [{
      provider: 'codex',
      parentThreadId: 'parent-thread',
      nativeId: 'child-thread'
    }])
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  }
})
