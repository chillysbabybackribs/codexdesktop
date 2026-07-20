import assert from 'node:assert/strict'
import test from 'node:test'
import {
  columnSlotSize,
  hiddenAgentCounts,
  windowScrollTarget,
  type AgentColumnMetrics
} from './agent-column-scroll.ts'

// A column of 90px cards (slot = 100 with the 10px gap): five cards in a
// 300px viewport, so ~3 fit and the rest hide behind the chevron bars.
function makeMetrics(overrides: Partial<AgentColumnMetrics> = {}): AgentColumnMetrics {
  return {
    scrollTop: 0,
    scrollHeight: 500,
    clientHeight: 300,
    firstItemHeight: 90,
    ...overrides
  }
}

test('columnSlotSize is the first card height plus the 10px gap', () => {
  assert.equal(columnSlotSize(makeMetrics()), 100)
  assert.equal(columnSlotSize(makeMetrics({ firstItemHeight: 145 })), 155)
})

test('columnSlotSize falls back to half the viewport without a first card', () => {
  assert.equal(columnSlotSize(makeMetrics({ firstItemHeight: null })), 150)
})

test('hiddenAgentCounts at the top hides everything below', () => {
  assert.deepEqual(hiddenAgentCounts(makeMetrics()), { above: 0, below: 2 })
})

test('hiddenAgentCounts at the bottom hides everything above', () => {
  assert.deepEqual(hiddenAgentCounts(makeMetrics({ scrollTop: 200 })), { above: 2, below: 0 })
})

test('hiddenAgentCounts mid-scroll splits the hidden cards', () => {
  assert.deepEqual(hiddenAgentCounts(makeMetrics({ scrollTop: 100 })), { above: 1, below: 1 })
})

test('hiddenAgentCounts is zero when the column fits', () => {
  const metrics = makeMetrics({ scrollHeight: 300 })
  assert.deepEqual(hiddenAgentCounts(metrics), { above: 0, below: 0 })
})

test('windowScrollTarget steps down one slot at a time', () => {
  assert.equal(windowScrollTarget(makeMetrics(), 1), 100)
  assert.equal(windowScrollTarget(makeMetrics({ scrollTop: 100 }), 1), 200)
})

test('windowScrollTarget snaps from a mid-animation position to the next slot', () => {
  // scrollTop 140 rounds to slot index 1, so the next slot down is 200 —
  // repeated clicks land on exact snap points instead of compounding deltas.
  assert.equal(windowScrollTarget(makeMetrics({ scrollTop: 140 }), 1), 200)
  assert.equal(windowScrollTarget(makeMetrics({ scrollTop: 140 }), -1), 0)
})

test('windowScrollTarget clamps at the ends of the column', () => {
  assert.equal(windowScrollTarget(makeMetrics({ scrollTop: 200 }), 1), 200)
  assert.equal(windowScrollTarget(makeMetrics(), -1), 0)
})

test('windowScrollTarget uses the viewport fallback slot when empty', () => {
  const metrics = makeMetrics({ firstItemHeight: null, scrollHeight: 600 })
  assert.equal(windowScrollTarget(metrics, 1), 150)
})
