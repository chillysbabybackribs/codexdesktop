import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatAttachment } from '../../shared/ipc.ts'
import { attachmentTurnInputs } from './codex-client.ts'

test('image attachments use bounded high detail while files remain path mentions', () => {
  const attachments: ChatAttachment[] = [
    { id: 'image', kind: 'image', name: 'screen.png', path: '/owned/screen.png', mediaType: 'image/png', size: 10 },
    { id: 'file', kind: 'file', name: 'notes.md', path: '/owned/notes.md', mediaType: 'text/markdown', size: 20 }
  ]

  assert.deepEqual(attachmentTurnInputs(attachments), [
    { type: 'localImage', path: '/owned/screen.png', detail: 'high' },
    { type: 'mention', name: 'notes.md', path: '/owned/notes.md' }
  ])
})
