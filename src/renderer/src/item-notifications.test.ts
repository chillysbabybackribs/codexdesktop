import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isImmediateItemNotification,
  type ItemNotification
} from './item-notifications.js'

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
