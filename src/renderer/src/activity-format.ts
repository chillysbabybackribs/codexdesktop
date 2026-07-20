import type { ItemMeta, WorkItem } from './activity-model';

export function fmtDuration(ms: number): string {
  if (ms < 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function basename(path: string): string {
  const clean = path.replace(/\/+$/, '');
  return clean.split('/').pop() || clean;
}

export function dirOf(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  return index > 0 ? clean.slice(0, index) : '';
}

// Directory label for file cards: relative to the workspace when inside it
// (Cursor-style), absolute otherwise. Empty at the workspace root.
export function displayDir(path: string, workspace: string | null): string {
  const dir = dirOf(path);
  if (!dir || !workspace) {
    return dir;
  }
  const root = workspace.replace(/\/+$/, '');
  if (dir === root) {
    return '';
  }
  if (dir.startsWith(`${root}/`)) {
    return dir.slice(root.length + 1);
  }
  return dir;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches ANSI escape sequences to strip them
export const ansiPattern = /\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ansiPattern, '');
}

export function previewJson(value: unknown, max: number): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text || text === '{}' || text === 'null') {
      return null;
    }
    return truncate(text, max);
  } catch {
    return null;
  }
}

export function itemDurationMs(item: WorkItem, meta: ItemMeta | undefined): number | null {
  if ('durationMs' in item && typeof item.durationMs === 'number') {
    return item.durationMs;
  }
  if (meta?.startedAtMs && meta?.completedAtMs) {
    return Math.max(0, meta.completedAtMs - meta.startedAtMs);
  }
  return null;
}

type ReasoningWorkItem = Extract<WorkItem, { type: 'reasoning' }>;

export type WorkDisplayGroup =
  | { kind: 'reasoning'; items: ReasoningWorkItem[] }
  | { kind: 'item'; item: WorkItem };

export function groupAdjacentReasoning(items: WorkItem[]): WorkDisplayGroup[] {
  const groups: WorkDisplayGroup[] = [];

  for (const item of items) {
    const previous = groups[groups.length - 1];
    if (item.type === 'reasoning') {
      if (previous?.kind === 'reasoning') {
        previous.items.push(item);
      } else {
        groups.push({ kind: 'reasoning', items: [item] });
      }
      continue;
    }
    groups.push({ kind: 'item', item });
  }

  return groups;
}

export function reasoningGroupDurationMs(
  items: ReasoningWorkItem[],
  itemMeta: Record<string, ItemMeta>,
): number | null {
  const firstStartedAt = items.find((item) => itemMeta[item.id]?.startedAtMs)?.id;
  const lastCompletedAt = [...items].reverse().find((item) => itemMeta[item.id]?.completedAtMs)?.id;
  const startedAtMs = firstStartedAt ? itemMeta[firstStartedAt]?.startedAtMs : null;
  const completedAtMs = lastCompletedAt ? itemMeta[lastCompletedAt]?.completedAtMs : null;

  return startedAtMs !== null &&
    startedAtMs !== undefined &&
    completedAtMs !== null &&
    completedAtMs !== undefined
    ? Math.max(0, completedAtMs - startedAtMs)
    : null;
}

// Effective display status: items abandoned by an interrupted/failed turn keep
// status "inProgress" forever — once the turn is no longer live they render as
// stopped, not running.
export type BlockStatus = 'running' | 'done' | 'failed' | 'declined' | 'stopped';

export function blockStatus(item: WorkItem, live: boolean): BlockStatus {
  const raw =
    item.type === 'commandExecution' ||
    item.type === 'fileChange' ||
    item.type === 'mcpToolCall' ||
    item.type === 'dynamicToolCall'
      ? item.status
      : null;

  if (raw === 'failed') {
    return 'failed';
  }
  if (raw === 'declined') {
    return 'declined';
  }
  if (raw === 'inProgress') {
    return live ? 'running' : 'stopped';
  }
  return 'done';
}
