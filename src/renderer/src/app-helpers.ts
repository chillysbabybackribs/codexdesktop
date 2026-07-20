import type {
  CodexErrorInfo,
  Model,
  ProviderId,
  Thread,
  ThreadGoal,
} from '../../shared/session-protocol';
import type { TurnMeta } from './TaskActivity';

export const defaultThreadTitle = 'New Chat';
const maxProvisionalThreadTitleLength = 72;

export function modelAcceptsImages(models: Model[], model: string | null): boolean {
  const selected = models.find((candidate) => candidate.model === model || candidate.id === model);
  return !selected || selected.inputModalities.includes('image');
}

export function resolveModelEntry(models: Model[], modelId: string | null): Model | undefined {
  if (modelId) {
    return models.find((candidate) => candidate.model === modelId || candidate.id === modelId);
  }
  return models.find((candidate) => candidate.isDefault) ?? models[0];
}

export function resolveModelProvider(models: Model[], modelId: string | null): ProviderId {
  return resolveModelEntry(models, modelId)?.providerId ?? 'codex';
}

export function providerDisplayName(providerId: ProviderId): string {
  return providerId === 'claude' ? 'Claude Code' : 'Codex';
}

export function steerComposerPlaceholder(providerId: ProviderId): string {
  return `Add guidance while ${providerDisplayName(providerId)} works…`;
}

export function isTerminalTurnStatus(status: TurnMeta['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

export function hasObservedTerminalTurn(
  turnMeta: Readonly<Record<string, TurnMeta>>,
  turnId: string,
): boolean {
  const status = turnMeta[turnId]?.status;
  return status ? isTerminalTurnStatus(status) : false;
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
  return stripSkillMarkerFromTitle(thread.name || thread.preview || defaultThreadTitle);
}

// A new thread has no server-generated name yet, but its first prompt is
// already useful navigation context. Keep it short enough for a compact tab;
// the eventual thread/name/updated notification remains authoritative.
export function provisionalThreadTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  const title = stripSkillMarkerFromTitle(normalized);
  if (title.length <= maxProvisionalThreadTitleLength) return title;

  const clipped = title.slice(0, maxProvisionalThreadTitleLength - 1).trimEnd();
  const boundary = clipped.lastIndexOf(' ');
  const readable = boundary >= Math.floor(maxProvisionalThreadTitleLength / 2)
    ? clipped.slice(0, boundary)
    : clipped;
  return `${readable.trimEnd()}…`;
}

// A thread/start response may still contain only the placeholder name. Do not
// let that transient metadata overwrite the prompt-derived title the user just
// saw; a real name notification replaces it normally.
export function resolveThreadTitle(remoteTitle: string, currentTitle: string): string {
  const current = currentTitle.trim();
  return remoteTitle === defaultThreadTitle && current && current !== defaultThreadTitle
    ? current
    : remoteTitle;
}

function stripSkillMarkerFromTitle(title: string): string {
  return title.replace(/^\$artifact-first-web-research\s*/i, '') || defaultThreadTitle;
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
