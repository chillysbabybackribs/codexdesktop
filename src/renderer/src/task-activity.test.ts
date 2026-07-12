import assert from 'node:assert/strict'
import test from 'node:test'
import { currentActionLabel, type WorkItem } from './TaskActivity.tsx'

test('research progress becomes the live action label', () => {
  const item = {
    type: 'dynamicToolCall',
    id: 'call-1',
    namespace: null,
    tool: 'research_web',
    arguments: {},
    status: 'inProgress',
    contentItems: null,
    success: null,
    durationMs: null
  } as WorkItem

  assert.equal(
    currentActionLabel(
      [item],
      { 'call-1': { turnId: 'turn-1', progress: ['Searching source lane 1/2…'] } },
      false
    ),
    'Searching source lane 1/2…'
  )
})
