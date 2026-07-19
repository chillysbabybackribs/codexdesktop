import assert from 'node:assert/strict'
import test from 'node:test'
import {
  auditBriefMarkdown,
  auditSummaryLabel,
  buildAuditFeedbackMessage,
  buildAuditPrompt,
  isAuditFeedback,
  isAuditPrompt,
  liveTurnGlance,
  parseAuditFeedback,
  parseAuditPrompt,
  parseAuditVerdict,
  shouldSendAuditFeedback,
  shouldTriggerAudit,
  stripVerdictLine,
  turnAnswerText,
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
    steps: ['$ npm test (exit 1)', 'edited: a.ts'],
    answerText: 'All green now.'
  })
  assert.match(md, /## Request\n\nfix the tests/)
  assert.match(md, /## Changed files\n\n- `a\.ts`\n- `b\.ts`/)
  assert.match(md, /## Steps\n\n1\. `\$ npm test \(exit 1\)`\n2\. `edited: a\.ts`/)
  assert.match(md, /## Answer\n\nAll green now\./)
  assert.equal(auditBriefMarkdown({ userText: '', files: [], steps: [], answerText: '' }), '_No details captured._')
})

test('turnAnswerText picks the last non-empty agent message of the turn, clipped', () => {
  const items = [
    { type: 'agentMessage', id: 'm1', text: 'thinking out loud', phase: null, memoryCitation: null },
    { type: 'agentMessage', id: 'm2', text: 'Final answer.', phase: null, memoryCitation: null },
    { type: 'agentMessage', id: 'other', text: 'different turn', phase: null, memoryCitation: null }
  ] as unknown as ChatItem[]
  const meta = { m1: { turnId: 't1' }, m2: { turnId: 't1' }, other: { turnId: 't2' } }
  assert.equal(turnAnswerText(items, meta, 't1'), 'Final answer.')
  assert.equal(turnAnswerText(items, meta, 't3'), '')
  const long = [{ type: 'agentMessage', id: 'l1', text: 'y'.repeat(3000), phase: null, memoryCitation: null }] as unknown as ChatItem[]
  assert.equal(turnAnswerText(long, { l1: { turnId: 't1' } }, 't1').length, 1501, 'clipped with ellipsis')
})

test('parseAuditPrompt recovers the answer for the restore path', () => {
  const prompt = buildAuditPrompt({
    userText: 'brainstorm',
    files: [],
    answerText: 'Idea one.\nIdea two.'
  })
  const parsed = parseAuditPrompt(prompt)
  assert.equal(parsed.answerText, 'Idea one.\nIdea two.')
  assert.deepEqual(parsed.files, [])
  // Steps + answer + files together still parse cleanly.
  const full = buildAuditPrompt({
    userText: 'do it',
    files: ['a.ts'],
    steps: ['$ ls (exit 0)'],
    answerText: 'Done.'
  })
  const parsedFull = parseAuditPrompt(full)
  assert.deepEqual(parsedFull.steps, ['$ ls (exit 0)'])
  assert.deepEqual(parsedFull.files, ['a.ts'])
  assert.equal(parsedFull.answerText, 'Done.')
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
  assert.equal(glance.lastStep, 'Edited a.ts, b.ts', 'narrated, not the raw step-log line')
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

test('the audit prompt demands a machine-readable verdict in both flavors', () => {
  assert.match(buildAuditPrompt({ userText: 'x', files: ['a.ts'] }), /"VERDICT: pass".*"VERDICT: flag"/)
  assert.match(buildAuditPrompt({ userText: 'x', files: [], answerText: 'idea' }), /"VERDICT: pass".*"VERDICT: flag"/)
})

test('parseAuditVerdict reads the last verdict line; stripVerdictLine removes it', () => {
  assert.equal(parseAuditVerdict('Looks solid.\nVERDICT: pass'), 'pass')
  assert.equal(parseAuditVerdict('Bug in a.ts.\nverdict: FLAG'), 'flag', 'case-insensitive')
  assert.equal(parseAuditVerdict('Discussing VERDICT: pass mid-sentence counts only at line start'), null)
  assert.equal(parseAuditVerdict('First take.\nVERDICT: flag\nOn reflection…\nVERDICT: pass'), 'pass', 'last one wins')
  assert.equal(parseAuditVerdict('No verdict here.'), null)
  assert.equal(stripVerdictLine('Bug found.\nVERDICT: flag'), 'Bug found.')
  assert.equal(stripVerdictLine('No verdict.'), 'No verdict.')
})

test('audit feedback message carries the report without the verdict line', () => {
  const message = buildAuditFeedbackMessage({ agentTitle: 'Agent 2', report: 'Off-by-one in loop.\nVERDICT: flag' })
  assert.ok(isAuditFeedback(message))
  assert.match(message, /Agent 2 reviewed the last turn and flagged issues:/)
  assert.match(message, /Off-by-one in loop\./)
  assert.ok(!message.includes('VERDICT'), 'verdict line is machine plumbing, not doer input')
  assert.match(message, /push back with a reason/)
  assert.equal(isAuditFeedback('hello'), false)
})

test('feedback sends only on flag, idle, same thread, within the bounce cap', () => {
  const base = {
    verdict: 'flag' as const,
    reportsToMain: true,
    mainIdle: true,
    sameThread: true,
    auditedTurnWasFeedback: false,
    loopMayContinue: false
  }
  assert.equal(shouldSendAuditFeedback(base), true)
  assert.equal(shouldSendAuditFeedback({ ...base, verdict: 'pass' }), false, 'pass converges the loop')
  assert.equal(shouldSendAuditFeedback({ ...base, verdict: null }), false, 'missing verdicts fail quiet')
  assert.equal(shouldSendAuditFeedback({ ...base, reportsToMain: false }), false)
  assert.equal(shouldSendAuditFeedback({ ...base, mainIdle: false }), false, 'never interrupts a working doer')
  assert.equal(shouldSendAuditFeedback({ ...base, sameThread: false }), false, 'never crosses threads')
  assert.equal(shouldSendAuditFeedback({ ...base, auditedTurnWasFeedback: true }), false, 'capped without controller approval')
  assert.equal(
    shouldSendAuditFeedback({ ...base, auditedTurnWasFeedback: true, loopMayContinue: true }),
    true,
    'controller-approved fix rounds pass the cap'
  )
})

test('parseAuditFeedback recovers title and body for the main-chat card', () => {
  const message = buildAuditFeedbackMessage({ agentTitle: 'Agent 2', report: 'Off-by-one in loop.\nVERDICT: flag' })
  const parsed = parseAuditFeedback(message)
  assert.equal(parsed?.agentTitle, 'Agent 2')
  assert.equal(parsed?.report, 'Off-by-one in loop.')
  assert.equal(parseAuditFeedback('a normal user message'), null)
})
