import assert from 'node:assert/strict'
import test from 'node:test'
import type { SpawnRequest, SpawnResult, SubagentSpawner } from './subagent-orchestrator.ts'
import { runAgentTool } from './agent-tool-router.ts'

const owner = {
  parentThreadId: 'parent',
  parentTurnId: 'turn',
  parentAgentKey: null,
  cwd: '/workspace',
}

test('parallel subagent tool gathers two independent results behind one barrier', async () => {
  let requests: SpawnRequest[] = []
  const spawner = {
    spawnAndAwait: async () => { throw new Error('unexpected single spawn') },
    spawnManyAndAwait: async (next: SpawnRequest[]): Promise<SpawnResult[]> => {
      requests = next
      return next.map((request, index) => ({
        ok: true,
        agentKey: `agent-${index}`,
        threadId: `thread-${index}`,
        finalText: `result: ${request.task}`,
        status: 'completed',
      }))
    },
  } satisfies SubagentSpawner

  const result = await runAgentTool('spawn_subagents_parallel', {
    tasks: [
      { task: 'research current docs', title: 'Docs', model: 'claude-default' },
      { task: 'audit the answer', title: 'Audit' },
    ],
  }, owner, spawner)

  assert.equal(result.ok, true)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].parentThreadId, 'parent')
  assert.equal(requests[0].cwd, '/workspace')
  assert.deepEqual(result.results, [
    { ok: true, status: 'completed', result: 'result: research current docs' },
    { ok: true, status: 'completed', result: 'result: audit the answer' },
  ])
})

test('parallel subagent tool rejects a one-task fan-out', async () => {
  const result = await runAgentTool('spawn_subagents_parallel', {
    tasks: [{ task: 'only one' }],
  }, owner, {} as SubagentSpawner)
  assert.equal(result.ok, false)
  assert.match(String(result.error), /between 2 and 3/)
})
