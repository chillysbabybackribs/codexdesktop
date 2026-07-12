export type ConversationTarget = 'main' | string

export type LayoutLeaf = {
  type: 'leaf'
  id: string
  target: ConversationTarget
}

export type LayoutSplit = {
  type: 'split'
  id: string
  direction: 'row' | 'column'
  ratio: number
  first: LayoutNode
  second: LayoutNode
}

export type LayoutNode = LayoutLeaf | LayoutSplit

export type SerializedLayoutNode =
  | { type: 'leaf'; id: string; target: ConversationTarget }
  | { type: 'split'; id: string; direction: 'row' | 'column'; ratio: number; first: SerializedLayoutNode; second: SerializedLayoutNode }

export type DropEdge = 'left' | 'right' | 'top' | 'bottom' | 'center'

const MIN_SPLIT_RATIO = 0.18
const MAX_SPLIT_RATIO = 0.82

export { MIN_SPLIT_RATIO, MAX_SPLIT_RATIO }

export function createLayoutLeaf(target: ConversationTarget = 'main', id: string = crypto.randomUUID()): LayoutLeaf {
  return { type: 'leaf', id, target }
}

export function createDefaultLayout(focusedTarget: ConversationTarget = 'main'): LayoutNode {
  return createLayoutLeaf(focusedTarget)
}

export function isTiledLayout(layout: LayoutNode): boolean {
  return layout.type === 'split' || countLeaves(layout) > 1
}

export function countLeaves(layout: LayoutNode): number {
  if (layout.type === 'leaf') return 1
  return countLeaves(layout.first) + countLeaves(layout.second)
}

export function collectLeaves(layout: LayoutNode): LayoutLeaf[] {
  if (layout.type === 'leaf') return [layout]
  return [...collectLeaves(layout.first), ...collectLeaves(layout.second)]
}

export function collectTargets(layout: LayoutNode): ConversationTarget[] {
  return collectLeaves(layout).map((leaf) => leaf.target)
}

export function findLeaf(layout: LayoutNode, leafId: string): LayoutLeaf | null {
  if (layout.type === 'leaf') return layout.id === leafId ? layout : null
  return findLeaf(layout.first, leafId) ?? findLeaf(layout.second, leafId)
}

export function findLeafForTarget(layout: LayoutNode, target: ConversationTarget): LayoutLeaf | null {
  return collectLeaves(layout).find((leaf) => leaf.target === target) ?? null
}

export function findFirstLeaf(layout: LayoutNode): LayoutLeaf {
  if (layout.type === 'leaf') return layout
  return findFirstLeaf(layout.first)
}

export function targetFromLegacySelection(selectedAgentKey: string | null): ConversationTarget {
  return selectedAgentKey ?? 'main'
}

export function legacySelectionFromTarget(target: ConversationTarget): string | null {
  return target === 'main' ? null : target
}

export function replaceLayoutNode(layout: LayoutNode, nodeId: string, replacement: LayoutNode): LayoutNode {
  if (layout.id === nodeId) return replacement
  if (layout.type === 'leaf') return layout
  return {
    ...layout,
    first: replaceLayoutNode(layout.first, nodeId, replacement),
    second: replaceLayoutNode(layout.second, nodeId, replacement)
  }
}

export function mapLayout(layout: LayoutNode, update: (leaf: LayoutLeaf) => LayoutLeaf): LayoutNode {
  if (layout.type === 'leaf') return update(layout)
  return {
    ...layout,
    first: mapLayout(layout.first, update),
    second: mapLayout(layout.second, update)
  }
}

export function assignTarget(layout: LayoutNode, leafId: string, target: ConversationTarget): LayoutNode {
  const current = findLeaf(layout, leafId)
  if (!current) return layout

  const displaced = current.target
  let next = mapLayout(layout, (leaf) => {
    if (leaf.id === leafId) return { ...leaf, target }
    if (leaf.target === target) return { ...leaf, target: displaced }
    return leaf
  })

  if (target !== 'main' && !findLeafForTarget(next, target)) {
    next = mapLayout(next, (leaf) => leaf.id === leafId ? { ...leaf, target } : leaf)
  }

  return next
}

export function splitLeaf(
  layout: LayoutNode,
  leafId: string,
  direction: 'row' | 'column',
  target: ConversationTarget,
  placeTargetIn: 'first' | 'second'
): LayoutNode {
  const edge = direction === 'row'
    ? (placeTargetIn === 'first' ? 'left' : 'right')
    : (placeTargetIn === 'first' ? 'top' : 'bottom')
  return splitLeafAtEdge(layout, leafId, edge, target)
}

export function splitLeafAtEdge(
  layout: LayoutNode,
  leafId: string,
  edge: Exclude<DropEdge, 'center'>,
  target: ConversationTarget
): LayoutNode {
  if (layout.type === 'leaf') {
    if (layout.id !== leafId) return layout
    const direction = edge === 'left' || edge === 'right' ? 'row' : 'column'
    const placeTargetIn = edge === 'left' || edge === 'top' ? 'first' : 'second'
    const existingTarget = layout.target
    const first = createLayoutLeaf(placeTargetIn === 'first' ? target : existingTarget)
    const second = createLayoutLeaf(placeTargetIn === 'second' ? target : existingTarget)
    let split: LayoutNode = {
      type: 'split',
      id: crypto.randomUUID(),
      direction,
      ratio: 0.5,
      first,
      second
    }
    split = assignTarget(split, placeTargetIn === 'first' ? first.id : second.id, target)
    return split
  }

  return {
    ...layout,
    first: splitLeafAtEdge(layout.first, leafId, edge, target),
    second: splitLeafAtEdge(layout.second, leafId, edge, target)
  }
}

