import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentProvider } from '../../shared/agent.ts'
import { AgentProviderRegistry, type AgentProviderAdapter } from './provider-adapter.ts'

function fakeAdapter(provider: AgentProvider): AgentProviderAdapter {
  return {
    provider,
    getAuthStatus: async () => ({ authenticated: true, source: null }),
    listModels: async () => [],
    listSessions: async () => ({ data: [], nextCursor: null }),
    readSession: async () => [],
    startSession: async (options) => ({ ...options, session: null }),
    resumeSession: async (clientSessionId, session, cwd) => ({
      clientSessionId,
      session,
      cwd: cwd ?? '',
      model: null,
      effort: null,
      collaborationMode: 'default'
    }),
    sendTurn: async (input) => {
      if (!input.session) throw new Error('test adapter requires a session')
      return {
        clientSessionId: input.clientSessionId,
        session: input.session,
        turn: { ...input.session, turnId: 'turn-1' },
        model: input.model,
        effort: input.effort
      }
    },
    steerTurn: async () => {},
    interruptTurn: async () => {},
    unsubscribeSession: () => {},
    onEvent: () => () => {}
  }
}

test('provider registry routes adapters by provider identity', () => {
  const codex = fakeAdapter('codex')
  const claude = fakeAdapter('claude')
  const registry = new AgentProviderRegistry([codex, claude])

  assert.equal(registry.get('codex'), codex)
  assert.equal(registry.get('claude'), claude)
  assert.deepEqual(registry.list(), [codex, claude])
})

test('provider registry rejects duplicates and missing providers', () => {
  const registry = new AgentProviderRegistry([fakeAdapter('codex')])

  assert.throws(() => registry.register(fakeAdapter('codex')), /already registered: codex/)
  assert.throws(() => registry.get('claude'), /not registered: claude/)
})
