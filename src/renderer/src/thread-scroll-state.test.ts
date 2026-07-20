import assert from 'node:assert/strict'
import test from 'node:test'
import { completionScrollMode, decideTurnAnchor } from './thread-scroll-state.ts'

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

test('completion settles an app-owned top anchor to the final response tail', () => {
  assert.equal(completionScrollMode(true, false), 'follow-tail')
})

test('completion keeps following an already pinned transcript', () => {
  assert.equal(completionScrollMode(false, true), 'follow-tail')
})

test('completion preserves a reader who manually scrolled away', () => {
  assert.equal(completionScrollMode(false, false), 'preserve-reader')
})
