import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent } from '../../shared/ipc.ts'
import { BrowserPolicyCoordinator } from './browser-policy-coordinator.ts'

const waitForGovernor = () => new Promise((resolve) => setTimeout(resolve, 380))

function item(tool: string): SessionEvent {
  return {
    type: 'notification',
    notification: {
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        item: { type: 'dynamicToolCall', tool },
      },
    },
  }
}

function completed(): SessionEvent {
  return {
    type: 'notification',
    notification: {
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn' } },
    },
  }
}

test('dual policy enforces a missing background lane', async () => {
  const prompts: string[] = []
  const coordinator = new BrowserPolicyCoordinator(async (_threadId, prompt) => { prompts.push(prompt) })
  coordinator.register('thread', 'turn', {
    preset: 'quality-max', mode: 'dual', required: true, reason: 'current public fact',
  })
  coordinator.observe(item('browser_live_search'))
  coordinator.observe(completed())
  await waitForGovernor()
  coordinator.dispose()
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /background research/)
})

test('dual tool satisfies both lanes without a continuation', async () => {
  let continuations = 0
  const coordinator = new BrowserPolicyCoordinator(async () => { continuations += 1 })
  coordinator.register('thread', 'turn', {
    preset: 'quality-max', mode: 'dual', required: true, reason: 'current public fact',
  })
  coordinator.observe(item('browser_research_dual'))
  coordinator.observe(completed())
  await waitForGovernor()
  coordinator.dispose()
  assert.equal(continuations, 0)
})

test('locally answerable turns never enforce browsing', async () => {
  let continuations = 0
  const coordinator = new BrowserPolicyCoordinator(async () => { continuations += 1 })
  coordinator.observe(completed())
  coordinator.register('thread', 'turn', {
    preset: 'quality-max', mode: 'none', required: false, reason: 'local',
  })
  await waitForGovernor()
  coordinator.dispose()
  assert.equal(continuations, 0)
})
