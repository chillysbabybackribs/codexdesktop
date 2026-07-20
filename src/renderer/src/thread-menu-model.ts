import type { Thread } from '../../shared/session-protocol';

export type ThreadGroup = { label: string; threads: Thread[] };

export type HeaderMenuCommandId =
  | 'browser-layout'
  | 'split-right'
  | 'split-down'
  | 'history'
  | 'settings';

export type HeaderMenuCommand = {
  id: HeaderMenuCommandId;
  label: string;
  hint: string | null;
  disabled: boolean;
};

export function headerMenuCommands(options: {
  isBrowserMiddle: boolean;
  canSplitActivePane: boolean;
  disabled: boolean;
  showGlobalActions: boolean;
}): HeaderMenuCommand[] {
  const commands: HeaderMenuCommand[] = [
    {
      id: 'browser-layout',
      label: options.isBrowserMiddle ? 'Move browser right' : 'Center browser',
      hint: options.isBrowserMiddle ? 'Return to two columns' : 'Place browser between chats',
      disabled: options.disabled,
    },
    {
      id: 'split-right',
      label: 'Split chat right',
      hint: 'Ctrl+\\',
      disabled: options.disabled || !options.canSplitActivePane,
    },
    {
      id: 'split-down',
      label: 'Split chat down',
      hint: 'Ctrl+Shift+\\',
      disabled: options.disabled || !options.canSplitActivePane,
    },
  ];

  if (options.showGlobalActions) {
    commands.push(
      {
        id: 'history',
        label: 'Chat history',
        hint: null,
        disabled: false,
      },
      {
        id: 'settings',
        label: 'Settings',
        hint: null,
        disabled: false,
      },
    );
  }

  return commands;
}

export function threadTitle(thread: Thread): string {
  return stripSkillMarkerFromTitle(thread.name || thread.preview || 'New Chat');
}

export function stripSkillMarkerFromTitle(title: string): string {
  return title.replace(/^\$artifact-first-web-research\s*/i, '') || 'New Chat';
}

// Compact recency label for a thread row: "now", "5m", "3h" within a day, then
// "Yesterday", a weekday within the week, and a short date beyond that. Keeps
// rows scannable instead of repeating a full "Jul 9, 3:14 PM" on every line.
export function relativeThreadTime(seconds: number): string {
  const then = seconds * 1000;
  const diff = Date.now() - then;
  if (diff < 45_000) {
    return 'now';
  }
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) {
    return `${hours}h`;
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  if (then >= startOfToday.getTime() - dayMs) {
    return 'Yesterday';
  }
  if (diff < 7 * dayMs) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(then));
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(then),
  );
}

// Filters threads by the search query, sorts by recency, and buckets them into
// human recency bands (Today / Yesterday / Previous 7 days / Older). Returns the
// grouped view plus a flat id list in display order for keyboard navigation.
export function groupThreadsForMenu(
  threads: Thread[],
  query: string,
): { groups: ThreadGroup[]; flatIds: string[] } {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? threads.filter((thread) => threadTitle(thread).toLowerCase().includes(needle))
    : threads;

  const sorted = [...matched].sort(
    (a, b) => (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt),
  );

  const now = Date.now();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  const todayStart = startOfToday.getTime();
  const yesterdayStart = todayStart - dayMs;
  const weekStart = todayStart - 7 * dayMs;

  const buckets: ThreadGroup[] = [
    { label: 'Today', threads: [] },
    { label: 'Yesterday', threads: [] },
    { label: 'Previous 7 days', threads: [] },
    { label: 'Older', threads: [] },
  ];

  for (const thread of sorted) {
    const ms = (thread.recencyAt ?? thread.updatedAt) * 1000;
    if (ms >= todayStart) {
      buckets[0].threads.push(thread);
    } else if (ms >= yesterdayStart) {
      buckets[1].threads.push(thread);
    } else if (ms >= weekStart) {
      buckets[2].threads.push(thread);
    } else {
      buckets[3].threads.push(thread);
    }
  }

  const groups = buckets.filter((bucket) => bucket.threads.length > 0);
  const flatIds = groups.flatMap((group) => group.threads.map((thread) => thread.id));
  return { groups, flatIds };
}
