import assert from 'node:assert/strict'
import test from 'node:test'
import { decideTurnAnchor } from './thread-scroll-state.ts'

test('new-thread anchor skip survives the thread-started null-turn render', () => {
  const waiting = decideTurnAnchor(null, null, true)
  assert.deepEqual(waiting, { anchor: false, skipNext: true })

  const firstTurn = decideTurnAnchor('turn-1', null, waiting.skipNext)
  assert.deepEqual(firstTurn, { anchor: false, skipNext: false })
})

test('later turns still use top-anchor mode', () => {
  assert.deepEqual(decideTurnAnchor('turn-2', null, false), {
    anchor: true,
    skipNext: false
  })
})
