import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAuditPrompt, shouldTriggerAudit, turnChangedFiles } from './audit-trigger.ts'
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