export function setSplitRatio(layout: LayoutNode, splitId: string, ratio: number): LayoutNode {
  const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
  if (layout.type === 'leaf') return layout
  if (layout.id === splitId) return { ...layout, ratio: clamped }
  return {
    ...layout,
    first: setSplitRatio(layout.first, splitId, clamped),
    second: setSplitRatio(layout.second, splitId, clamped)
  }
}

export function removeTarget(layout: LayoutNode, target: ConversationTarget): LayoutNode {
  const leaves = collectLeaves(layout)
  if (leaves.length <= 1) {
    const only = leaves[0]
    return only ? createLayoutLeaf(only.target === target ? 'main' : only.target, only.id) : createDefaultLayout()
  }

  const without = leaves.filter((leaf) => leaf.target !== target)
  if (!without.length) return createDefaultLayout('main')

  let next: LayoutNode = createLayoutLeaf(without[0].target, without[0].id)
  for (let index = 1; index < without.length; index += 1) {
    const leaf = without[index]
    next = {
      type: 'split',
      id: crypto.randomUUID(),
      direction: 'row',
      ratio: 1 - index / without.length,
      first: next,
      second: createLayoutLeaf(leaf.target, leaf.id)
    }
  }
  return next
}

export function collapseToTarget(layout: LayoutNode, target: ConversationTarget): LayoutNode {
  const leaf = findLeafForTarget(layout, target) ?? findFirstLeaf(layout)
  return createLayoutLeaf(leaf.target, leaf.id)
}

export function serializeLayoutNode(layout: LayoutNode): SerializedLayoutNode {
  if (layout.type === 'leaf') {
    return { type: 'leaf', id: layout.id, target: layout.target }
  }
  return {
    type: 'split',
    id: layout.id,
    direction: layout.direction,
    ratio: layout.ratio,
    first: serializeLayoutNode(layout.first),
    second: serializeLayoutNode(layout.second)
  }
}

export function parseLayoutNode(value: unknown): LayoutNode | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<SerializedLayoutNode>
  if (record.type === 'leaf') {
    if (typeof record.id !== 'string' || typeof record.target !== 'string') return null
    return { type: 'leaf', id: record.id, target: record.target }
  }
  if (record.type === 'split') {
    if (
      typeof record.id !== 'string'
      || (record.direction !== 'row' && record.direction !== 'column')
      || typeof record.ratio !== 'number'
      || !Number.isFinite(record.ratio)
    ) return null
    const first = parseLayoutNode(record.first)
    const second = parseLayoutNode(record.second)
    if (!first || !second) return null
    return {
      type: 'split',
      id: record.id,
      direction: record.direction,
      ratio: Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, record.ratio)),
      first,
      second
    }
  }
  return null
}

export function normalizeLayout(layout: LayoutNode, validTargets: Set<ConversationTarget>): LayoutNode {
  const seen = new Set<ConversationTarget>()
  return mapLayout(layout, (leaf) => {
    let target = leaf.target
    if (target !== 'main' && !validTargets.has(target)) target = 'main'
    if (seen.has(target)) target = 'main'
    seen.add(target)
    return { ...leaf, target }
  })
}

export type DropProfile = 'wide' | 'tall' | 'balanced'

export function dropProfileForRect(rect: DOMRect): DropProfile {
  const width = Math.max(rect.width, 1)
  const height = Math.max(rect.height, 1)
  if (width / height > 1.15) return 'wide'
  if (height / width > 1.15) return 'tall'
  return 'balanced'
}

export function dropEdgeFromGrid(
  rect: DOMRect,
  clientX: number,
  clientY: number
): DropEdge {
  const x = (clientX - rect.left) / Math.max(rect.width, 1)
  const y = (clientY - rect.top) / Math.max(rect.height, 1)

  const col = x < 1 / 3 ? 0 : x > 2 / 3 ? 2 : 1
  const row = y < 1 / 3 ? 0 : y > 2 / 3 ? 2 : 1

  if (col === 0) return 'left'
  if (col === 2) return 'right'
  if (row === 0) return 'top'
  if (row === 2) return 'bottom'
  return 'center'
}

export function dropEdgeFromProfile(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  profile: DropProfile = dropProfileForRect(rect)
): DropEdge {
  const x = (clientX - rect.left) / Math.max(rect.width, 1)
  const y = (clientY - rect.top) / Math.max(rect.height, 1)

  if (profile === 'wide') {
    const band = Math.min(0.14, 48 / Math.max(rect.height, 1))
    if (y < band) return 'top'
    if (y > 1 - band) return 'bottom'
    if (x < 1 / 3) return 'left'
    if (x > 2 / 3) return 'right'
    return 'center'
  }

  if (profile === 'tall') {
    const band = Math.min(0.14, 48 / Math.max(rect.width, 1))
    if (x < band) return 'left'
    if (x > 1 - band) return 'right'
    if (y < 1 / 3) return 'top'
    if (y > 2 / 3) return 'bottom'
    return 'center'
  }

  return dropEdgeFromGrid(rect, clientX, clientY)
}

export function dropEdgeFromPoint(
  rect: DOMRect,
  clientX: number,
  clientY: number
): DropEdge {
  return dropEdgeFromProfile(rect, clientX, clientY)
}

export const conversationDragMime = 'application/x-codex-conversation-target'
