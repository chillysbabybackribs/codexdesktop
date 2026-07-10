import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem.ts'
import { buildTurnTrace, isTurnTrace } from './trace.ts'

const turnUsage = {
  totalTokens: 1_200,
  inputTokens: 800,
  cachedInputTokens: 400,
  outputTokens: 400,
  reasoningOutputTokens: 100
}

const cumulativeUsage = {
  totalTokens: 88_000,
  inputTokens: 70_000,
  cachedInputTokens: 20_000,
  outputTokens: 18_000,
  reasoningOutputTokens: 4_000
}

test('buildTurnTrace isolates the selected turn and reports per-turn usage', () => {
  const items: ThreadItem[] = [
    {
      type: 'userMessage',
      id: 'user-old',
      clientId: null,
      content: [{ type: 'text', text: 'Previous turn', text_elements: [] }]
    },
    {
      type: 'userMessage',
      id: 'user-current',
      clientId: null,
      content: [
        { type: 'text', text: '$artifact-first-web-research\nCompare the recent reports.', text_elements: [] },
        { type: 'skill', name: 'artifact-first-web-research', path: '/skills/artifact-first-web-research/SKILL.md' }
      ]
    },
    {
      type: 'dynamicToolCall',
      id: 'browser-current',
      namespace: null,
      tool: 'browser_run',
      arguments: { code: 'return document.title' },
      status: 'completed',
      contentItems: [{ type: 'inputText', text: '{"title":"Example"}' }],
      success: true,
      durationMs: 250
    },
    {
      type: 'agentMessage',
      id: 'answer-current',
      text: 'Here are the findings.',
      phase: 'final_answer',
      memoryCitation: null
    }
  ]

  const trace = buildTurnTrace({
    threadId: 'thread-1',
    threadTitle: '$artifact-first-web-research Compare recent reports',
    turnId: 'turn-current',
    model: 'fallback-model',
    workspace: '/fallback',
    items,
    itemMeta: {
      'user-old': { turnId: 'turn-old' },
      'user-current': { turnId: 'turn-current', startedAtMs: 1_000 },
      'browser-current': { turnId: 'turn-current', startedAtMs: 1_100, completedAtMs: 1_350 },
      'answer-current': { turnId: 'turn-current', completedAtMs: 2_000 }
    },
    meta: {
      status: 'completed',
      origin: 'live',
      requestedModel: 'gpt-5.4',
      model: 'gpt-5.4',
      workspace: '/workspace',
      startedAtMs: 1_000,
      completedAtMs: 2_000,
      tokens: {
        turn: turnUsage,
        latestCall: turnUsage,
        threadTotalAtEnd: cumulativeUsage,
        modelContextWindow: 200_000,
        modelCallCount: 3
      }
    }
  })

  assert.equal(trace.thread.title, 'Compare recent reports')
  assert.equal(trace.prompt, 'Compare the recent reports.')
  assert.equal(trace.finalResponse, 'Here are the findings.')
  assert.equal(trace.environment.model, 'gpt-5.4')
  assert.equal(trace.environment.workspace, '/workspace')
  assert.deepEqual(trace.usage.turn, turnUsage)
  assert.deepEqual(trace.usage.latestModelCall, turnUsage)
  assert.deepEqual(trace.usage.threadTotalAtEnd, cumulativeUsage)
  assert.equal(trace.usage.modelCallCount, 3)
  assert.equal(trace.schemaVersion, 3)
  assert.equal(trace.capture.completeness, 'complete')
  assert.equal(trace.capture.fidelity, 'full')
  assert.equal(trace.turn.durationMs, 1_000)
  assert.equal(trace.summary.itemCount, 3)
  assert.equal(trace.summary.executionCount, 1)
  assert.equal(trace.summary.structuredToolCallCount, 1)
  assert.equal(trace.summary.searchEventCount, 0)
  assert.equal(trace.summary.browserToolCount, 1)
  assert.equal(trace.usage.accounting?.turnTotalSemantics, 'accumulatedAcrossModelCalls')
  assert.equal(trace.usage.accounting?.uncachedInputTokens, 400)
  assert.equal(trace.usage.accounting?.cachedInputPercent, 50)
  assert.equal(trace.usage.accounting?.latestCallContextPercent, 0.4)
  assert.equal(trace.timing?.wallDurationMs, 1_000)
  assert.equal(trace.timing?.attributedDurationMs, 250)
  assert.equal(trace.timing?.unattributedDurationMs, 750)
  assert.equal(trace.timing?.attributionPercent, 25)
  assert.deepEqual(trace.skills, [
    { name: 'artifact-first-web-research', path: '/skills/artifact-first-web-research/SKILL.md' }
  ])
  assert.equal(trace.timeline[1]?.status, 'completed')
})

