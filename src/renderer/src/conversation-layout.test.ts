import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assignTarget,
  collectTargets,
  createDefaultLayout,
  createLayoutLeaf,
  isTiledLayout,
  normalizeLayout,
  parseLayoutNode,
  removeTarget,
  serializeLayoutNode,
  splitLeafAtEdge
} from './conversation-layout.ts'

test('assignTarget swaps conversations instead of duplicating them', () => {
  const layout = splitLeafAtEdge(createDefaultLayout('main'), createDefaultLayout('main').id, 'right', 'agent-a')
  const rightLeaf = collectTargets(layout).includes('agent-a')
    ? parseLayoutNode(serializeLayoutNode(layout), new Set(['agent-a']))
    : null
  assert.ok(rightLeaf)
  const leaves = rightLeaf!.type === 'split'
    ? [rightLeaf.first, rightLeaf.second]
    : [rightLeaf]
  const agentLeaf = leaves.find((node) => node.type === 'leaf' && node.target === 'agent-a')
  assert.ok(agentLeaf && agentLeaf.type === 'leaf')
  const mainLeaf = leaves.find((node) => node.type === 'leaf' && node.target === 'main')
  assert.ok(mainLeaf && mainLeaf.type === 'leaf')

  const swapped = assignTarget(layout, mainLeaf.id, 'agent-a')
  assert.deepEqual(collectTargets(swapped).sort(), ['agent-a', 'main'])
})

test('splitting a pane creates a tiled layout with the dropped conversation', () => {
  const base = createDefaultLayout('main')
  const split = splitLeafAtEdge(base, base.id, 'right', 'agent-b')
  assert.equal(isTiledLayout(split), true)
  assert.deepEqual(collectTargets(split).sort(), ['agent-b', 'main'])
})

test('removeTarget collapses a closed agent back to main in its pane', () => {
  const split = splitLeafAtEdge(createDefaultLayout('main'), createDefaultLayout('main').id, 'right', 'agent-c')
  const next = removeTarget(split, 'agent-c')
  assert.deepEqual(collectTargets(next), ['main'])
})

test('layout persistence round-trips and drops unknown agent targets', () => {
  const split = splitLeafAtEdge(createDefaultLayout('main'), createDefaultLayout('main').id, 'bottom', 'agent-d')
  const raw = serializeLayoutNode(split)
  const parsed = parseLayoutNode(raw, new Set(['agent-d']))
  assert.ok(parsed)
  assert.deepEqual(collectTargets(parsed!).sort(), ['agent-d', 'main'])

  const normalized = normalizeLayout(parsed!, new Set(['agent-d']))
  assert.deepEqual(collectTargets(normalized).sort(), ['agent-d', 'main'])

  const stale = parseLayoutNode(raw, new Set())
  assert.ok(stale)
  assert.deepEqual(collectTargets(normalizeLayout(stale!, new Set())), ['main'])
})

test('assignTarget keeps a single main pane when swapping onto main', () => {
  const layout = createLayoutLeaf('agent-x')
  const next = assignTarget(layout, layout.id, 'main')
  assert.deepEqual(collectTargets(next), ['main'])
})
