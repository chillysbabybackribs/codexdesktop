import type { ChatAttachment } from '../../shared/ipc';
import { clearComposerInteractionState } from './composer-interactions.js';
import type { FileMention } from './mention-model';

export type ComposerDraft = {
  value: string;
  attachments: ChatAttachment[];
  mentions?: FileMention[];
};

export const composerDrafts = new Map<string, ComposerDraft>();

export function discardComposerDraft(key: string): void {
  composerDrafts.delete(key);
  clearComposerInteractionState(key);
}
