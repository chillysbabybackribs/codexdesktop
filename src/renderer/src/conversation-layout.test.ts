import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assignTarget,
  collectTargets,
  createDefaultLayout,
  createLayoutLeaf,
  dropEdgeFromProfile,
  dropProfileForRect,
  findLeaf,
  findFirstLeaf,
  findLeafForTarget,
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

test('removeTarget preserves a main column beside a stacked agent column', () => {
  let layout: LayoutNode = createDefaultLayout('main')
  const mainLeaf = findFirstLeaf(layout)
  layout = splitLeafAtEdge(layout, mainLeaf.id, 'right', 'agent-1')
  layout = splitLeafAtEdge(layout, findLeafForTarget(layout, 'agent-1')!.id, 'bottom', 'agent-2')
  layout = splitLeafAtEdge(layout, findLeafForTarget(layout, 'agent-2')!.id, 'bottom', 'agent-3')
  layout = splitLeafAtEdge(layout, findLeafForTarget(layout, 'agent-3')!.id, 'bottom', 'agent-4')

  assert.deepEqual(collectTargets(layout).sort(), ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'main'])

  const next = removeTarget(layout, 'agent-2')
  assert.deepEqual(collectTargets(next).sort(), ['agent-1', 'agent-3', 'agent-4', 'main'])

  const root = next.type === 'split' ? next : null
  assert.ok(root && root.direction === 'row')
  assert.equal(root.first.type === 'leaf' ? root.first.target : null, 'main')

  const stack = root.second
  assert.equal(stack.type, 'split')
  if (stack.type !== 'split') return
  assert.equal(stack.direction, 'column')
  assert.deepEqual(collectTargets(stack).sort(), ['agent-1', 'agent-3', 'agent-4'])
})

test('layout persistence round-trips and drops unknown agent targets', () => {
  const base = createDefaultLayout('main')
  const split = splitLeafAtEdge(base, base.id, 'bottom', 'agent-d')
  const raw = serializeLayoutNode(split)
  const parsed = parseLayoutNode(raw)
  assert.ok(parsed)
  assert.deepEqual(collectTargets(normalizeLayout(parsed, new Set(['agent-d']))).sort(), ['agent-d', 'main'])

  const normalized = normalizeLayout(parsed, new Set(['agent-d']))
  assert.deepEqual(collectTargets(normalized).sort(), ['agent-d', 'main'])

  const stale = parseLayoutNode(raw)
  assert.ok(stale)
  assert.ok(collectTargets(normalizeLayout(stale, new Set())).every((target) => target === 'main'))
})

test('assignTarget keeps a single main pane when swapping onto main', () => {
  const layout = createLayoutLeaf('agent-x')
  const next = assignTarget(layout, layout.id, 'main')
  assert.deepEqual(collectTargets(next), ['main'])
})

test('dropEdgeFromProfile uses wide and tall layouts that match the overlay zones', () => {
  const wide = {
    left: 0,
    top: 0,
    width: 900,
    height: 500,
    right: 900,
    bottom: 500,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect

  assert.equal(dropProfileForRect(wide), 'wide')
  assert.equal(dropEdgeFromProfile(wide, 120, 250), 'left')
  assert.equal(dropEdgeFromProfile(wide, 780, 250), 'right')
  assert.equal(dropEdgeFromProfile(wide, 450, 24), 'top')
  assert.equal(dropEdgeFromProfile(wide, 450, 470), 'bottom')

  const tall = {
    left: 0,
    top: 0,
    width: 420,
    height: 900,
    right: 420,
    bottom: 900,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect

  assert.equal(dropProfileForRect(tall), 'tall')
  assert.equal(dropEdgeFromProfile(tall, 24, 450), 'left')
  assert.equal(dropEdgeFromProfile(tall, 396, 450), 'right')
  assert.equal(dropEdgeFromProfile(tall, 210, 120), 'top')
  assert.equal(dropEdgeFromProfile(tall, 210, 780), 'bottom')
})

test('right split creates a side-by-side row layout', () => {
  const base = createDefaultLayout('main')
  const split = splitLeafAtEdge(base, base.id, 'right', 'agent-side')
  assert.equal(split.type, 'split')
  if (split.type === 'split') assert.equal(split.direction, 'row')
})

test('bottom split creates a stacked column layout', () => {
  const base = createDefaultLayout('main')
  const split = splitLeafAtEdge(base, base.id, 'bottom', 'agent-stack')
  assert.equal(split.type, 'split')
  if (split.type === 'split') assert.equal(split.direction, 'column')
})
