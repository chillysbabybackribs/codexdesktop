import assert from 'node:assert/strict'
import test from 'node:test'
import type { WebContents } from 'electron'
import {
  BrowserOperationError,
  KeyedOperationQueue,
  boundResult,
  browserFailureFor,
  createBoundedSuccessResult,
  createFailureResult,
  operationError,
  withTimeout
} from './browser-operation.ts'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('keyed operation queue serializes one key while unrelated keys run concurrently', async () => {
  const queue = new KeyedOperationQueue()
  const gate = deferred<void>()
  const started: string[] = []

  const first = queue.run('tab-1', async () => {
    started.push('tab-1:first')
    await gate.promise
    return 'first'
  })
  const second = queue.run('tab-1', async () => {
    started.push('tab-1:second')
    return 'second'
  })
  const otherTab = queue.run('tab-2', async () => {
    started.push('tab-2:first')
    return 'other'
  })

  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(started, ['tab-1:first', 'tab-2:first'])

  gate.resolve()
  assert.deepEqual(await Promise.all([first, second, otherTab]), ['first', 'second', 'other'])
  assert.deepEqual(started, ['tab-1:first', 'tab-2:first', 'tab-1:second'])
})

test('keyed operation queue continues after a rejected operation', async () => {
  const queue = new KeyedOperationQueue()
  const failed = queue.run('tab-1', async () => {
    throw new Error('first operation failed')
  })
  const recovered = queue.run('tab-1', async () => 'recovered')

  await assert.rejects(failed, /first operation failed/)
  assert.equal(await recovered, 'recovered')
})

test('withTimeout runs cleanup and preserves structured timeout failures', async () => {
  let cleanupCalls = 0
  const pending = new Promise<never>(() => undefined)

  await assert.rejects(
    withTimeout(pending, 10, () => {
      cleanupCalls += 1
    }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserOperationError)
      assert.equal(error.failure.code, 'timeout')
      assert.equal(error.failure.phase, 'controller')
      return true
    }
  )
  assert.equal(cleanupCalls, 1)
})

test('withTimeout converts an owning-turn abort into a cancellation', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    withTimeout(new Promise<never>(() => undefined), 1_000, undefined, controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof BrowserOperationError)
      assert.equal(error.failure.code, 'cancelled')
      return true
    }
  )
})

test('boundResult returns a bounded preview and classifies serialization failures', () => {
  const bounded = boundResult({ content: 'x'.repeat(500) }, 140)
  assert.equal(bounded.truncated, true)
  assert.ok(bounded.chars > 140)
  assert.ok(JSON.stringify(bounded.value).length <= 140)

  const circular: { self?: unknown } = {}
  circular.self = circular
  assert.throws(
    () => boundResult(circular, 1_000),
    (error: unknown) => {
      assert.equal(browserFailureFor(error).code, 'resultSerializationError')
      return true
    }
  )
})

test('operation result factories preserve a consistent target envelope', () => {
  const webContents = {
    getURL: () => 'https://example.com/report',
    getTitle: () => 'Example report'
  } as WebContents
  const context = { tabId: 'tab-1', webContents, startedAt: Date.now() }

  const success = createBoundedSuccessResult({ answer: 42 }, 1_000, context)
  assert.equal(success.ok, true)
  assert.deepEqual(success.result, { answer: 42 })
  assert.equal(success.tabId, 'tab-1')
  assert.equal(success.url, 'https://example.com/report')
  assert.equal(success.title, 'Example report')
  assert.equal(success.truncated, false)

  const failure = createFailureResult(
    operationError('targetChanged', 'targetLifecycle', 'target changed'),
    context
  )
  assert.equal(failure.ok, false)
  assert.equal(failure.errorCode, 'targetChanged')
  assert.equal(failure.failure?.phase, 'targetLifecycle')
  assert.equal(failure.tabId, 'tab-1')
})
