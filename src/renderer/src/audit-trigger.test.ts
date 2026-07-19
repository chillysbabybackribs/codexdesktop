import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditSummaryLabel,
  buildAuditPrompt,
  isAuditPrompt,
  parseAuditPrompt,
  shouldTriggerAudit,
  turnChangedFiles,
  turnStepLines
} from './audit-trigger.ts'
import type { ChatItem } from './transcript-model.ts'

const fileChange = (id: string, paths: string[]): ChatItem =>
  ({ type: 'fileChange', id, status: 'completed', changes: paths.map((path) => ({ path, kind: { type: 'update' }, diff: '' })) }) as unknown as ChatItem

test('turnChangedFiles collects unique paths for exactly the completed turn', () => {
  const items: ChatItem[] = [
    fileChange('f1', ['src/a.ts', 'src/b.ts']),
    fileChange('f2', ['src/b.ts', 'src/c.ts']),
    fileChange('other-turn', ['src/z.ts']),
    { type: 'agentMessage', id: 'm1', text: 'done', phase: null, memoryCitation: null } as ChatItem
  ]
  const meta = {
    f1: { turnId: 'turn-1' },
    f2: { turnId: 'turn-1' },
    'other-turn': { turnId: 'turn-2' },
    m1: { turnId: 'turn-1' }
  }
  assert.deepEqual(turnChangedFiles(items, meta, 'turn-1').sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  assert.deepEqual(turnChangedFiles(items, meta, 'turn-3'), [])
})

test('audit fires only for file-changing turns and idle auditors', () => {
  assert.equal(shouldTriggerAudit({ auditorStatus: 'idle', auditorTurnId: null, changedFiles: ['a.ts'] }), true)
  assert.equal(shouldTriggerAudit({ auditorStatus: 'done', auditorTurnId: null, changedFiles: ['a.ts'] }), true)
  assert.equal(shouldTriggerAudit({ auditorStatus: 'idle', auditorTurnId: null, changedFiles: [] }), false, 'chat-only turns never audit')
  assert.equal(shouldTriggerAudit({ auditorStatus: 'working', auditorTurnId: 't', changedFiles: ['a.ts'] }), false, 'busy auditors are skipped, not queued')
})

test('the audit prompt is compact, lists files, and directs the auditor at the workspace', () => {
  const prompt = buildAuditPrompt({
    userText: '  refactor   the auth flow\nand keep sessions working  ',
    files: ['auth.ts', 'session.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']
  })
  assert.match(prompt, /refactor the auth flow and keep sessions working/)
  assert.match(prompt, /changed 8 file\(s\)/)
  assert.match(prompt, /and 2 more/)
  assert.match(prompt, /git diff HEAD/)
  assert.match(prompt, /AUDIT\.md/)
  assert.ok(!prompt.includes('\n\n'), 'stays compact')
  const longPrompt = buildAuditPrompt({ userText: 'x'.repeat(500), files: ['a.ts'] })
  assert.match(longPrompt, /…/)
})

test('turnStepLines builds an ordered, clipped step log from work items', () => {
  const items = [
    { type: 'commandExecution', id: 'c1', command: 'npm test', exitCode: 0, status: 'completed', aggregatedOutput: '' },
    fileChange('f1', ['src/app.ts']),
    { type: 'commandExecution', id: 'c2', command: 'x'.repeat(200), exitCode: 1, status: 'failed', aggregatedOutput: '' },
    { type: 'agentMessage', id: 'm1', text: 'done', phase: null, memoryCitation: null }
  ] as unknown as ChatItem[]
  const meta = { c1: { turnId: 't1' }, f1: { turnId: 't1' }, c2: { turnId: 't1' }, m1: { turnId: 't1' } }
  const lines = turnStepLines(items, meta, 't1')
  assert.equal(lines[0], '$ npm test (exit 0)')
  assert.equal(lines[1], 'edited: src/app.ts')
  assert.match(lines[2], /^\$ x+…/)
  assert.equal(lines.length, 3, 'agent messages are not steps')
})

test('turnStepLines caps the log and summarizes the overflow', () => {
  const items = Array.from({ length: 30 }, (_, index) =>
    ({ type: 'commandExecution', id: `c${index}`, command: `step ${index}`, exitCode: 0, status: 'completed', aggregatedOutput: '' })) as unknown as ChatItem[]
  const meta = Object.fromEntries(items.map((item) => [item.id, { turnId: 't1' }]))
  const lines = turnStepLines(items, meta, 't1')
  assert.equal(lines.length, 20)
  assert.match(lines.at(-1) ?? '', /and 11 more steps/)
})

test('the audit prompt embeds the step log between request and file list', () => {
  const prompt = buildAuditPrompt({
    userText: 'fix the tests',
    files: ['a.ts'],
    steps: ['$ npm test (exit 1)', 'edited: a.ts', '$ npm test (exit 0)']
  })
  assert.match(prompt, /Steps the main chat took, in order:\n {2}\$ npm test \(exit 1\)\n {2}edited: a\.ts/)
  assert.match(prompt, /decide depth/)
  const without = buildAuditPrompt({ userText: 'x', files: ['a.ts'] })
  assert.ok(!without.includes('Steps the main chat took'))
})
