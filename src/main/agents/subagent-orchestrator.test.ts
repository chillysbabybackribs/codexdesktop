import assert from 'node:assert/strict'
import test from 'node:test'
import { SubagentOrchestrator } from './subagent-orchestrator.ts'
import type { SessionProvider } from '../providers/session-provider.ts'
import type { SessionEvent, AgentSpawnedEvent } from '../../shared/ipc.ts'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification.ts'
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem.ts'

// A fake provider that records calls and lets the test control when a child's
// turn "starts" (sendMessage resolves with a threadId) — only the two methods
// the orchestrator touches are implemented.
function fakeProvider(overrides: Partial<{
  sendMessage: (threadId: string) => Promise<{ threadId: string }>
  interruptTurn: (threadId: string, turnId: string) => Promise<unknown>
}> = {}): {
  provider: SessionProvider
  interrupts: Array<{ threadId: string; turnId: string }>
  sends: number
} {
  const interrupts: Array<{ threadId: string; turnId: string }> = []
  let sends = 0
  const provider = {
    sendMessage: async () => {
      sends += 1
      const threadId = overrides.sendMessage
        ? (await overrides.sendMessage(`child-${sends}`)).threadId
        : `child-${sends}`
      return { threadId, model: null, reasoningEffort: null } as never
    },
    interruptTurn: async (threadId: string, turnId: string) => {
      interrupts.push({ threadId, turnId })
      return overrides.interruptTurn ? overrides.interruptTurn(threadId, turnId) : undefined
    },
  } as unknown as SessionProvider
  return {
    provider,
    interrupts,
    get sends() {
      return sends
    },
  } as { provider: SessionProvider; interrupts: Array<{ threadId: string; turnId: string }>; sends: number }
}

function agentMessage(text: string): ThreadItem {
  return { type: 'agentMessage', id: 'm1', text, phase: null, memoryCitation: null } as ThreadItem
}

function turnCompleted(threadId: string, items: ThreadItem[], status: 'completed' | 'failed' = 'completed'): SessionEvent {
  const notification = {
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: 't1', items, itemsView: 'full', status, error: null, startedAt: 0, completedAt: 1, durationMs: 1 },
    },
  } as unknown as ServerNotification
  return { type: 'notification', notification }
}

test('spawnAndAwait returns the child final answer as an ok result', async () => {
  const { provider } = fakeProvider()
  const events: Array<SessionEvent | AgentSpawnedEvent> = []
  const orchestrator = new SubagentOrchestrator(() => provider, (event) => events.push(event))

  const pending = orchestrator.spawnAndAwait({
    parentThreadId: 'lead-thread',
    parentTurnId: 'lead-turn',
    parentAgentKey: 'lead-key',
    task: 'summarize the file',
  })
  // Let the async sendMessage bind the child threadId.
  await Promise.resolve()
  await Promise.resolve()

  // The child's turn completes; the orchestrator resolves the pending promise.
  orchestrator.tagEvent(turnCompleted('child-1', [agentMessage('the summary')]))
  const result = await pending

  assert.equal(result.ok, true)
  assert.equal(result.status, 'completed')
  assert.equal(result.threadId, 'child-1')
  assert.equal(result.finalText, 'the summary')
})

test('spawnAndAwait announces agentSpawned before any turn events', async () => {
  const { provider } = fakeProvider()
  const events: Array<SessionEvent | AgentSpawnedEvent> = []
  const orchestrator = new SubagentOrchestrator(() => provider, (event) => events.push(event))

  orchestrator.spawnAndAwait({
    parentThreadId: 'lead-thread',
    parentTurnId: 'lead-turn',
    parentAgentKey: 'lead-key',
    task: 'do work',
    title: 'worker A',
    model: 'claude-default',
  })
  await Promise.resolve()

  const spawned = events.find((e): e is AgentSpawnedEvent => e.type === 'agentSpawned')
  assert.ok(spawned, 'an agentSpawned event was emitted')
  assert.equal(spawned.parentAgentKey, 'lead-key')
  assert.equal(spawned.parentThreadId, 'lead-thread')
  assert.equal(spawned.title, 'worker A')
  assert.equal(spawned.model, 'claude-default')
  assert.equal(typeof spawned.agentKey, 'string')
})

