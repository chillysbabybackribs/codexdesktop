import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadItem } from '../../shared/session-protocol/index.ts'
import type { ItemMeta, TurnPlanItem, WorkItem } from './activity-model.ts'
import type { TurnMeta, TurnTokenTelemetry } from './turn-telemetry.ts'
import { currentActionLabel, activityFeedLines, isBrowseAction, tokenTooltip, turnSummaryParts } from './turn-summary.ts'

type CommandExecutionItem = Extract<ThreadItem, { type: 'commandExecution' }>
type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>
type McpToolCallItem = Extract<ThreadItem, { type: 'mcpToolCall' }>

const commandItem = (over: Partial<CommandExecutionItem> = {}): CommandExecutionItem => ({
  type: 'commandExecution',
  id: 'cmd-1',
  command: 'echo hi',
  cwd: '/ws',
  processId: null,
  source: 'agent',
  status: 'completed',
  commandActions: [],
  aggregatedOutput: null,
  exitCode: 0,
  durationMs: null,
  ...over
})

const fileItem = (over: Partial<FileChangeItem> = {}): FileChangeItem => ({
  type: 'fileChange',
  id: 'file-1',
  changes: [],
  status: 'completed',
  ...over
})

const mcpItem = (over: Partial<McpToolCallItem> = {}): McpToolCallItem => ({
  type: 'mcpToolCall',
  id: 'mcp-1',
  server: 'browser',
  tool: 'screenshot',
  status: 'completed',
  arguments: null,
  appContext: null,
  pluginId: null,
  result: null,
  error: null,
  durationMs: 100,
  ...over
})

const reasoningItem: WorkItem = {
  type: 'reasoning',
  id: 'thought-1',
  summary: ['Considering'],
  content: []
}

const turnPlanItem: TurnPlanItem = {
  type: 'turnPlan',
  id: 'plan-1',
  explanation: null,
  steps: [{ step: 'First', status: 'inProgress' }]
}

const usage = (
  over: Partial<TurnTokenTelemetry['turn']> = {}
): TurnTokenTelemetry['turn'] => ({
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  ...over
})

const telemetry = (over: Partial<TurnTokenTelemetry> = {}): TurnTokenTelemetry => ({
  turn: usage(),
  latestCall: usage(),
  threadTotalAtEnd: usage(),
  modelContextWindow: null,
  modelCallCount: 1,
  modelCalls: [],
  droppedModelCallSamples: 0,
  ...over
})

test('isBrowseAction classifies read/list/search but not unknown', () => {
  assert.equal(isBrowseAction({ type: 'read', command: 'cat a.ts', name: 'a.ts', path: '/ws/a.ts' }), true)
  assert.equal(isBrowseAction({ type: 'listFiles', command: 'ls', path: null }), true)
  assert.equal(isBrowseAction({ type: 'search', command: 'rg foo', query: 'foo', path: null }), true)
  assert.equal(isBrowseAction({ type: 'unknown', command: 'make' }), false)
})

test('currentActionLabel falls back to Writing/Working when nothing runs', () => {
  assert.equal(currentActionLabel([], {}, false), 'Working')
  assert.equal(currentActionLabel([], {}, true), 'Writing')
  assert.equal(currentActionLabel([commandItem({ status: 'completed' })], {}, false), 'Working')
})

test('currentActionLabel reports thinking for a live statusless newest item', () => {
  assert.equal(currentActionLabel([reasoningItem], {}, false), 'Thinking')
  // A completed reasoning item (per meta) is no longer the live action.
  assert.equal(
    currentActionLabel([reasoningItem], { 'thought-1': { turnId: 't1', completedAtMs: 5 } }, false),
    'Working'
  )
  // The turn plan is skipped, so reasoning stays the newest scannable item.
  assert.equal(currentActionLabel([reasoningItem, turnPlanItem], {}, false), 'Thinking')
})

test('currentActionLabel narrates browse-style commands from their actions', () => {
  const reading = commandItem({
    status: 'inProgress',
    commandActions: [{ type: 'read', command: 'cat main.ts', name: 'main.ts', path: '/ws/main.ts' }]
  })
  assert.equal(currentActionLabel([reading], {}, false), 'Reading main.ts')

  const searching = commandItem({
    status: 'inProgress',
    commandActions: [{ type: 'search', command: 'rg foo', query: 'foo', path: null }]
  })
  assert.equal(currentActionLabel([searching], {}, false), 'Searching "foo"')

  const listing = commandItem({
    status: 'inProgress',
    commandActions: [{ type: 'listFiles', command: 'ls src', path: '/ws/src' }]
  })
  assert.equal(currentActionLabel([listing], {}, false), 'Listing files')
})

