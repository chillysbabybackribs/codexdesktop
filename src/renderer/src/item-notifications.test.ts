import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isImmediateItemNotification,
  reduceItemNotificationBatch,
  reduceItemNotificationMeta,
  type ItemNotification
} from './item-notifications.js'
import { latestItemProgress, reduceResearchProgressMeta } from './activity-model.js'
import type { CodexResearchProgressEvent } from '../../shared/ipc.js'

function notification(method: ItemNotification['method']): ItemNotification {
  return { method } as ItemNotification
}

test('only lifecycle notifications bypass frame batching', () => {
  assert.equal(isImmediateItemNotification(notification('item/fileChange/patchUpdated')), false)
  assert.equal(isImmediateItemNotification(notification('item/started')), true)
  assert.equal(isImmediateItemNotification(notification('item/completed')), true)
  assert.equal(isImmediateItemNotification(notification('item/agentMessage/delta')), false)
  assert.equal(isImmediateItemNotification(notification('item/commandExecution/outputDelta')), false)
})

test('streaming deltas preserve metadata identity after lifecycle metadata exists', () => {
  const current = { 'message-1': { turnId: 'turn-1', startedAtMs: 10 } }
  const delta = {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'hello' }
  } as ItemNotification

  assert.equal(reduceItemNotificationMeta(current, delta), current)
})

test('the first out-of-order delta still creates lifecycle metadata', () => {
  const delta = {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'hello' }
  } as ItemNotification

  assert.deepEqual(reduceItemNotificationMeta({}, delta), {
    'message-1': { turnId: 'turn-1' }
  })
})

test('one frame of mixed deltas reduces to one complete transcript snapshot', () => {
  const notifications = [
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Hello ' }
    },
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'world' }
    },
    {
      method: 'item/fileChange/patchUpdated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'file-1',
        changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '+done' }]
      }
    }
  ] as ItemNotification[]

  const items = reduceItemNotificationBatch([], notifications)
  assert.equal(items[0]?.type === 'agentMessage' && items[0].text, 'Hello world')
  assert.equal(items[1]?.type, 'fileChange')
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
