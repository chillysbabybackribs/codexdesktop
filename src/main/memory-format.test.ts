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
    { user: 'Can older chapters be found?', assistant: 'Keep a one-line chapter map and a full transcript.' }
  ]
}

test('continuation detection stays narrow', () => {
  assert.equal(shouldLoadLastChatMemory('Continue where we left off'), true)
  assert.equal(shouldLoadLastChatMemory('What did we discuss in the previous chat?'), true)
  assert.equal(shouldLoadLastChatMemory('Continue with the CSS refactor'), false)
  assert.equal(shouldLoadLastChatMemory('Start a new unrelated task'), false)
})

test('last-chat memory emphasizes the tail and points to earlier chapters', () => {
  const markdown = buildLastChatMarkdown(snapshot, '/memory/chats/thread-1.md')
  assert.match(markdown, /The latest request was: Can older chapters be found\?/)
  assert.match(markdown, /C01 — How should memory work\?/)
  assert.match(markdown, /Full transcript: \/memory\/chats\/thread-1\.md/)
})

test('transcript preserves completed user and assistant text', () => {
  const markdown = buildTranscriptMarkdown(snapshot)
  assert.match(markdown, /## C02 — Can older chapters be found\?/)
  assert.match(markdown, /Keep a one-line chapter map and a full transcript\./)
})

test('injected memory states precedence explicitly', () => {
  const injected = buildInjectedMemory('# Previous chat\nOld state')
  assert.match(injected, /current user message and newer decisions always take precedence/i)
  assert.match(injected, /# Previous chat/)
})