test('a failed child turn resolves ok:false (never rejects) so the parent sees it', async () => {
  const { provider } = fakeProvider()
  const orchestrator = new SubagentOrchestrator(() => provider, () => {})

  const pending = orchestrator.spawnAndAwait({
    parentThreadId: 'lead-thread',
    parentTurnId: 'lead-turn',
    parentAgentKey: 'lead-key',
    task: 'do work',
  })
  await Promise.resolve()
  await Promise.resolve()

  orchestrator.tagEvent(turnCompleted('child-1', [], 'failed'))
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
})

test('a provider start failure resolves ok:false rather than throwing', async () => {
  const provider = {
    sendMessage: async () => {
      throw new Error('runtime unavailable')
    },
  } as unknown as SessionProvider
  const orchestrator = new SubagentOrchestrator(() => provider, () => {})

  const result = await orchestrator.spawnAndAwait({
    parentThreadId: 'lead-thread',
    parentTurnId: 'lead-turn',
    parentAgentKey: 'lead-key',
    task: 'do work',
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'runtime unavailable')
})

test('tagEvent stamps child events with parentage and leaves unrelated events untouched', async () => {
  const { provider } = fakeProvider()
  const orchestrator = new SubagentOrchestrator(() => provider, () => {})

  orchestrator.spawnAndAwait({
    parentThreadId: 'lead-thread',
    parentTurnId: 'lead-turn',
    parentAgentKey: 'lead-key',
    task: 'do work',
  })
  await Promise.resolve()
  await Promise.resolve()

  const childDelta = {
    type: 'notification' as const,
    notification: { method: 'item/agentMessage/delta', params: { threadId: 'child-1' } } as unknown,
  }
  const tagged = orchestrator.tagEvent(childDelta)
  assert.equal(tagged.type, 'notification')
  if (tagged.type === 'notification') {
    assert.equal(tagged.parentThreadId, 'lead-thread')
    assert.equal(typeof tagged.agentKey, 'string')
    // The wire notification object is not mutated.
    assert.equal(tagged.notification, childDelta.notification)
  }

  const unrelated = {
    type: 'notification' as const,
    notification: { method: 'turn/started', params: { threadId: 'some-other-thread' } } as unknown,
  }
  const passthrough = orchestrator.tagEvent(unrelated)
  assert.equal(passthrough, unrelated)
})

test('interruptChildrenOf stops in-flight children and settles them interrupted', async () => {
  const fake = fakeProvider()
  const results: Array<{ status: string }> = []
  const orchestrator = new SubagentOrchestrator(() => fake.provider, () => {})

  const pending = orchestrator.spawnAndAwait({
    parentThreadId: 'lead-thread',
    parentTurnId: 'lead-turn',
    parentAgentKey: 'lead-key',
    task: 'do work',
  })
  pending.then((r) => results.push(r))
  await Promise.resolve()
  await Promise.resolve()

  orchestrator.interruptChildrenOf('lead-thread', 'lead-turn')
  const result = await pending

  assert.equal(result.status, 'interrupted')
  assert.equal(result.ok, false)
  assert.equal(fake.interrupts.length, 1)
  assert.equal(fake.interrupts[0].threadId, 'child-1')
})

test('interruptChildrenOf only cascades to the matching parent turn', async () => {
  const fake = fakeProvider()
  const orchestrator = new SubagentOrchestrator(() => fake.provider, () => {})

  const pending = orchestrator.spawnAndAwait({
    parentThreadId: 'lead-thread',
    parentTurnId: 'turn-A',
    parentAgentKey: 'lead-key',
    task: 'do work',
  })
  await Promise.resolve()
  await Promise.resolve()

  // A different parent turn's interrupt must not touch this child.
  orchestrator.interruptChildrenOf('lead-thread', 'turn-B')
  assert.equal(fake.interrupts.length, 0)

  // The right turn does.
  orchestrator.interruptChildrenOf('lead-thread', 'turn-A')
  await pending
  assert.equal(fake.interrupts.length, 1)
})
