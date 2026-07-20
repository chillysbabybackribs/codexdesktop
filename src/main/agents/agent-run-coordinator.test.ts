import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentRunEvent, AgentRunSnapshot, SessionEvent } from '../../shared/ipc.ts'
import { AgentCompletionCoordinator, AgentRunBridge } from './agent-run-coordinator.ts'

function run(overrides: Partial<AgentRunSnapshot> = {}): AgentRunSnapshot {
  return {
    id: 'claude:parent:task-1',
    nativeId: 'task-1',
    provider: 'claude',
    lane: 'model',
    parentThreadId: 'parent',
    parentTurnId: 'origin-turn',
    parentAgentKey: null,
    title: 'Research prices',
    task: 'Research prices',
    status: 'completed',
    progress: 'Task completed',
    resultSummary: 'Found three current prices.',
    outputPath: null,
    wakeStatus: 'pending',
    startedAtMs: 1,
    updatedAtMs: 2,
    completedAtMs: 2,
    ...overrides,
  }
}

function turnEvent(method: 'turn/started' | 'turn/completed', threadId: string, turnId: string): SessionEvent {
  return {
    type: 'notification',
    notification: {
      method,
      params: { threadId, turn: { id: turnId } },
    },
  }
}

const waitForBatch = () => new Promise((resolve) => setTimeout(resolve, 650))

test('Claude background task edges normalize after the parent turn id is gone', () => {
  const events: AgentRunEvent[] = []
  const bridge = new AgentRunBridge((event) => events.push(event))
  bridge.ingestClaude({
    type: 'system', subtype: 'task_started', task_id: 'task-1', description: 'Research prices', prompt: 'Find prices',
  }, { threadId: 'parent', turnId: 'origin-turn' })
  bridge.ingestClaude({
    type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary: 'Done', output_file: '/tmp/task.txt',
  }, { threadId: 'parent', turnId: null })

  assert.equal(events.length, 2)
  assert.equal(events[1].run.parentTurnId, 'origin-turn')
  assert.equal(events[1].run.status, 'completed')
  assert.equal(events[1].run.outputPath, '/tmp/task.txt')
})

test('Codex collab receiver threads normalize into first-class runs', () => {
  const events: AgentRunEvent[] = []
  const bridge = new AgentRunBridge((event) => events.push(event))
  bridge.ingestCodex({
    type: 'notification',
    notification: {
      method: 'item/completed',
      params: {
        threadId: 'parent',
        turnId: 'origin-turn',
        item: {
          type: 'collabAgentToolCall',
          senderThreadId: 'parent',
          receiverThreadIds: ['child'],
          prompt: 'Check the implementation',
          status: 'completed',
          agentsStates: { child: { status: 'completed', message: 'Looks good' } },
        },
      },
    },
  })
  assert.equal(events[0].run.id, 'codex:child')
  assert.equal(events[0].run.status, 'completed')
  assert.equal(events[0].run.parentThreadId, 'parent')
})

test('idle parent is resumed once for duplicate completion events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-coordinator-'))
  const prompts: string[] = []
  const coordinator = new AgentCompletionCoordinator({
    emit: () => {},
    statePath: join(directory, 'outbox.json'),
    resumeParent: async (_threadId, prompt) => { prompts.push(prompt) },
  })
  coordinator.observeRun(run())
  coordinator.observeRun(run())
  await waitForBatch()
  coordinator.observeRun(run())
  await waitForBatch()
  coordinator.dispose()
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /Automatic background-agent continuation/)
})

test('completion inside its spawning turn is suppressed, not duplicated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-coordinator-'))
  const emitted: AgentRunEvent[] = []
  let resumes = 0
  const coordinator = new AgentCompletionCoordinator({
    emit: (event) => emitted.push(event),
    statePath: join(directory, 'outbox.json'),
    resumeParent: async () => { resumes += 1 },
  })
  coordinator.observeSessionEvent(turnEvent('turn/started', 'parent', 'origin-turn'))
  coordinator.observeRun(run())
  coordinator.observeSessionEvent(turnEvent('turn/completed', 'parent', 'origin-turn'))
  await waitForBatch()
  coordinator.dispose()
  assert.equal(resumes, 0)
  assert.equal(emitted.at(-1)?.run.wakeStatus, 'suppressed')
})

test('completion while a different parent turn is busy waits for its terminal event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-coordinator-'))
  let resumes = 0
  const coordinator = new AgentCompletionCoordinator({
    emit: () => {},
    statePath: join(directory, 'outbox.json'),
    resumeParent: async () => { resumes += 1 },
  })
  coordinator.observeSessionEvent(turnEvent('turn/started', 'parent', 'new-turn'))
  coordinator.observeRun(run())
  await waitForBatch()
  assert.equal(resumes, 0)
  coordinator.observeSessionEvent(turnEvent('turn/completed', 'parent', 'new-turn'))
  await waitForBatch()
  coordinator.dispose()
  assert.equal(resumes, 1)
})
