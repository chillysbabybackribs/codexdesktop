import assert from 'node:assert/strict'
import test from 'node:test'
import { AsyncMessageQueue } from './async-message-queue.js'

test('async message queue delivers buffered and awaited values in order', async () => {
  const queue = new AsyncMessageQueue<string>()
  const iterator = queue[Symbol.asyncIterator]()

  queue.push('first')
  assert.deepEqual(await iterator.next(), { done: false, value: 'first' })

  const pending = iterator.next()
  queue.push('second')
  assert.deepEqual(await pending, { done: false, value: 'second' })

  queue.close()
  assert.deepEqual(await iterator.next(), { done: true, value: undefined })
  assert.throws(() => queue.push('late'), /closed message queue/)
})

