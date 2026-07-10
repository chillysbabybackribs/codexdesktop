import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem.ts'
import { buildTurnTrace } from './trace.ts'

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
  assert.equal(trace.capture.completeness, 'complete')
  assert.equal(trace.turn.durationMs, 1_000)
  assert.equal(trace.summary.itemCount, 3)
  assert.equal(trace.summary.toolCallCount, 1)
  assert.equal(trace.summary.browserToolCount, 1)
  assert.deepEqual(trace.skills, [
    { name: 'artifact-first-web-research', path: '/skills/artifact-first-web-research/SKILL.md' }
  ])
  assert.equal(trace.timeline[1]?.status, 'completed')
})
