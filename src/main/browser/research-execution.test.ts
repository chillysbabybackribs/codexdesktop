import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectWithConcurrencyUntil,
  KeyedTaskScheduler,
  ResearchMemoryCache,
  retainValuesReducingDeficit
} from './research-execution.ts'

test('research memory cache expires entries and evicts the least recently used value', () => {
  let now = 0
  const cache = new ResearchMemoryCache<string>(100, 2, () => now)
  cache.set('a', 'first')
  cache.set('b', 'second')
  assert.equal(cache.get('a'), 'first')
  cache.set('c', 'third')
  assert.equal(cache.get('b'), null)
  assert.equal(cache.get('a'), 'first')
  now = 100
  assert.equal(cache.get('a'), null)
  assert.equal(cache.get('c'), null)
})

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
  assert.ok(result.attempted >= 2 && result.attempted <= 3)
  assert.ok(completed.includes(0))
  assert.ok(completed.includes(1))
})

test('result-aware collection waits for distinct focus coverage instead of the first success', async () => {
  const result = await collectWithConcurrencyUntil(
    ['focus-a', 'duplicate-a', 'focus-b'],
    {
      concurrency: 2,
      target: 3,
      maxAttempts: 3,
      shouldStop: (values) => new Set(values.map(({ value }) => value)).size === 2
    },
    async (item, index, stopSignal) => {
      if (index !== 1) return item
      return new Promise<null>((resolve) => {
        if (stopSignal.aborted) resolve(null)
        else stopSignal.addEventListener('abort', () => resolve(null), { once: true })
      })
    }
  )

  assert.deepEqual(result.values, [
    { index: 0, value: 'focus-a' },
    { index: 2, value: 'focus-b' }
  ])
  assert.equal(result.attempted, 3)
})

test('ranked retention drops duplicate drafts that do not reduce focus deficit', () => {
  const retained = retainValuesReducingDeficit(
    [
      { id: 'a-primary', coverage: ['a'] },
      { id: 'a-duplicate', coverage: ['a'] },
      { id: 'b-primary', coverage: ['b'] }
    ],
    3,
    (values) => {
      const covered = new Set(values.flatMap(({ coverage }) => coverage))
      return ['a', 'b'].filter((focusId) => !covered.has(focusId)).length
    }
  )

  assert.deepEqual(retained.map(({ id }) => id), ['a-primary', 'b-primary'])
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
