// Split-view layout for main chats: a tiny binary tree of panes. Depth is
// capped at 2 and leaves at 4, which yields exactly the useful shapes — one
// full pane, two side by side, two stacked, three with one large, and four
// quadrants — while keeping every operation a short recursion.

export type SplitDirection = 'row' | 'column'

export type SplitDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export type SplitPaneLeaf = { kind: 'pane'; tabKey: string }

export type SplitBranch = {
  kind: 'split'
  direction: SplitDirection
  // Fraction of the container given to `first`, clamped so no pane collapses.
  ratio: number
  first: SplitNode
  second: SplitNode
}

export type SplitNode = SplitPaneLeaf | SplitBranch

export const maxSplitPanes = 4
export const maxSplitDepth = 2
export const minSplitRatio = 0.15
export const maxSplitRatio = 0.85

export function splitLeaf(tabKey: string): SplitNode {
  return { kind: 'pane', tabKey }
}

export function clampSplitRatio(ratio: number): number {
  return Math.min(maxSplitRatio, Math.max(minSplitRatio, ratio))
}

export function splitPaneKeys(node: SplitNode): string[] {
  if (node.kind === 'pane') return [node.tabKey]
  return [...splitPaneKeys(node.first), ...splitPaneKeys(node.second)]
}

export function countSplitPanes(node: SplitNode): number {
  return splitPaneKeys(node).length
}

export function splitHasPane(node: SplitNode, tabKey: string): boolean {
  if (node.kind === 'pane') return node.tabKey === tabKey
  return splitHasPane(node.first, tabKey) || splitHasPane(node.second, tabKey)
}

export function splitPaneDepth(node: SplitNode, tabKey: string, depth = 0): number | null {
  if (node.kind === 'pane') return node.tabKey === tabKey ? depth : null
  return (
    splitPaneDepth(node.first, tabKey, depth + 1) ?? splitPaneDepth(node.second, tabKey, depth + 1)
  )
}

/**
 * Remove a pane and collapse its parent split to the sibling. Removing the
 * root leaf (or a missing key) returns the node unchanged — a layout always
 * shows at least one pane, so the caller decides what a "last pane" means.
 */
export function removeSplitPane(node: SplitNode, tabKey: string): SplitNode {
  if (node.kind === 'pane') return node
  if (node.first.kind === 'pane' && node.first.tabKey === tabKey) return node.second
  if (node.second.kind === 'pane' && node.second.tabKey === tabKey) return node.first
  const first = removeSplitPane(node.first, tabKey)
  const second = removeSplitPane(node.second, tabKey)
  if (first === node.first && second === node.second) return node
  return { ...node, first, second }
}

/**
 * Show `nextKey` where `targetKey` currently is. When `nextKey` is already
 * visible in another pane the two panes swap contents, so a chat is never
 * shown twice.
 */
export function replaceSplitPane(node: SplitNode, targetKey: string, nextKey: string): SplitNode {
  if (targetKey === nextKey || !splitHasPane(node, targetKey)) return node
  const mapNode = (candidate: SplitNode): SplitNode => {
    if (candidate.kind === 'pane') {
      if (candidate.tabKey === targetKey) return { kind: 'pane', tabKey: nextKey }
      if (candidate.tabKey === nextKey) return { kind: 'pane', tabKey: targetKey }
      return candidate
    }
    const first = mapNode(candidate.first)
    const second = mapNode(candidate.second)
    if (first === candidate.first && second === candidate.second) return candidate
    return { ...candidate, first, second }
  }
  return mapNode(node)
}

/**
 * Whether dropping `sourceKey` on one of `targetKey`'s edges may split that
 * pane. Judged on the tree as it would look after the drop plucks the source
 * out of its current pane, so moving a pane within a full 2x2 grid stays
 * possible.
 */
export function canSplitPaneForDrop(
  node: SplitNode,
  targetKey: string,
  sourceKey: string,
): boolean {
  if (targetKey === sourceKey) return false
  const base = splitHasPane(node, sourceKey) ? removeSplitPane(node, sourceKey) : node
  const depth = splitPaneDepth(base, targetKey)
  if (depth === null) return false
  return countSplitPanes(base) < maxSplitPanes && depth < maxSplitDepth
}

/**
 * Split `targetKey`'s pane along the dropped edge and show `sourceKey` in the
 * new half. A source already visible elsewhere is moved, not duplicated.
 * Returns the node unchanged when the drop is not allowed.
 */
export function insertSplitPane(
  node: SplitNode,
  targetKey: string,
  sourceKey: string,
  edge: Exclude<SplitDropZone, 'center'>,
): SplitNode {
  if (!canSplitPaneForDrop(node, targetKey, sourceKey)) return node
  const base = splitHasPane(node, sourceKey) ? removeSplitPane(node, sourceKey) : node
  const direction: SplitDirection = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const before = edge === 'left' || edge === 'top'
  const mapNode = (candidate: SplitNode): SplitNode => {
    if (candidate.kind === 'pane') {
      if (candidate.tabKey !== targetKey) return candidate
      const added: SplitNode = { kind: 'pane', tabKey: sourceKey }
      return {
        kind: 'split',
        direction,
        ratio: 0.5,
        first: before ? added : candidate,
        second: before ? candidate : added,
      }
    }
    const first = mapNode(candidate.first)
    const second = mapNode(candidate.second)
    if (first === candidate.first && second === candidate.second) return candidate
    return { ...candidate, first, second }
  }
  return mapNode(base)
}

