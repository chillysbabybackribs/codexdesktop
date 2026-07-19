import type { CodexErrorInfo, Model, Thread, ThreadGoal } from '../../shared/session-protocol';
import type { TurnMeta } from './TaskActivity';

export function modelAcceptsImages(models: Model[], model: string | null): boolean {
  const selected = models.find((candidate) => candidate.model === model || candidate.id === model);
  return !selected || selected.inputModalities.includes('image');
}

export function isTerminalTurnStatus(status: TurnMeta['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export function isRecoverableTurnError(info: CodexErrorInfo | null): boolean {
  if (!info) return false;
  if (info === 'serverOverloaded' || info === 'internalServerError') return true;
  return typeof info === 'object' && 'responseTooManyFailedAttempts' in info;
}

export function cloneGoal(goal: ThreadGoal | null): ThreadGoal | null {
  return goal ? { ...goal } : null;
}

export function threadTitle(thread: Thread): string {
  return stripSkillMarkerFromTitle(thread.name || thread.preview || 'New Chat');
}

function stripSkillMarkerFromTitle(title: string): string {
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
  if (then >= startOfToday.getTime() - 6 * dayMs) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(then);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(then);
}
