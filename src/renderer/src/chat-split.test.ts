import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adjacentSplitPaneKey,
  canSplitPaneForDrop,
  countSplitPanes,
  insertSplitPane,
  parseChatSplitLayout,
  reconcileChatSplitLayout,
  removeSplitPane,
  replaceSplitPane,
  serializeChatSplitLayout,
  splitDropZoneAt,
  splitLeaf,
  splitPaneKeys,
  updateSplitRatio,
  type SplitNode
} from './chat-split.ts'

function keysOf(node: SplitNode): string[] {
  return splitPaneKeys(node)
}

test('insert splits a single pane side by side and stacked', () => {
  const sideBySide = insertSplitPane(splitLeaf('a'), 'a', 'b', 'right')
  assert.deepEqual(keysOf(sideBySide), ['a', 'b'])
  assert.equal(sideBySide.kind, 'split')
  assert.equal(sideBySide.kind === 'split' && sideBySide.direction, 'row')

  const stacked = insertSplitPane(splitLeaf('a'), 'a', 'b', 'top')
  assert.deepEqual(keysOf(stacked), ['b', 'a'])
  assert.equal(stacked.kind === 'split' && stacked.direction, 'column')
})

test('builds a four-pane quadrant grid and rejects a fifth', () => {
  let layout = splitLeaf('a')
  layout = insertSplitPane(layout, 'a', 'b', 'right')
  layout = insertSplitPane(layout, 'a', 'c', 'bottom')
  layout = insertSplitPane(layout, 'b', 'd', 'bottom')
  assert.deepEqual(keysOf(layout).sort(), ['a', 'b', 'c', 'd'])
  assert.equal(countSplitPanes(layout), 4)

  const rejected = insertSplitPane(layout, 'a', 'e', 'right')
  assert.equal(rejected, layout)
  assert.equal(canSplitPaneForDrop(layout, 'a', 'e'), false)
})

test('depth cap blocks a third level even under the pane cap', () => {
  let layout = splitLeaf('a')
  layout = insertSplitPane(layout, 'a', 'b', 'right')
  layout = insertSplitPane(layout, 'b', 'c', 'bottom')
  // c sits at depth 2; splitting it again would need depth 3.
  assert.equal(canSplitPaneForDrop(layout, 'c', 'd'), false)
  assert.equal(insertSplitPane(layout, 'c', 'd', 'right'), layout)
  // a (depth 1) can still split.
  assert.equal(canSplitPaneForDrop(layout, 'a', 'd'), true)
})

test('inserting an already-visible pane moves it instead of duplicating', () => {
  let layout = splitLeaf('a')
  layout = insertSplitPane(layout, 'a', 'b', 'right')
  const moved = insertSplitPane(layout, 'a', 'b', 'top')
  assert.deepEqual(keysOf(moved), ['b', 'a'])
  assert.equal(moved.kind === 'split' && moved.direction, 'column')
})

test('moving a pane within a full grid stays possible', () => {
  let layout = splitLeaf('a')
  layout = insertSplitPane(layout, 'a', 'b', 'right')
  layout = insertSplitPane(layout, 'a', 'c', 'bottom')
  layout = insertSplitPane(layout, 'b', 'd', 'bottom')
  assert.equal(canSplitPaneForDrop(layout, 'a', 'd'), true)
  const moved = insertSplitPane(layout, 'a', 'd', 'left')
  assert.equal(countSplitPanes(moved), 4)
  assert.deepEqual(keysOf(moved).slice(0, 2), ['d', 'a'])
})

test('replace swaps when the incoming chat is already visible', () => {
  let layout = splitLeaf('a')
  layout = insertSplitPane(layout, 'a', 'b', 'right')
  const swapped = replaceSplitPane(layout, 'a', 'b')
  assert.deepEqual(keysOf(swapped), ['b', 'a'])
  const replaced = replaceSplitPane(layout, 'a', 'c')
  assert.deepEqual(keysOf(replaced), ['c', 'b'])
})

