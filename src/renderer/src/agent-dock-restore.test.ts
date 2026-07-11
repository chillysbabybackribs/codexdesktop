import assert from 'node:assert/strict'
import test from 'node:test'
import { liteMessagesFromItems } from './agent-dock-restore.ts'
import type { ChatItem } from './transcript-model.ts'

test('lite agent transcript keeps only user and assistant messages', () => {
  const items: ChatItem[] = [
    {
      type: 'userMessage',
      id: 'user-1',
      content: [{ type: 'text', text: 'Question', text_elements: [] }]
    },
    {
      type: 'agentMessage',
      id: 'assistant-1',
      text: 'Answer',
      phase: 'final_answer',
      memoryCitation: null
    },
    { type: 'system', id: 'system-1', level: 'info', text: 'Hidden' }
  ]

  assert.deepEqual(liteMessagesFromItems(items), [
    { id: 'user-1', role: 'user', text: 'Question', attachments: [] },
    { id: 'assistant-1', role: 'assistant', text: 'Answer' }
  ])
})