test('buildTurnTrace marks bounded captures and indexes sources and artifacts', () => {
  const oversizedOutput = 'x'.repeat(30_050)
  const items: ThreadItem[] = [
    {
      type: 'userMessage',
      id: 'user-1',
      clientId: null,
      content: [{ type: 'text', text: 'Research the migration.', text_elements: [] }]
    },
    {
      type: 'commandExecution',
      id: 'command-1',
      command: 'node /tmp/codexdesktop-tasks/migration/evidence.jsonl',
      cwd: '/workspace',
      processId: null,
      source: 'unifiedExecStartup',
      status: 'failed',
      commandActions: [],
      aggregatedOutput: oversizedOutput,
      exitCode: 1,
      durationMs: 500
    },
    {
      type: 'agentMessage',
      id: 'answer-1',
      text: 'See [Electron docs](https://www.electronjs.org/docs/latest/api/web-contents-view) and [developer report](https://github.com/electron/electron/issues/44914).',
      phase: 'final_answer',
      memoryCitation: null
    }
  ]

  const trace = buildTurnTrace({
    threadId: 'thread-1',
    threadTitle: 'Research migration',
    turnId: 'turn-1',
    model: 'gpt-5.5',
    workspace: '/workspace',
    items,
    itemMeta: {
      'user-1': { turnId: 'turn-1', startedAtMs: 1_000, completedAtMs: 1_100 },
      'command-1': { turnId: 'turn-1', startedAtMs: 1_100, completedAtMs: 1_600 },
      'answer-1': { turnId: 'turn-1', startedAtMs: 1_600, completedAtMs: 2_000 }
    },
    meta: {
      status: 'completed',
      origin: 'live',
      model: 'gpt-5.5',
      startedAtMs: 1_000,
      completedAtMs: 2_000,
      tokens: {
        turn: turnUsage,
        latestCall: turnUsage,
        threadTotalAtEnd: turnUsage,
        modelContextWindow: 200_000,
        modelCallCount: 1
      }
    }
  })

  assert.equal(trace.capture.completeness, 'partial')
  assert.equal(trace.capture.fidelity, 'bounded')
  assert.deepEqual(trace.capture.missing, [])
  assert.deepEqual(trace.capture.truncations, [{
    path: 'timeline[1].details.output',
    reason: 'sizeLimit',
    capturedCharacters: 30_000,
    omittedCharacters: 50
  }])
  assert.equal(trace.summary.executionCount, 1)
  assert.equal(trace.summary.commandCount, 1)
  assert.equal(trace.summary.failedCommandCount, 1)
  assert.equal(trace.summary.structuredToolCallCount, 0)
  assert.deepEqual(trace.sourceIndex?.items.map(({ label, kind }) => ({ label, kind })), [
    { label: 'Electron docs', kind: 'official' },
    { label: 'developer report', kind: 'firsthand' }
  ])
  assert.deepEqual(trace.artifactIndex?.items.map(({ path, kind }) => ({ path, kind })), [
    { path: '/tmp/codexdesktop-tasks/migration', kind: 'researchCapsule' },
    { path: '/tmp/codexdesktop-tasks/migration/evidence.jsonl', kind: 'generatedFile' }
  ])
})

test('isTurnTrace accepts durable schema 2 snapshots and current schema 3 traces', () => {
  assert.equal(isTurnTrace({ schemaVersion: 2, exportedAt: 'now', turn: { id: 'turn' }, thread: {}, timeline: [] }), true)
  assert.equal(isTurnTrace({ schemaVersion: 3, exportedAt: 'now', turn: { id: 'turn' }, thread: {}, timeline: [] }), true)
  assert.equal(isTurnTrace({ schemaVersion: 1, exportedAt: 'now', turn: { id: 'turn' }, thread: {}, timeline: [] }), false)
})
