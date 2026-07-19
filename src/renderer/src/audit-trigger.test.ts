import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditBriefMarkdown,
  auditSummaryLabel,
  buildAuditPrompt,
  isAuditPrompt,
  liveTurnGlance,
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

test('audit fires for any turn with substance; only empty turns and busy auditors skip', () => {
  assert.equal(shouldTriggerAudit({ auditorStatus: 'idle', auditorTurnId: null, changedFiles: ['a.ts'] }), true)
  assert.equal(shouldTriggerAudit({ auditorStatus: 'done', auditorTurnId: null, changedFiles: ['a.ts'] }), true)
  assert.equal(
    shouldTriggerAudit({ auditorStatus: 'idle', auditorTurnId: null, changedFiles: [], answerText: 'Here is an idea…' }),
    true,
    'chat-only turns audit too — second viewpoint during brainstorming'
  )
  assert.equal(
    shouldTriggerAudit({ auditorStatus: 'idle', auditorTurnId: null, changedFiles: [], answerText: '', stepCount: 2 }),
    true,
    'tool-only turns still audit'
  )
  assert.equal(
    shouldTriggerAudit({ auditorStatus: 'idle', auditorTurnId: null, changedFiles: [], answerText: '  ', stepCount: 0 }),
    false,
    'turns with nothing to review never audit'
  )
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

test('chat-only turns get the second-opinion flavor with the answer embedded', () => {
  const prompt = buildAuditPrompt({
    userText: 'brainstorm names for the feature',
    files: [],
    answerText: 'Here are three ideas:\n\n1. Pairwise\n2. Shadow\n3. Copilot'
  })
  assert.match(prompt, /The main chat answered:\n {2}Here are three ideas:/)
  assert.match(prompt, /second opinion on the answer/)
  assert.match(prompt, /trivial \(a greeting or small acknowledgment\), reply in a few words/)
  assert.ok(!prompt.includes('The turn changed'), 'no file section on chat-only turns')
  assert.ok(!prompt.includes('git diff HEAD'), 'no diff instructions on chat-only turns')
  assert.ok(!prompt.includes('\n\n'), 'answer blank lines are squashed')
})

test('the detection-unavailable note rides into the prompt for non-git workspaces', () => {
  const prompt = buildAuditPrompt({ userText: 'do it', files: [], answerText: 'done', detectionUnavailable: true })
  assert.match(prompt, /file-change detection is unavailable here/)
  const gitPrompt = buildAuditPrompt({ userText: 'do it', files: ['a.ts'], answerText: 'done' })
  assert.ok(!gitPrompt.includes('detection is unavailable'))
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

test('auditSummaryLabel headlines file count + names', () => {
  assert.equal(auditSummaryLabel([]), 'no files changed')
  assert.equal(auditSummaryLabel(['src/codex-config.ts']), 'codex-config.ts')
  assert.equal(auditSummaryLabel(['a/x.ts', 'b/y.ts']), 'x.ts, y.ts')
  assert.equal(auditSummaryLabel(['src/codex-config.ts', 'b.ts', 'c.ts']), 'codex-config.ts +2 more')
})

test('isAuditPrompt recognizes only the auto-audit marker', () => {
  assert.equal(isAuditPrompt('[auto-audit] The main chat just completed a turn'), true)
  assert.equal(isAuditPrompt('fix the tests'), false)
  assert.equal(isAuditPrompt('  [auto-audit] leading space'), false, 'marker must lead')
})

test('parseAuditPrompt round-trips buildAuditPrompt for the restore path', () => {
  const prompt = buildAuditPrompt({
    userText: 'fix the screenshot error',
    files: ['src/codex-config.ts', 'src/foo.ts'],
    steps: ['$ npm test (exit 1)', 'edited: src/codex-config.ts', '$ npm test (exit 0)']
  })
  const parsed = parseAuditPrompt(prompt)
  assert.equal(parsed.userText, 'fix the screenshot error')
  assert.deepEqual(parsed.files, ['src/codex-config.ts', 'src/foo.ts'])
  assert.deepEqual(parsed.steps, ['$ npm test (exit 1)', 'edited: src/codex-config.ts', '$ npm test (exit 0)'])
})

test('parseAuditPrompt drops the "and N more" placeholder from the clipped file list', () => {
  const prompt = buildAuditPrompt({
    userText: 'big refactor',
    files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts']
  })
  const parsed = parseAuditPrompt(prompt)
  // Only the 6 shown paths are recoverable from prose; "and 2 more" is not a path.
  assert.deepEqual(parsed.files, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'])
  assert.equal(auditSummaryLabel(parsed.files), 'a.ts +5 more')
})

test('auditBriefMarkdown renders the briefing as sectioned markdown', () => {
  const md = auditBriefMarkdown({
    userText: 'fix the tests',
    files: ['a.ts', 'b.ts'],
    steps: ['$ npm test (exit 1)', 'edited: a.ts']
  })
  assert.match(md, /## Request\n\nfix the tests/)
  assert.match(md, /## Changed files\n\n- `a\.ts`\n- `b\.ts`/)
  assert.match(md, /## Steps\n\n1\. `\$ npm test \(exit 1\)`\n2\. `edited: a\.ts`/)
  assert.equal(auditBriefMarkdown({ userText: '', files: [], steps: [] }), '_No details captured._')
})

test('liveTurnGlance reports true counts and the genuinely-latest step, uncapped', () => {
  const items = [
    ...Array.from({ length: 25 }, (_, index) =>
      ({ type: 'commandExecution', id: `c${index}`, command: `step ${index}`, exitCode: 0, status: 'completed', aggregatedOutput: '' })),
    fileChange('f1', ['src/a.ts', 'src/b.ts'])
  ] as unknown as ChatItem[]
  const meta = Object.fromEntries(items.map((item) => [item.id, { turnId: 't1' }]))
  const glance = liveTurnGlance(items, meta, 't1')
  assert.equal(glance.turnId, 't1')
  assert.equal(glance.stepCount, 26, 'no 20-line cap, no overflow summary line')
  assert.equal(glance.fileCount, 2)
  assert.equal(glance.lastStep, 'edited: src/a.ts, src/b.ts')
  const idle = liveTurnGlance(items, meta, 'other-turn')
  assert.deepEqual(idle, { turnId: 'other-turn', stepCount: 0, fileCount: 0, lastStep: null })
})

test('parseAuditPrompt handles a prompt with no step log', () => {
  const prompt = buildAuditPrompt({ userText: 'quick fix', files: ['a.ts'] })
  const parsed = parseAuditPrompt(prompt)
  assert.equal(parsed.userText, 'quick fix')
  assert.deepEqual(parsed.files, ['a.ts'])
  assert.deepEqual(parsed.steps, [])
})
