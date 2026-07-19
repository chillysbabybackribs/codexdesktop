import assert from 'node:assert/strict'
import test from 'node:test'
import { ResearchOriginRouter } from './research-origin-router.ts'

test('unknown origins allow one bounded static probe while concurrent work uses Chromium', () => {
  const router = new ResearchOriginRouter()
  const first = router.begin('https://docs.example.com/one')
  const concurrent = router.begin('https://docs.example.com/two')

  assert.equal(first.mode, 'static')
  assert.equal(first.reason, 'unknown-origin')
  assert.equal(first.timeoutMs, 650)
  assert.equal(concurrent.mode, 'browser')
  assert.equal(concurrent.reason, 'static-probe-in-flight')

  first.finish({ kind: 'accepted', durationMs: 80 })
  const learned = router.begin('https://docs.example.com/three')
  assert.equal(learned.mode, 'static')
  assert.equal(learned.reason, 'static-proven')
  assert.equal(learned.timeoutMs, 350)
})

test('fallbacks and timeouts route later requests on that origin directly to Chromium', () => {
  const router = new ResearchOriginRouter()
  const fallback = router.begin('https://app.example.com/a')
  fallback.finish({ kind: 'fallback', durationMs: 25 })

  const afterFallback = router.begin('https://app.example.com/b')
  assert.equal(afterFallback.mode, 'browser')
  assert.equal(afterFallback.reason, 'browser-proven')

  const timeout = router.begin('https://slow.example.com/a')
  timeout.finish({ kind: 'timeout', durationMs: 650 })
  assert.equal(router.begin('https://slow.example.com/b').mode, 'browser')
})

test('profiles expire so changed origins are probed again', () => {
  let now = 1_000
  const router = new ResearchOriginRouter(5_000, 128, () => now)
  const probe = router.begin('https://app.example.com/a')
  probe.finish({ kind: 'fallback', durationMs: 10 })
  assert.equal(router.begin('https://app.example.com/b').mode, 'browser')

  now += 5_001
  const retry = router.begin('https://app.example.com/c')
  assert.equal(retry.mode, 'static')
  assert.equal(retry.reason, 'unknown-origin')
})

test('cancelled and blocked probes do not teach a transport preference', () => {
  const router = new ResearchOriginRouter()
  const cancelled = router.begin('https://example.com/a')
  cancelled.finish({ kind: 'cancelled' })
  assert.equal(router.begin('https://example.com/b').mode, 'static')

  const blocked = router.begin('https://blocked.example/a')
  blocked.finish({ kind: 'blocked' })
  assert.equal(router.begin('https://blocked.example/b').mode, 'static')
})
