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
 * the left/right divide and each branch is a vertical stack. Each branch is
 * supplied from its own tab collection, so the headers never mirror each
 * other and a selected tab stays on the side where it was created.
 */
export function browserMiddleChatLayout(
  layout: SplitNode,
  tabKeys: BrowserMiddleTabKeys,
  activeKeys: BrowserMiddleActiveTabKeys,
): SplitNode {
  const leftKeys = visibleKeysForSide(layout, 'left', tabKeys.left, activeKeys.left);
  const rightKeys = visibleKeysForSide(layout, 'right', tabKeys.right, activeKeys.right);

  return {
    kind: 'split',
    direction: 'row',
    ratio: 0.5,
    first: stackColumn(leftKeys),
    second: stackColumn(rightKeys),
  };
}

function visibleKeysForSide(
  layout: SplitNode,
  side: BrowserMiddleSide,
  tabKeys: readonly string[],
  activeKey: string | null,
): string[] {
  const valid = new Set(tabKeys);
  const branch =
    layout.kind === 'split' && layout.direction === 'row'
      ? side === 'left'
        ? layout.first
        : layout.second
      : layout;
  const visible = unique(splitPaneKeys(branch).filter((key) => valid.has(key))).slice(0, 2);

  if (activeKey && valid.has(activeKey) && !visible.includes(activeKey)) {
    // A selected hidden tab replaces the lower pane, preserving the primary
    // pane while ensuring every header selection has a visible conversation.
    return unique([...visible.slice(0, 1), activeKey, ...tabKeys]).slice(0, 2);
  }

  return unique([...visible, ...tabKeys]).slice(0, 2);
}

function stackColumn(keys: readonly string[]): SplitNode {
  const [first, second] = keys;
  if (!second) return splitLeaf(first!);
  return {
    kind: 'split',
    direction: 'column',
    ratio: 0.5,
    first: splitLeaf(first!),
    second: splitLeaf(second),
  };
}

function unique(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}

function isValidColumnWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 15 && value <= 40;
}
