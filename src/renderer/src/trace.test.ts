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

const modelCallSample = {
  sequence: 1,
  atMs: 1_500,
  usage: turnUsage,
  uncachedInputTokens: 400,
  contextWindow: 200_000,
  contextPercent: 0.4,
  inputDeltaFromPrevious: null,
  compactedBeforeCall: false,
  precedingItem: {
    itemId: 'browser-current',
    itemType: 'dynamicToolCall',
    label: 'browser_run',
    argumentChars: 34,
    resultChars: 19
  }
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
      reasoningEffort: 'xhigh',
      workspace: '/workspace',
      goalAtStart: {
        threadId: 'thread-1',
        objective: 'Compare recent firsthand migration reports',
        status: 'active',
        tokenBudget: 10_000,
        tokensUsed: 200,
        timeUsedSeconds: 3,
        createdAt: 1,
        updatedAt: 2
      },
      goalAtEnd: {
        threadId: 'thread-1',
        objective: 'Compare recent firsthand migration reports',
        status: 'complete',
        tokenBudget: 10_000,
        tokensUsed: 1_400,
        timeUsedSeconds: 8,
        createdAt: 1,
        updatedAt: 3
      },
      goalContinuation: true,
      goalContinuationInferred: true,
      startedAtMs: 1_000,
      completedAtMs: 2_000,
      tokens: {
        turn: turnUsage,
        latestCall: turnUsage,
        threadTotalAtEnd: cumulativeUsage,
        modelContextWindow: 200_000,
        modelCallCount: 3,
        modelCalls: [modelCallSample],
        droppedModelCallSamples: 2
      }
    }
  })

  assert.equal(trace.thread.title, 'Compare recent reports')
  assert.equal(trace.prompt, 'Compare the recent reports.')
  assert.equal(trace.finalResponse, 'Here are the findings.')
  assert.equal(trace.environment.model, 'gpt-5.4')
  assert.equal(trace.environment.reasoningEffort, 'xhigh')
  assert.equal(trace.environment.workspace, '/workspace')
  assert.deepEqual(trace.usage.turn, turnUsage)
  assert.deepEqual(trace.usage.latestModelCall, turnUsage)
  assert.deepEqual(trace.usage.threadTotalAtEnd, cumulativeUsage)
  assert.equal(trace.usage.modelCallCount, 3)
  assert.equal(trace.schemaVersion, 5)
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
  assert.deepEqual(trace.usage.modelCalls, [modelCallSample])
  assert.equal(trace.usage.droppedModelCallSamples, 2)
  assert.equal(trace.timing?.wallDurationMs, 1_000)
  assert.equal(trace.timing?.attributedDurationMs, 250)
  assert.equal(trace.timing?.unattributedDurationMs, 750)
  assert.equal(trace.timing?.attributionPercent, 25)
  assert.deepEqual(trace.skills, [
    { name: 'artifact-first-web-research', path: '/skills/artifact-first-web-research/SKILL.md' }
  ])
  assert.equal(trace.timeline[1]?.status, 'completed')
  assert.equal(trace.goal?.statusAtStart, 'active')
  assert.equal(trace.goal?.statusAtEnd, 'complete')
  assert.equal(trace.goal?.tokensUsedDelta, 1_200)
  assert.equal(trace.goal?.continuation, true)
  assert.equal(trace.goal?.continuationInferred, true)
  assert.equal(trace.goal?.completionClaimed, true)
  assert.equal(trace.goal?.observedCompletionEvidence.successfulStructuredToolCount, 1)
  assert.equal(trace.goal?.observedCompletionEvidence.finalResponsePresent, true)
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
        modelCallCount: 1,
        modelCalls: [],
        droppedModelCallSamples: 0
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

test('research tool artifacts contribute to observed goal evidence', () => {
  const artifactDir = '/home/dp/.config/codexdesktop/research/run-1'
  const items: ThreadItem[] = [
    {
      type: 'dynamicToolCall',
      id: 'research-1',
      namespace: null,
      tool: 'research_web',
      arguments: { queries: ['Electron migration'] },
      status: 'completed',
      contentItems: [{
        type: 'inputText',
        text: JSON.stringify({
          ok: true,
          artifactDir,
          pages: [{
            artifactPath: `${artifactDir}/page-01.txt`,
            htmlPath: `${artifactDir}/page-01.html`
          }]
        })
      }],
      success: true,
      durationMs: 400
    },
    {
      type: 'agentMessage',
      id: 'answer-1',
      text: 'Done.',
      phase: 'final_answer',
      memoryCitation: null
    }
  ]

  const trace = buildTurnTrace({
    threadId: 'thread-1',
    threadTitle: 'Migration research',
    turnId: 'turn-1',
    model: 'gpt-5.5',
    workspace: '/workspace',
    items,
    itemMeta: {
      'research-1': { turnId: 'turn-1' },
      'answer-1': { turnId: 'turn-1' }
    },
    meta: {
      status: 'completed',
      goalAtStart: {
        threadId: 'thread-1',
        objective: 'Research migration reports',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1
      }
    }
  })

  assert.equal(trace.artifactIndex?.items.length, 3)
  assert.equal(trace.goal?.observedCompletionEvidence.artifactCount, 3)
  assert.equal(trace.goal?.observedCompletionEvidence.successfulResearchToolCount, 1)
})

