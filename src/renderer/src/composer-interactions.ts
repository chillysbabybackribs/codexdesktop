import type { ChatAttachment } from '../../shared/ipc';
import type { FileMention } from './mention-model';

export type ComposerActionMode = 'steer' | 'queue' | 'stop-send';

export type QueuedComposerMessage = {
  text: string;
  displayText: string;
  attachments: ChatAttachment[];
};

export type StashedComposerDraft = {
  value: string;
  attachments: ChatAttachment[];
  mentions: FileMention[];
};

const maxHistoryEntries = 100;
const promptHistory = new Map<string, string[]>();
const stashedDrafts = new Map<string, StashedComposerDraft>();
const queuedMessages = new Map<string, QueuedComposerMessage>();

export function recordComposerPrompt(key: string, prompt: string): void {
  const normalized = prompt.trim();
  if (!normalized) return;
  const current = promptHistory.get(key) ?? [];
  promptHistory.set(
    key,
    [normalized, ...current.filter((entry) => entry !== normalized)].slice(0, maxHistoryEntries),
  );
}

export function listComposerPrompts(key: string, query = ''): string[] {
  const normalized = query.trim().toLowerCase();
  const entries = promptHistory.get(key) ?? [];
  if (!normalized) return [...entries];
  return entries.filter((entry) => entry.toLowerCase().includes(normalized));
}

export function stashComposerDraft(key: string, draft: StashedComposerDraft): void {
  stashedDrafts.set(key, {
    value: draft.value,
    attachments: [...draft.attachments],
    mentions: [...draft.mentions],
  });
}

export function takeStashedComposerDraft(key: string): StashedComposerDraft | null {
  const draft = stashedDrafts.get(key);
  if (!draft) return null;
  stashedDrafts.delete(key);
  return {
    value: draft.value,
    attachments: [...draft.attachments],
    mentions: [...draft.mentions],
  };
}

export function hasStashedComposerDraft(key: string): boolean {
  return stashedDrafts.has(key);
}

export function setQueuedComposerMessage(
  key: string,
  message: QueuedComposerMessage | null,
): void {
  if (message) queuedMessages.set(key, message);
  else queuedMessages.delete(key);
}

export function getQueuedComposerMessage(key: string): QueuedComposerMessage | null {
  return queuedMessages.get(key) ?? null;
}

export function clearComposerInteractionState(key: string): void {
  promptHistory.delete(key);
  stashedDrafts.delete(key);
  queuedMessages.delete(key);
}

