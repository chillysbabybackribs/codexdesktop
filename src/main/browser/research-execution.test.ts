import assert from 'node:assert/strict'
import test from 'node:test'
import { collectWithConcurrencyUntil, KeyedTaskScheduler } from './research-execution.ts'

test('candidate collection stops queued and in-flight work at the success target', async () => {
  const started: number[] = []
  const result = await collectWithConcurrencyUntil(
    [0, 1, 2, 3],
    { concurrency: 2, target: 1, maxAttempts: 4 },
    async (_item, index, stopSignal) => {
      started.push(index)
      if (index === 0) return 'verified'
      return new Promise<null>((resolve) => {
        if (stopSignal.aborted) resolve(null)
        else stopSignal.addEventListener('abort', () => resolve(null), { once: true })
      })
    }
  )

  assert.deepEqual(result.values, [{ index: 0, value: 'verified' }])
  assert.equal(result.attempted, 2)
  assert.deepEqual(started, [0, 1])
})

test('candidate collection respects the attempt ceiling when pages fail verification', async () => {
  const result = await collectWithConcurrencyUntil(
    ['a', 'b', 'c', 'd'],
    { concurrency: 2, target: 2, maxAttempts: 3 },
    async () => null
  )

  assert.deepEqual(result.values, [])
  assert.equal(result.attempted, 3)
})

test('irrelevant pages do not consume the success target or abort a later relevant candidate', async () => {
  const completed: number[] = []
  const result = await collectWithConcurrencyUntil(
    ['generic', 'relevant', 'extra'],
    { concurrency: 2, target: 1, maxAttempts: 3 },
    async (item, index) => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      completed.push(index)
      return item === 'relevant' ? item : null
    }
  )

  assert.deepEqual(result.values, [{ index: 1, value: 'relevant' }])
  assert.equal(result.attempted, 2)
  assert.deepEqual(completed.sort(), [0, 1])
})

test('keyed scheduling serializes one thread while allowing another thread to run', async () => {
  const scheduler = new KeyedTaskScheduler(2)
  const firstGate = deferred<void>()
  const events: string[] = []

  const first = scheduler.run('thread-a', async () => {
    events.push('a1:start')
    await firstGate.promise
    events.push('a1:end')
  })
  const second = scheduler.run('thread-a', async () => {
    events.push('a2:start')
  })
  const other = scheduler.run('thread-b', async () => {
    events.push('b1:start')
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['a1:start', 'b1:start'])

  firstGate.resolve()
  await Promise.all([first, second, other])
  assert.deepEqual(events, ['a1:start', 'b1:start', 'a1:end', 'a2:start'])
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
