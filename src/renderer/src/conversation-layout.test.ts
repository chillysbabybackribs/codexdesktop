import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assignTarget,
  collectTargets,
  createDefaultLayout,
  createLayoutLeaf,
  findLeaf,
  isTiledLayout,
  normalizeLayout,
  parseLayoutNode,
  removeTarget,
  serializeLayoutNode,
  splitLeafAtEdge,
  type LayoutNode
} from './conversation-layout.ts'

test('assignTarget swaps conversations instead of duplicating them', () => {
  const layout: LayoutNode = {
    type: 'split',
    id: 'split-1',
    direction: 'row',
    ratio: 0.5,
    first: createLayoutLeaf('main', 'leaf-main'),
    second: createLayoutLeaf('agent-a', 'leaf-agent')
  }
  const swapped = assignTarget(layout, 'leaf-main', 'agent-a')
  assert.deepEqual(collectTargets(swapped).sort(), ['agent-a', 'main'])
  assert.equal(findLeaf(swapped, 'leaf-main')?.target, 'agent-a')
  assert.equal(findLeaf(swapped, 'leaf-agent')?.target, 'main')
})

test('splitting a pane creates a tiled layout with the dropped conversation', () => {
  const base = createDefaultLayout('main')
  const split = splitLeafAtEdge(base, base.id, 'right', 'agent-b')
  assert.equal(isTiledLayout(split), true)
  assert.deepEqual(collectTargets(split).sort(), ['agent-b', 'main'])
})

test('removeTarget collapses a closed agent back to main in its pane', () => {
  const base = createDefaultLayout('main')
  const split = splitLeafAtEdge(base, base.id, 'right', 'agent-c')
  const next = removeTarget(split, 'agent-c')
  assert.deepEqual(collectTargets(next), ['main'])
})

test('layout persistence round-trips and drops unknown agent targets', () => {
  const base = createDefaultLayout('main')
  const split = splitLeafAtEdge(base, base.id, 'bottom', 'agent-d')
  const raw = serializeLayoutNode(split)
  const parsed = parseLayoutNode(raw, new Set(['agent-d']))
  assert.ok(parsed)
  assert.deepEqual(collectTargets(parsed!).sort(), ['agent-d', 'main'])

  const normalized = normalizeLayout(parsed!, new Set(['agent-d']))
  assert.deepEqual(collectTargets(normalized).sort(), ['agent-d', 'main'])

  const stale = parseLayoutNode(raw, new Set())
  assert.ok(stale)
  assert.ok(collectTargets(normalizeLayout(stale!, new Set())).every((target) => target === 'main'))
})

test('assignTarget keeps a single main pane when swapping onto main', () => {
  const layout = createLayoutLeaf('agent-x')
  const next = assignTarget(layout, layout.id, 'main')
  assert.deepEqual(collectTargets(next), ['main'])
})