test('remove collapses the parent split to the sibling', () => {
  let layout = splitLeaf('a')
  layout = insertSplitPane(layout, 'a', 'b', 'right')
  layout = insertSplitPane(layout, 'b', 'c', 'bottom')
  const collapsed = removeSplitPane(layout, 'c')
  assert.deepEqual(keysOf(collapsed), ['a', 'b'])
  const single = removeSplitPane(collapsed, 'a')
  assert.deepEqual(keysOf(single), ['b'])
  // Removing the last pane is the caller's decision, not the tree's.
  assert.equal(removeSplitPane(splitLeaf('b'), 'b').kind, 'pane')
})

test('adjacent pane key names the sibling subtree first pane', () => {
  let layout = splitLeaf('a')
  layout = insertSplitPane(layout, 'a', 'b', 'right')
  layout = insertSplitPane(layout, 'b', 'c', 'bottom')
  assert.equal(adjacentSplitPaneKey(layout, 'a'), 'b')
  assert.equal(adjacentSplitPaneKey(layout, 'c'), 'b')
  assert.equal(adjacentSplitPaneKey(splitLeaf('a'), 'a'), null)
})

test('ratio updates follow the path and clamp', () => {
  let layout = splitLeaf('a')
  layout = insertSplitPane(layout, 'a', 'b', 'right')
  layout = insertSplitPane(layout, 'b', 'c', 'bottom')
  const resized = updateSplitRatio(layout, 's', 0.99)
  assert.equal(resized.kind === 'split' && resized.second.kind === 'split' && resized.second.ratio, 0.85)
  const same = updateSplitRatio(resized, 'x', 0.4)
  assert.equal(same, resized)
})

test('drop zones map edges, center, and the no-split fallback', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 }
  assert.equal(splitDropZoneAt(10, 50, rect, true), 'left')
  assert.equal(splitDropZoneAt(95, 50, rect, true), 'right')
  assert.equal(splitDropZoneAt(50, 8, rect, true), 'top')
  assert.equal(splitDropZoneAt(50, 93, rect, true), 'bottom')
  assert.equal(splitDropZoneAt(50, 50, rect, true), 'center')
  assert.equal(splitDropZoneAt(10, 50, rect, false), 'center')
  assert.equal(splitDropZoneAt(150, 50, rect, true), null)
})

test('reconcile drops closed tabs, dedupes, and keeps the active tab visible', () => {
  let layout = splitLeaf('a')
  layout = insertSplitPane(layout, 'a', 'b', 'right')
  layout = insertSplitPane(layout, 'a', 'c', 'bottom')

  // Closing b collapses its pane.
  const withoutB = reconcileChatSplitLayout(layout, ['a', 'c'], 'a', 'a')
  assert.deepEqual(keysOf(withoutB), ['a', 'c'])

  // Unchanged input returns the same reference.
  assert.equal(reconcileChatSplitLayout(layout, ['a', 'b', 'c'], 'a', 'a'), layout)

  // A hidden active tab lands in the previously focused pane.
  const focused = reconcileChatSplitLayout(layout, ['a', 'b', 'c', 'd'], 'd', 'c')
  assert.deepEqual(keysOf(focused).sort(), ['a', 'b', 'd'])
  assert.equal(adjacentSplitPaneKey(focused, 'd'), 'a')

  // Without a usable preferred pane it lands in the first pane.
  const fallback = reconcileChatSplitLayout(layout, ['a', 'b', 'c', 'd'], 'd', null)
  assert.deepEqual(keysOf(fallback)[0], 'd')
})

test('serialize and parse round-trip and survive garbage', () => {
  let layout = splitLeaf('a')
  layout = insertSplitPane(layout, 'a', 'b', 'right')
  layout = insertSplitPane(layout, 'b', 'c', 'bottom')
  const parsed = parseChatSplitLayout(serializeChatSplitLayout(layout), ['a', 'b', 'c'], 'a')
  assert.deepEqual(parsed, layout)

  assert.deepEqual(parseChatSplitLayout('not json', ['a'], 'a'), splitLeaf('a'))
  assert.deepEqual(parseChatSplitLayout(null, ['a'], 'a'), splitLeaf('a'))
  assert.deepEqual(
    parseChatSplitLayout('{"kind":"split","first":{"kind":"pane","tabKey":"zz"}}', ['a'], 'a'),
    splitLeaf('a')
  )
})
