import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentCommands } from './agent-commands.ts'
import { createAgentSession, type AgentLiteMessage, type AgentSession } from './agent-session-model.ts'

function commandHarness(acceptsImages = true): {
  sessions: AgentSession[]
  messages: AgentLiteMessage[]
  threadStartEvents: string[]
  commands: ReturnType<typeof createAgentCommands>
} {
  const sessions = [createAgentSession('agent-1', 'Agent 2')]
  const messages: AgentLiteMessage[] = []
  const threadStartEvents: string[] = []
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
    getSelectedModel: () => 'test-model',
    getSelectedEffort: () => 'high',
    getFastMode: () => true,
    acceptsImages: () => acceptsImages,
    buildMainChatContext: () => 'context',
    cancelRecovery: () => {},
    queueThreadStart: (key) => threadStartEvents.push(`queued:${key}`),
    settleThreadStart: (key) => threadStartEvents.push(`settled:${key}`)
  })
  return { sessions, messages, threadStartEvents, commands }
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
  let startThreadCalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        codex: {
          startThread: async () => {
            startThreadCalls += 1
            return { thread: { id: 'thread-1' } }
          },
          sendMessage: async (params: unknown) => {
            sentParams.push(params)
            return { threadId: 'thread-1', turn: { id: 'turn-1' } }
          }
        }
      }
    }
  })

  try {
    const { sessions, threadStartEvents, commands } = commandHarness()
    sessions[0].reasoningEffort = 'xhigh'
    const sent = await commands.handleAgentSend('agent-1', 'Solve this')

    assert.equal(sent, true)
    assert.equal(startThreadCalls, 0)
    assert.equal((sentParams[0] as { threadId?: string | null }).threadId, null)
    assert.equal((sentParams[0] as { effort?: string }).effort, 'xhigh')
    assert.equal((sentParams[0] as { fastMode?: boolean }).fastMode, true)
    assert.equal(sessions[0]?.threadId, 'thread-1')
    assert.deepEqual(threadStartEvents, ['queued:agent-1', 'settled:agent-1'])
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  }
})

test('agent stop surfaces an interrupt failure instead of leaving a working agent silently stuck', async () => {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        codex: {
          interruptTurn: async () => { throw new Error('app-server unavailable') }
        }
      }
    }
  })

  try {
    const { sessions, messages, commands } = commandHarness()
    sessions[0].threadId = 'thread-1'
    sessions[0].turnId = 'turn-1'

    await commands.handleAgentStop('agent-1')

    assert.match(messages[0]?.text ?? '', /Could not stop the running turn: app-server unavailable/)
    assert.match(messages[0]?.text ?? '', /try Stop again/)
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    } else {
      Reflect.deleteProperty(globalThis, 'window')
    }
  }
})
