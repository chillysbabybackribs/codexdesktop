import assert from 'node:assert/strict'
import test from 'node:test'
import {
  anchorSpacerHeight,
  completionScrollMode,
  decideTurnAnchor,
  keyScrollIntent,
  shouldRepinOnScroll,
  wheelIntent
} from './thread-scroll-state.ts'

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

test('a bare scroll event re-pins only at the live edge', () => {
  assert.equal(shouldRepinOnScroll(false, false, 0), true)
  assert.equal(shouldRepinOnScroll(false, false, 48), true)
  assert.equal(shouldRepinOnScroll(false, false, 49), false)
})

test('the up-hold latch blocks re-pinning until a downward intent clears it', () => {
  assert.equal(shouldRepinOnScroll(true, false, 0), false)
})

test('top-anchor mode is never converted to bottom-follow by its own clamp events', () => {
  assert.equal(shouldRepinOnScroll(false, true, 0), false)
})

test('wheel direction maps to reader intent; horizontal wheels are ignored', () => {
  assert.equal(wheelIntent(-1), 'up')
  assert.equal(wheelIntent(1), 'down')
  assert.equal(wheelIntent(0), null)
})

test('navigation keys map to reader intent; other keys are ignored', () => {
  assert.equal(keyScrollIntent('PageUp', false), 'up')
  assert.equal(keyScrollIntent('Home', false), 'up')
  assert.equal(keyScrollIntent('ArrowDown', false), 'down')
  assert.equal(keyScrollIntent('End', false), 'down')
  assert.equal(keyScrollIntent(' ', true), 'up')
  assert.equal(keyScrollIntent(' ', false), 'down')
  assert.equal(keyScrollIntent('a', false), null)
})

test('anchor spacer overshoots an exact fit so the anchored offset never sits at max scroll', () => {
  // Shortfall of 100px → 102px runway keeps scrollTop strictly inside range.
  assert.equal(anchorSpacerHeight(600, 488, 12), 102)
  // An exact fit still gets the 2px pad — that is the clamp-risk boundary.
  assert.equal(anchorSpacerHeight(600, 588, 12), 2)
  // Content already spills past the viewport below the anchor → no runway.
  assert.equal(anchorSpacerHeight(600, 700, 12), 0)
})
