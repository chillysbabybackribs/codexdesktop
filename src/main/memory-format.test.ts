import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildInjectedMemory,
  buildLastChatMarkdown,
  buildTranscriptMarkdown,
  shouldLoadLastChatMemory,
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
    { user: 'Should we implement it?', assistant: 'Implemented the small formatter change.' }
  ]
}

test('continuation detection stays narrow', () => {
  assert.equal(shouldLoadLastChatMemory('Continue where we left off'), true)
  assert.equal(shouldLoadLastChatMemory('What did we discuss in the previous chat?'), true)
  assert.equal(shouldLoadLastChatMemory('Continue with the CSS refactor'), false)
  assert.equal(shouldLoadLastChatMemory('Start a new unrelated task'), false)
})

test('last-chat memory keeps a recent progression and substantive earlier milestones', () => {
  const markdown = buildLastChatMarkdown(snapshot, '/memory/chats/thread-1.md')
  assert.match(markdown, /Latest request: Should we implement it\?/)
  assert.match(markdown, /T02 — Can older chapters be found\?.*Keep a one-line milestone map/)
  assert.doesNotMatch(markdown, /Can older chapters be found\?.*:\*\* Yes\./)
  assert.match(markdown, /## Earlier milestones/)
  assert.match(markdown, /Full transcript: \/memory\/chats\/thread-1\.md/)
})

test('transcript uses unique turn markers and preserves completed text', () => {
  const markdown = buildTranscriptMarkdown(snapshot)
  assert.match(markdown, /<!-- codexdesktop-turn:C02:start -->/)
  assert.match(markdown, /## Turn C02 — Can older chapters be found\?/)
  assert.match(markdown, /Keep a one-line milestone map and a full transcript\./)
  assert.match(markdown, /<!-- codexdesktop-turn:C02:end -->/)
})

test('injected memory states precedence explicitly', () => {
  const injected = buildInjectedMemory('# Previous chat\nOld state')
  assert.match(injected, /current user message and newer decisions always take precedence/i)
  assert.match(injected, /# Previous chat/)
})