test('dedicated browser screenshots are indexed without their image payload', () => {
  const screenshotPath = '/home/dp/.config/codexdesktop/cdp-artifacts/screenshot-test.png'
  const items: ThreadItem[] = [{
    type: 'dynamicToolCall',
    id: 'screenshot-1',
    namespace: null,
    tool: 'browser_screenshot',
    arguments: {},
    status: 'completed',
    contentItems: [
      {
        type: 'inputText',
        text: JSON.stringify({
          screenshot: { artifactPath: screenshotPath, bytes: 72, mediaType: 'image/png' }
        })
      },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,ignored-by-trace' }
    ],
    success: true,
    durationMs: 12
  }]

  const trace = buildTurnTrace({
    threadId: 'thread-1',
    threadTitle: 'Capture screenshot',
    turnId: 'turn-1',
    model: 'gpt-5.5',
    workspace: '/workspace',
    items,
    itemMeta: { 'screenshot-1': { turnId: 'turn-1' } },
    meta: { status: 'completed', origin: 'live', model: 'gpt-5.5' }
  })

  assert.deepEqual(trace.artifactIndex?.items.map(({ path, kind }) => ({ path, kind })), [
    { path: screenshotPath, kind: 'generatedFile' }
  ])
})

test('nested CDP response-body artifacts are indexed from browser agent envelopes', () => {
  const artifactPath = '/home/dp/.config/codexdesktop/cdp-artifacts/response-body-test.json'
  const items: ThreadItem[] = [{
    type: 'dynamicToolCall',
    id: 'body-1',
    namespace: null,
    tool: 'browser_cdp',
    arguments: { operation: 'networkBody', requestId: 'request-1' },
    status: 'completed',
    contentItems: [{
      type: 'inputText',
      text: JSON.stringify({ ok: true, result: { responseBody: { artifactPath, kind: 'response-body', bytes: 12 } } })
    }],
    success: true,
    durationMs: 8
  }]

  const trace = buildTurnTrace({
    threadId: 'thread-1',
    threadTitle: 'Capture response body',
    turnId: 'turn-1',
    model: 'gpt-5.5',
    workspace: '/workspace',
    items,
    itemMeta: { 'body-1': { turnId: 'turn-1' } },
    meta: { status: 'completed', origin: 'live', model: 'gpt-5.5' }
  })

  assert.deepEqual(trace.artifactIndex?.items.map(({ path, kind }) => ({ path, kind })), [
    { path: artifactPath, kind: 'generatedFile' }
  ])
})

test('oversized browser-run result artifacts are indexed from the tool envelope', () => {
  const artifactPath = '/home/dp/.config/codexdesktop/cdp-artifacts/browser-result-test.json'
  const items: ThreadItem[] = [{
    type: 'dynamicToolCall',
    id: 'browser-run-1',
    namespace: null,
    tool: 'browser_run',
    arguments: { code: 'return window.largePayload' },
    status: 'completed',
    contentItems: [{
      type: 'inputText',
      text: JSON.stringify({ ok: true, result: 'compact preview', artifact: { artifactPath, kind: 'browser-result', bytes: 12 } })
    }],
    success: true,
    durationMs: 8
  }]

  const trace = buildTurnTrace({
    threadId: 'thread-1',
    threadTitle: 'Capture browser result',
    turnId: 'turn-1',
    model: 'gpt-5.5',
    workspace: '/workspace',
    items,
    itemMeta: { 'browser-run-1': { turnId: 'turn-1' } },
    meta: { status: 'completed', origin: 'live', model: 'gpt-5.5' }
  })

  assert.deepEqual(trace.artifactIndex?.items.map(({ path, kind }) => ({ path, kind })), [
    { path: artifactPath, kind: 'generatedFile' }
  ])
})

test('isTurnTrace accepts durable schema 2-4 snapshots and current schema 5 traces', () => {
  assert.equal(isTurnTrace({ schemaVersion: 2, exportedAt: 'now', turn: { id: 'turn' }, thread: {}, timeline: [] }), true)
  assert.equal(isTurnTrace({ schemaVersion: 3, exportedAt: 'now', turn: { id: 'turn' }, thread: {}, timeline: [] }), true)
  assert.equal(isTurnTrace({ schemaVersion: 4, exportedAt: 'now', turn: { id: 'turn' }, thread: {}, timeline: [] }), true)
  assert.equal(isTurnTrace({ schemaVersion: 5, exportedAt: 'now', turn: { id: 'turn' }, thread: {}, timeline: [] }), true)
  assert.equal(isTurnTrace({ schemaVersion: 1, exportedAt: 'now', turn: { id: 'turn' }, thread: {}, timeline: [] }), false)
})
