import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearComposerInteractionState,
  defaultComposerAction,
  effectiveComposerAction,
  getQueuedComposerMessage,
  hasStashedComposerDraft,
  listComposerPrompts,
  recordComposerPrompt,
  setQueuedComposerMessage,
  stashComposerDraft,
  takeStashedComposerDraft,
} from './composer-interactions.ts';

test('active-turn actions respect provider steering and attachment constraints', () => {
  assert.equal(defaultComposerAction('codex'), 'steer');
  assert.equal(defaultComposerAction('claude'), 'queue');
  assert.equal(effectiveComposerAction('steer', 0), 'steer');
  assert.equal(effectiveComposerAction('steer', 1), 'queue');
  assert.equal(effectiveComposerAction('stop-send', 1), 'stop-send');
});

test('composer prompt history is newest-first, deduplicated, and searchable', () => {
  const key = 'history';
  recordComposerPrompt(key, 'Fix the renderer');
  recordComposerPrompt(key, 'Run the build');
  recordComposerPrompt(key, 'Fix the renderer');

  assert.deepEqual(listComposerPrompts(key), ['Fix the renderer', 'Run the build']);
  assert.deepEqual(listComposerPrompts(key, 'BUILD'), ['Run the build']);
  clearComposerInteractionState(key);
});

test('stashed composer drafts restore once with attachments and mentions intact', () => {
  const key = 'stash';
  const attachment = {
    id: 'image-1',
    kind: 'image' as const,
    name: 'screen.png',
    path: '/tmp/screen.png',
    mediaType: 'image/png',
    size: 42,
  };
  stashComposerDraft(key, {
    value: 'Remember this',
    attachments: [attachment],
    mentions: [{ path: 'src/App.tsx', kind: 'file' }],
  });

  assert.equal(hasStashedComposerDraft(key), true);
  assert.deepEqual(takeStashedComposerDraft(key), {
    value: 'Remember this',
    attachments: [attachment],
    mentions: [{ path: 'src/App.tsx', kind: 'file' }],
  });
  assert.equal(takeStashedComposerDraft(key), null);
  clearComposerInteractionState(key);
});

test('a queued composer message can be replaced or cleared by draft key', () => {
  const key = 'queue';
  const message = { text: 'Next task', displayText: 'Next task', attachments: [], mentions: [] };
  setQueuedComposerMessage(key, message);
  assert.deepEqual(getQueuedComposerMessage(key), message);
  setQueuedComposerMessage(key, null);
  assert.equal(getQueuedComposerMessage(key), null);
  clearComposerInteractionState(key);
});