test('currentActionLabel labels edits and tool calls by their target', () => {
  const editing = fileItem({
    status: 'inProgress',
    changes: [{ path: '/ws/src/app.ts', kind: { type: 'update', move_path: null }, diff: '' }]
  })
  assert.equal(currentActionLabel([editing], {}, false), 'Editing app.ts')
  assert.equal(currentActionLabel([fileItem({ status: 'inProgress' })], {}, false), 'Editing files')
  assert.equal(currentActionLabel([mcpItem({ status: 'inProgress' })], {}, false), 'Calling browser.screenshot')
})

test('currentActionLabel picks the newest running item, not settled ones', () => {
  const items: WorkItem[] = [
    commandItem({ id: 'cmd-old', status: 'completed' }),
    mcpItem({ status: 'inProgress' })
  ]
  assert.equal(currentActionLabel(items, {}, false), 'Calling browser.screenshot')
})

test('turnSummaryParts prefers the turn diff summary', () => {
  const meta: TurnMeta = { status: 'completed', diffSummary: { files: 2, adds: 10, dels: 3 } }
  assert.deepEqual(turnSummaryParts([], meta), ['2 files +10 −3'])
})

test('turnSummaryParts falls back to parsing file change diffs', () => {
  const items: WorkItem[] = [
    fileItem({
      changes: [
        {
          path: '/ws/a.ts',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1,2 +1,2 @@\n-old\n+new\n context'
        }
      ]
    })
  ]
  assert.deepEqual(turnSummaryParts(items, undefined), ['1 file +1 −1'])
})

test('turnSummaryParts counts commands, searches, tool calls, and tokens', () => {
  const items: WorkItem[] = [
    commandItem({ id: 'cmd-1' }),
    commandItem({ id: 'cmd-2' }),
    { type: 'webSearch', id: 'search-1', query: 'docs', action: null },
    mcpItem({ id: 'mcp-1' }),
    {
      type: 'dynamicToolCall',
      id: 'dyn-1',
      namespace: null,
      tool: 'browser_run',
      arguments: null,
      status: 'completed',
      contentItems: null,
      success: true,
      durationMs: 10
    }
  ]
  const meta: TurnMeta = { status: 'completed', tokens: telemetry({ turn: usage({ totalTokens: 1_500 }) }) }
  assert.deepEqual(turnSummaryParts(items, meta), [
    '2 commands',
    '1 search',
    '2 tool calls',
    '1.5k tokens'
  ])
})

test('activityFeedLines aggregates browse work and rotates the current line', () => {
  const reads = commandItem({
    id: 'read-1',
    status: 'completed',
    commandActions: [
      { type: 'read', command: 'cat a.ts', name: 'a.ts', path: '/ws/a.ts' },
      { type: 'read', command: 'cat b.ts', name: 'b.ts', path: '/ws/b.ts' }
    ]
  })
  const searching = commandItem({
    id: 'search-1',
    status: 'inProgress',
    commandActions: [{ type: 'search', command: 'rg foo', query: 'foo', path: null }]
  })
  const items: WorkItem[] = [reads, searching]

  assert.deepEqual(activityFeedLines(items, {}, false).map((line) => line.text), [
    'Explored 2 files',
    'Exploring 1 search'
  ])
})

test('activityFeedLines shows planning copy when the turn plan is active', () => {
  const items: WorkItem[] = [reasoningItem, turnPlanItem]
  assert.deepEqual(activityFeedLines(items, {}, false).map((line) => line.text), [
    'Planning next moves'
  ])
})

test('activityFeedLines skips redundant browse current labels', () => {
  const searching = commandItem({
    status: 'inProgress',
    commandActions: [{ type: 'search', command: 'rg foo', query: 'foo', path: null }]
  })
  assert.deepEqual(activityFeedLines([searching], {}, false).map((line) => line.text), ['Exploring 1 search'])
})

test('tokenTooltip summarizes per-turn usage with optional context window', () => {
  assert.equal(tokenTooltip(undefined), undefined)

  const tokens = telemetry({
    turn: usage({ totalTokens: 1_700, inputTokens: 800, cachedInputTokens: 400, outputTokens: 400, reasoningOutputTokens: 100 }),
    latestCall: usage({ totalTokens: 1_200 }),
    modelCallCount: 2,
    modelContextWindow: 200_000
  })
  assert.equal(
    tokenTooltip(tokens),
    '2 model calls · turn input 800 · cached 400 · output 400 · reasoning 100 · latest call 1.2k · context 200.0k'
  )

  const single = telemetry({ latestCall: usage({ totalTokens: 900 }), modelCallCount: 1 })
  assert.equal(
    tokenTooltip(single),
    '1 model call · turn input 0 · cached 0 · output 0 · reasoning 0 · latest call 900'
  )
})
