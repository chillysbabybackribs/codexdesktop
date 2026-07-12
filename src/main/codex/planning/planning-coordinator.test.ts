import assert from 'node:assert/strict'
import test from 'node:test'
import { PlanningCoordinator } from './planning-coordinator.ts'

const plan = {
  objective: 'Add guarded planning',
  decisions: ['Main process owns phase state'],
  steps: ['Add coordinator', 'Enforce policies'],
  affectedFiles: ['src/main/codex/codex-client.ts'],
  nonGoals: ['Domain-specific planning skills'],
  acceptanceCriteria: ['Writes are blocked before approval'],
  risks: ['Stale approvals']
}

test('planning requires a submitted current revision before execution', () => {
  const coordinator = new PlanningCoordinator()
  assert.equal(coordinator.begin('thread-1').phase, 'discovery')
  const submitted = coordinator.submit('thread-1', plan)
  assert.equal(submitted.phase, 'awaitingApproval')
  assert.throws(() => coordinator.approve('thread-1', submitted.revision - 1), /stale/)
  const approved = coordinator.approve('thread-1', submitted.revision)
  assert.equal(approved.phase, 'executing')
  assert.equal(approved.approvedRevision, submitted.revision)
  assert.match(coordinator.approvedPlanContext('thread-1') ?? '', /guarded planning/)
})

test('pre-approval phases expose only read-only dynamic tools', () => {
  const coordinator = new PlanningCoordinator()
  coordinator.begin('thread-1')
  assert.equal(coordinator.allowsDynamicTool('thread-1', 'research_web'), true)
  assert.equal(coordinator.allowsDynamicTool('thread-1', 'submit_plan'), true)
  assert.equal(coordinator.allowsDynamicTool('thread-1', 'browser_run'), false)
  const submitted = coordinator.submit('thread-1', plan)
  coordinator.approve('thread-1', submitted.revision)
  assert.equal(coordinator.allowsDynamicTool('thread-1', 'browser_run'), true)
})

test('requesting changes invalidates approval and failed execution requires replanning', () => {
  const coordinator = new PlanningCoordinator()
  const submitted = coordinator.submit('thread-1', plan)
  assert.equal(coordinator.requestChanges('thread-1', submitted.revision).phase, 'discovery')
  const revised = coordinator.submit('thread-1', { ...plan, objective: 'Revised plan' })
  coordinator.approve('thread-1', revised.revision)
  assert.equal(coordinator.finishExecution('thread-1', false)?.phase, 'needsReplan')
})
