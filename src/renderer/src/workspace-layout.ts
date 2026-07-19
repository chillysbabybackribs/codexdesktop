import { splitLeaf, splitPaneKeys, type SplitNode } from './chat-split.ts';

export type WorkspaceLayoutMode = 'chat-browser' | 'browser-middle';

export type BrowserMiddleColumnWidths = {
  left: number;
  right: number;
};

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
 * the left/right divide and each branch is a vertical stack. A single visible
 * chat is paired with the next open tab, so entering the mode always exposes
 * a chat on each side of the browser.
 */
export function browserMiddleChatLayout(
  layout: SplitNode,
  tabKeys: readonly string[],
  activeKey: string,
): SplitNode {
  const valid = new Set(tabKeys);
  const visible = unique(splitPaneKeys(layout).filter((key) => valid.has(key)));
  const ordered = unique([
    ...visible,
    ...tabKeys.filter((key) => !visible.includes(key)),
  ]).slice(0, 4);

  if (valid.has(activeKey) && !ordered.includes(activeKey)) {
    ordered.unshift(activeKey);
  }

  const keys = ordered.slice(0, 4);
  if (keys.length < 2) return splitLeaf(keys[0] ?? activeKey);

  if (layout.kind === 'split' && layout.direction === 'row') {
    const left = keysIn(layout.first, valid);
    const right = keysIn(layout.second, valid);
    if (left.length && right.length) {
      return {
        kind: 'split',
        direction: 'row',
        ratio: 0.5,
        first: stackColumn(left),
        second: stackColumn(right),
      };
    }
  }

  return {
    kind: 'split',
    direction: 'row',
    ratio: 0.5,
    first: stackColumn(keys.filter((_, index) => index % 2 === 0)),
    second: stackColumn(keys.filter((_, index) => index % 2 === 1)),
  };
}

function keysIn(node: SplitNode, valid: ReadonlySet<string>): string[] {
  return unique(splitPaneKeys(node).filter((key) => valid.has(key))).slice(0, 2);
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
