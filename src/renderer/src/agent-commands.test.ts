import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentCommands } from './agent-commands.ts'
import { createAgentSession, type AgentLiteMessage, type AgentSession } from './agent-session-model.ts'

function commandHarness(acceptsImages = true): {
  sessions: AgentSession[]
  messages: AgentLiteMessage[]
  commands: ReturnType<typeof createAgentCommands>
} {
  const sessions = [createAgentSession('agent-1', 'Agent 2')]
  const messages: AgentLiteMessage[] = []
  const commands = createAgentCommands({
    store: {
      sessionsRef: { current: sessions },
      startQueueRef: { current: [] },
      patchSession: (key, update) => {
        const index = sessions.findIndex((session) => session.key === key)
        if (index >= 0) sessions[index] = update(sessions[index])
      },
      appendMessage: (_key, message) => messages.push(message)
    },
    getWorkspace: () => '/workspace',
    getDefaultModel: (provider) => provider === 'claude' ? 'claude-test-model' : 'test-model',
    getSelectedEffort: () => 'high',
    acceptsImages: () => acceptsImages,
    buildMainChatContext: () => 'context',
    cancelRecovery: () => {}
  })
  return { sessions, messages, commands }
}

test('agent thread binding preserves an existing thread', () => {
  const { sessions, commands } = commandHarness()
  commands.bindAgentThread('agent-1', 'thread-1')
  commands.bindAgentThread('agent-1', 'thread-2')

  assert.equal(sessions[0]?.threadId, 'thread-1')
})

test('agent send rejects unsupported images before starting a thread', async () => {
  const { messages, commands } = commandHarness(false)
  const sent = await commands.handleAgentSend('agent-1', 'Inspect this', [{
    id: 'image-1',
    kind: 'image',
    name: 'image.png',
    path: '/tmp/image.png',
    mediaType: 'image/png',
    size: 10
  }])

  assert.equal(sent, false)
  assert.match(messages[0]?.text ?? '', /does not accept image inputs/)
})

test('agent send forwards the agent reasoning effort', async () => {
  const previousWindow = globalThis.window
  const sentParams: unknown[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        codex: {
          startThread: async () => ({ thread: { id: 'thread-1' } }),
          sendMessage: async (params: unknown) => {
            sentParams.push(params)
            return { turn: { id: 'turn-1' } }
          }
        }
      }
    }
  })

  try {
    const { sessions, commands } = commandHarness()
    sessions[0].reasoningEffort = 'xhigh'
    const sent = await commands.handleAgentSend('agent-1', 'Solve this')

    assert.equal(sent, true)
    assert.equal((sentParams[0] as { effort?: string }).effort, 'xhigh')
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  }
})

test('claude agent send routes through the claude API and binds the returned session id', async () => {
  const previousWindow = globalThis.window
  const sentParams: unknown[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        claude: {
          sendMessage: async (params: unknown) => {
            sentParams.push(params)
            return { threadId: 'claude-session-1', turnId: 'turn-1', model: 'claude-test-model', effort: 'high' }
          }
        }
      }
    }
  })

  try {
    const { sessions, commands } = commandHarness()
    sessions[0] = { ...sessions[0], provider: 'claude', reasoningEffort: 'high' }
    const sent = await commands.handleAgentSend('agent-1', 'Solve this')

    assert.equal(sent, true)
    const params = sentParams[0] as { threadId?: string | null; model?: string; effort?: string }
    assert.equal(params.threadId, null)
    assert.equal(params.model, 'claude-test-model')
    assert.equal(params.effort, 'high')
    assert.equal(sessions[0]?.threadId, 'claude-session-1')
    assert.equal(sessions[0]?.turnId, 'turn-1')
    assert.equal(sessions[0]?.status, 'working')
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  }
})
