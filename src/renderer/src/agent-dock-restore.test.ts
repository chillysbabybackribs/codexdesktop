import assert from 'node:assert/strict'
import test from 'node:test'
import { liteMessagesFromItems } from './agent-dock-restore.ts'
import { buildAuditPrompt } from './audit-trigger.ts'
import type { ChatItem } from './transcript-model.ts'

const user = (id: string, text: string): ChatItem =>
  ({ type: 'userMessage', id, content: [{ type: 'text', text }] }) as unknown as ChatItem
const assistant = (id: string, text: string): ChatItem =>
  ({ type: 'agentMessage', id, text, phase: null, memoryCitation: null }) as unknown as ChatItem

test('liteMessagesFromItems collapses adjacent identical assistant items', () => {
  // Stream-restate artifact shape: the same reply persisted under two item
  // ids (threads recorded before the translator dedupe fix keep this forever).
  const messages = liteMessagesFromItems([
    user('u1', 'audit this'),
    assistant('a1', 'Looks solid.'),
    assistant('a2', 'Looks solid.'),
    assistant('a3', 'A different follow-up.')
  ])
  assert.deepEqual(
    messages.map(({ role, text }) => `${role}:${text}`),
    ['user:audit this', 'assistant:Looks solid.', 'assistant:A different follow-up.']
  )
})

test('liteMessagesFromItems keeps identical assistant texts that are not adjacent', () => {
  const messages = liteMessagesFromItems([
    assistant('a1', 'ok'),
    user('u1', 'again?'),
    assistant('a2', 'ok')
  ])
  assert.equal(messages.filter((message) => message.role === 'assistant').length, 2)
})

test('liteMessagesFromItems rebuilds the audit summary from a stored audit prompt', () => {
  const prompt = buildAuditPrompt({ userText: 'fix it', files: ['a.ts'], steps: ['$ npm test (exit 0)'] })
  const messages = liteMessagesFromItems([user('u1', prompt)])
  assert.equal(messages.length, 1)
  assert.ok(messages[0].audit, 'audit summary reconstructed')
  assert.deepEqual(messages[0].audit?.files, ['a.ts'])
  assert.equal(messages[0].audit?.userText, 'fix it')
})
