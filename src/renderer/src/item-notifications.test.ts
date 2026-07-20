import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isImmediateItemNotification,
  type ItemNotification
} from './item-notifications.js'
import { latestItemProgress, reduceResearchProgressMeta } from './activity-model.js'
import type { CodexResearchProgressEvent } from '../../shared/ipc.js'

function notification(method: ItemNotification['method']): ItemNotification {
  return { method } as ItemNotification
}

test('file-change snapshots bypass frame batching so live diffs visibly grow', () => {
  assert.equal(isImmediateItemNotification(notification('item/fileChange/patchUpdated')), true)
  assert.equal(isImmediateItemNotification(notification('item/started')), true)
  assert.equal(isImmediateItemNotification(notification('item/completed')), true)
  assert.equal(isImmediateItemNotification(notification('item/agentMessage/delta')), false)
  assert.equal(isImmediateItemNotification(notification('item/commandExecution/outputDelta')), false)
})

test('research progress is attached to the matching dynamic tool item', () => {
  const event: CodexResearchProgressEvent = {
    type: 'researchProgress',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'call-1',
    progress: {
      stage: 'verifying',
      message: 'Verifying pages — 1/3 verified, 2/6 attempted…',
      pagesAttempted: 2,
      pagesVerified: 1,
      targetPages: 3
    }
  }

  const meta = reduceResearchProgressMeta({}, event)
  assert.deepEqual(meta, {
    'call-1': {
      turnId: 'turn-1',
      progress: ['Verifying pages — 1/3 verified, 2/6 attempted…']
    }
  })
  assert.equal(latestItemProgress(meta['call-1']), 'Verifying pages — 1/3 verified, 2/6 attempted…')
})
