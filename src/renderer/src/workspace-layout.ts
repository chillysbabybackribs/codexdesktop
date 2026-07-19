import { splitLeaf, splitPaneKeys, type SplitNode } from './chat-split.ts';
import type { BrowserMiddleSide } from './main-chat-tabs.ts';

export type WorkspaceLayoutMode = 'chat-browser' | 'browser-middle';

export type BrowserMiddleColumnWidths = {
  left: number;
  right: number;
};

export type BrowserMiddleTabKeys = Record<BrowserMiddleSide, readonly string[]>;
export type BrowserMiddleActiveTabKeys = Record<BrowserMiddleSide, string | null>;

export const defaultBrowserMiddleColumnWidths: BrowserMiddleColumnWidths = {
  left: 26,
  right: 26,
};

export function parseWorkspaceLayoutMode(raw: string | null): WorkspaceLayoutMode {
  return raw === 'browser-middle' ? 'browser-middle' : 'chat-browser';
}

export function parseBrowserMiddleColumnWidths(raw: string | null): BrowserMiddleColumnWidths {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return defaultBrowserMiddleColumnWidths;
    const candidate = parsed as { left?: unknown; right?: unknown };
    if (!isValidColumnWidth(candidate.left) || !isValidColumnWidth(candidate.right)) {
      return defaultBrowserMiddleColumnWidths;
    }
    return { left: candidate.left, right: candidate.right };
  } catch {
    return defaultBrowserMiddleColumnWidths;
  }
}

export function serializeBrowserMiddleColumnWidths(widths: BrowserMiddleColumnWidths): string {
  return JSON.stringify(widths);
}

/**
 * Reuses the chat split tree for the centered-browser workspace: its root is
 * the left/right divide and each branch is one chat or an explicitly created
 * vertical stack. Each branch is supplied from its own tab collection, so the
 * headers never mirror each other and a selected tab stays on the side where
 * it was created.
 */
export function browserMiddleChatLayout(
  layout: SplitNode,
  tabKeys: BrowserMiddleTabKeys,
  activeKeys: BrowserMiddleActiveTabKeys,
): SplitNode {
  const leftBranch = branchForSide(layout, 'left');
  const rightBranch = branchForSide(layout, 'right');
  const leftKeys = visibleKeysForSide(leftBranch, tabKeys.left, activeKeys.left);
  const rightKeys = visibleKeysForSide(rightBranch, tabKeys.right, activeKeys.right);

  return {
    kind: 'split',
    direction: 'row',
    ratio: 0.5,
    first: stackColumn(leftKeys, leftBranch.kind === 'split' && leftBranch.explicit === true),
    second: stackColumn(rightKeys, rightBranch.kind === 'split' && rightBranch.explicit === true),
  };
}

/**
 * Make a newly created chat the only pane in its chat region. In the ordinary
 * workspace that means the whole chat surface; in browser-middle it collapses
 * only the originating column and leaves the opposite column untouched.
 */
export function showChatAtFullHeight(
  layout: SplitNode,
  tabKey: string,
  side: BrowserMiddleSide | null,
): SplitNode {
  if (!side) return splitLeaf(tabKey);
  if (layout.kind !== 'split' || layout.direction !== 'row') return splitLeaf(tabKey);
  return side === 'left'
    ? { ...layout, first: splitLeaf(tabKey) }
    : { ...layout, second: splitLeaf(tabKey) };
}

function visibleKeysForSide(
  branch: SplitNode,
  tabKeys: readonly string[],
  activeKey: string | null,
): string[] {
  const valid = new Set(tabKeys);
  let visible = unique(splitPaneKeys(branch).filter((key) => valid.has(key))).slice(0, 2);

  // Before split intent was persisted, adding a second tab automatically made
  // a vertical stack. Migrate those unmarked branches to the active full-height
  // chat; marked edge-drop/command splits continue to preserve both panes.
  if (visible.length > 1 && !(branch.kind === 'split' && branch.explicit === true)) {
    visible = [activeKey && valid.has(activeKey) ? activeKey : visible[0]!];
  }

  if (activeKey && valid.has(activeKey) && !visible.includes(activeKey)) {
    // Selecting or creating a tab must not create a split by itself. A single
    // visible chat is replaced at full height; only a split the user already
    // made by dragging keeps its primary pane while the active tab replaces
    // the secondary pane.
    return visible.length > 1 ? [visible[0]!, activeKey] : [activeKey];
  }

  if (visible.length) return visible;

  // A column with no usable saved pane still needs one chat. Prefer its
  // side-specific active tab, then fall back to the first tab assigned there.
  const fallback = activeKey && valid.has(activeKey) ? activeKey : tabKeys[0];
  return fallback ? [fallback] : [];
}

function stackColumn(keys: readonly string[], explicit: boolean): SplitNode {
  const [first, second] = keys;
  if (!second) return splitLeaf(first!);
  return {
    kind: 'split',
    direction: 'column',
    ...(explicit ? { explicit: true as const } : {}),
    ratio: 0.5,
    first: splitLeaf(first!),
    second: splitLeaf(second),
  };
}

function branchForSide(layout: SplitNode, side: BrowserMiddleSide): SplitNode {
  if (layout.kind !== 'split' || layout.direction !== 'row') return layout;
  return side === 'left' ? layout.first : layout.second;
}

function unique(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}

function isValidColumnWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 15 && value <= 40;
}
