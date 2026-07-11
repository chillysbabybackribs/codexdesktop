import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLastChatMarkdown,
  buildTranscriptMarkdown,
  type MemorySnapshot
} from './memory-format.ts'

const snapshot: MemorySnapshot = {
  threadId: 'thread-1',
  title: 'Memory design',
  workspace: '/tmp/project',
  updatedAt: '2026-07-11T12:00:00.000Z',
  turns: [
    { user: 'How should memory work?', assistant: 'Use a compact Markdown checkpoint.' },
    { user: 'Can older chapters be found?', assistant: 'Yes. Keep a one-line milestone map and a full transcript.' },
    { user: 'What is the current decision?', assistant: 'The formatter will preserve a detailed recent tail.' },
    {
      user: 'Should we implement it?',
      assistant: 'Implemented the small formatter change.',
      completedWork: ['5/5 tests passed, 0 failed: npm test']
    }
  ]
}

test('last-chat memory keeps a recent progression and substantive earlier milestones', () => {
  const markdown = buildLastChatMarkdown(snapshot, '/memory/chats/thread-1.md')
  assert.match(markdown, /Latest request: Should we implement it\?/)
  assert.match(markdown, /T02 — Can older chapters be found\?.*Keep a one-line milestone map/)
  assert.doesNotMatch(markdown, /Can older chapters be found\?.*:\*\* Yes\./)
  assert.match(markdown, /## Earlier milestones/)
  assert.match(markdown, /Latest completed work:[\s\S]*5\/5 tests passed, 0 failed/)
  assert.match(markdown, /Full transcript: \/memory\/chats\/thread-1\.md/)
})

test('transcript uses unique turn markers and preserves completed text', () => {
  const markdown = buildTranscriptMarkdown(snapshot)
  assert.match(markdown, /<!-- codexdesktop-turn:thread-1:C02:start -->/)
  assert.match(markdown, /## Turn C02 — Can older chapters be found\?/)
  assert.match(markdown, /Keep a one-line milestone map and a full transcript\./)
  assert.match(markdown, /<!-- codexdesktop-turn:thread-1:C02:end -->/)
  assert.match(markdown, /### Completed work[\s\S]*5\/5 tests passed, 0 failed/)
})