/**
 * Resize the split at `path` — a string of 'f'/'s' steps from the root — to
 * the given first-child fraction.
 */
export function updateSplitRatio(node: SplitNode, path: string, ratio: number): SplitNode {
  if (node.kind !== 'split') return node
  if (!path) {
    const clamped = clampSplitRatio(ratio)
    return clamped === node.ratio ? node : { ...node, ratio: clamped }
  }
  const rest = path.slice(1)
  if (path[0] === 'f') {
    const first = updateSplitRatio(node.first, rest, ratio)
    return first === node.first ? node : { ...node, first }
  }
  if (path[0] === 's') {
    const second = updateSplitRatio(node.second, rest, ratio)
    return second === node.second ? node : { ...node, second }
  }
  return node
}

/**
 * First pane key of the subtree that sits beside `tabKey` in its parent
 * split — the natural focus target when that pane closes.
 */
export function adjacentSplitPaneKey(node: SplitNode, tabKey: string): string | null {
  const findSibling = (candidate: SplitNode): SplitNode | null => {
    if (candidate.kind === 'pane') return null
    if (candidate.first.kind === 'pane' && candidate.first.tabKey === tabKey) return candidate.second
    if (candidate.second.kind === 'pane' && candidate.second.tabKey === tabKey)
      return candidate.first
    return findSibling(candidate.first) ?? findSibling(candidate.second)
  }
  const sibling = findSibling(node)
  return sibling ? splitPaneKeys(sibling)[0] : null
}

/**
 * Which drop zone a pointer position maps to inside a pane. Outside the rect
 * returns null; when splitting is not allowed everything reads as a center
 * (replace) drop.
 */
export function splitDropZoneAt(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  allowSplit: boolean,
): SplitDropZone | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const fx = (x - rect.left) / rect.width
  const fy = (y - rect.top) / rect.height
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null
  if (!allowSplit) return 'center'
  const edgeBand = 0.28
  const candidates: Array<[number, SplitDropZone]> = [
    [fx, 'left'],
    [1 - fx, 'right'],
    [fy, 'top'],
    [1 - fy, 'bottom'],
  ]
  candidates.sort((first, second) => first[0] - second[0])
  const [distance, zone] = candidates[0]
  return distance <= edgeBand ? zone : 'center'
}

/**
 * Force a layout back to its invariants against the current tab set: every
 * pane shows an existing tab, no tab is shown twice, size caps hold, and the
 * active tab is visible — preferring to appear where `preferredPaneKey`
 * (the previously focused pane) is showing. Returns the same reference when
 * nothing changes.
 */
export function reconcileChatSplitLayout(
  node: SplitNode,
  validKeys: readonly string[],
  activeKey: string,
  preferredPaneKey: string | null,
): SplitNode {
  const valid = new Set(validKeys)
  const seen = new Set<string>()
  const takeLeaf = (tabKey: string): boolean => {
    if (!valid.has(tabKey) || seen.has(tabKey) || seen.size >= maxSplitPanes) return false
    seen.add(tabKey)
    return true
  }
  const prune = (candidate: SplitNode, depth: number): SplitNode | null => {
    if (candidate.kind === 'pane') {
      return takeLeaf(candidate.tabKey) ? candidate : null
    }
    if (depth >= maxSplitDepth) {
      // Deeper than the cap (corrupt storage): keep the subtree's first
      // usable pane only.
      for (const key of splitPaneKeys(candidate)) {
        if (takeLeaf(key)) return { kind: 'pane', tabKey: key }
      }
      return null
    }
    const first = prune(candidate.first, depth + 1)
    const second = prune(candidate.second, depth + 1)
    if (first && second) {
      if (first === candidate.first && second === candidate.second) return candidate
      return { ...candidate, first, second }
    }
    return first ?? second
  }

  let next = prune(node, 0) ?? splitLeaf(activeKey)
  if (valid.has(activeKey) && !splitHasPane(next, activeKey)) {
    const anchor =
      preferredPaneKey && splitHasPane(next, preferredPaneKey)
        ? preferredPaneKey
        : splitPaneKeys(next)[0]
    next = replaceSplitPane(next, anchor, activeKey)
  }
  return next
}

export function serializeChatSplitLayout(node: SplitNode): string {
  return JSON.stringify(node)
}

export function parseChatSplitLayout(
  raw: string | null,
  validKeys: readonly string[],
  activeKey: string,
): SplitNode {
  let parsed: unknown = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    parsed = null
  }
  const node = sanitizeSplitNode(parsed) ?? splitLeaf(activeKey)
  return reconcileChatSplitLayout(node, validKeys, activeKey, null)
}

function sanitizeSplitNode(value: unknown): SplitNode | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as {
    kind?: unknown
    tabKey?: unknown
    direction?: unknown
    ratio?: unknown
    first?: unknown
    second?: unknown
  }
  if (candidate.kind === 'pane') {
    return typeof candidate.tabKey === 'string' && candidate.tabKey
      ? { kind: 'pane', tabKey: candidate.tabKey }
      : null
  }
  if (candidate.kind === 'split') {
    const first = sanitizeSplitNode(candidate.first)
    const second = sanitizeSplitNode(candidate.second)
    if (!first || !second) return first ?? second
    return {
      kind: 'split',
      direction: candidate.direction === 'column' ? 'column' : 'row',
      ratio:
        typeof candidate.ratio === 'number' && Number.isFinite(candidate.ratio)
          ? clampSplitRatio(candidate.ratio)
          : 0.5,
      first,
      second,
    }
  }
  return null
}
