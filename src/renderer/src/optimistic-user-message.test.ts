import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOptimisticUserMessage, stripOptimisticUserMessage } from './optimistic-user-message.ts'

test('first send can render text and attachments before thread startup resolves', () => {
  const item = buildOptimisticUserMessage('optimistic-1', 'hello', [{
    id: 'file-1',
    kind: 'file',
    name: 'notes.txt',
    path: '/tmp/notes.txt',
    mediaType: 'text/plain',
    size: 12
  }])

  assert.equal(item.type, 'userMessage')
  assert.deepEqual(item.content.map((content) => content.type), ['text', 'mention'])
})

test('authoritative user item atomically replaces the optimistic row', () => {
  const optimistic = buildOptimisticUserMessage('optimistic-1', 'hello', [])
  const authoritative = { ...optimistic, id: 'server-user-1' }

  assert.deepEqual(
    stripOptimisticUserMessage([optimistic], optimistic.id, [authoritative]),
    []
  )
  assert.deepEqual(stripOptimisticUserMessage([optimistic], optimistic.id, []), [optimistic])
})
