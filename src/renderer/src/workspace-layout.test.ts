import assert from 'node:assert/strict';
import test from 'node:test';
import { splitLeaf, type SplitNode } from './chat-split.ts';
import {
  browserMiddleChatLayout,
  defaultBrowserMiddleColumnWidths,
  parseBrowserMiddleColumnWidths,
  parseWorkspaceLayoutMode,
  serializeBrowserMiddleColumnWidths,
  showChatAtFullHeight,
} from './workspace-layout.ts';

test('browser-middle creates a chat on both sides from a one-pane layout', () => {
  const result = browserMiddleChatLayout(
    splitLeaf('one'),
    { left: ['one'], right: ['two'] },
    { left: 'one', right: 'two' },
  );

  assert.deepEqual(result, {
    kind: 'split',
    direction: 'row',
    ratio: 0.5,
    first: splitLeaf('one'),
    second: splitLeaf('two'),
  });
});

test('browser-middle preserves columns and normalizes each side to a vertical stack', () => {
  const layout: SplitNode = {
    kind: 'split',
    direction: 'row',
    ratio: 0.62,
    first: {
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: splitLeaf('left-top'),
      second: splitLeaf('left-bottom'),
    },
    second: {
      kind: 'split',
      direction: 'column',
      ratio: 0.5,
      first: splitLeaf('right-top'),
      second: splitLeaf('right-bottom'),
    },
  };

  const result = browserMiddleChatLayout(
    layout,
    {
      left: ['left-top', 'left-bottom'],
      right: ['right-top', 'right-bottom'],
    },
    { left: 'left-top', right: 'right-top' },
  );

  assert.deepEqual(result, {
    kind: 'split',
    direction: 'row',
    ratio: 0.5,
    first: {
      kind: 'split',
      direction: 'column',
      ratio: 0.5,
      first: splitLeaf('left-top'),
      second: splitLeaf('left-bottom'),
    },
    second: {
      kind: 'split',
      direction: 'column',
      ratio: 0.5,
      first: splitLeaf('right-top'),
      second: splitLeaf('right-bottom'),
    },
  });
});

test('browser-middle opens a newly selected tab at full height in its own column', () => {
  const result = browserMiddleChatLayout(
    {
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: splitLeaf('left-one'),
      second: splitLeaf('right-one'),
    },
    {
      left: ['left-one', 'left-two'],
      right: ['right-one'],
    },
    { left: 'left-two', right: 'right-one' },
  );

  assert.deepEqual(result, {
    kind: 'split',
    direction: 'row',
    ratio: 0.5,
    first: splitLeaf('left-two'),
    second: splitLeaf('right-one'),
  });
});

test('browser-middle preserves a user-created stack when selecting another tab', () => {
  const result = browserMiddleChatLayout(
    {
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: {
        kind: 'split',
        direction: 'column',
        ratio: 0.5,
        first: splitLeaf('left-primary'),
        second: splitLeaf('left-secondary'),
      },
      second: splitLeaf('right-one'),
    },
    {
      left: ['left-primary', 'left-secondary', 'left-next'],
      right: ['right-one'],
    },
    { left: 'left-next', right: 'right-one' },
  );

  assert.deepEqual(result, {
    kind: 'split',
    direction: 'row',
    ratio: 0.5,
    first: {
      kind: 'split',
      direction: 'column',
      ratio: 0.5,
      first: splitLeaf('left-primary'),
      second: splitLeaf('left-next'),
    },
    second: splitLeaf('right-one'),
  });
});

test('a new chat collapses only its browser-middle column to full height', () => {
  const rightColumn: SplitNode = {
    kind: 'split',
    direction: 'column',
    ratio: 0.5,
    first: splitLeaf('right-top'),
    second: splitLeaf('right-bottom'),
  };
  const layout: SplitNode = {
    kind: 'split',
    direction: 'row',
    ratio: 0.5,
    first: {
      kind: 'split',
      direction: 'column',
      ratio: 0.5,
      first: splitLeaf('left-top'),
      second: splitLeaf('left-bottom'),
    },
    second: rightColumn,
  };

  assert.deepEqual(showChatAtFullHeight(layout, 'left-new', 'left'), {
    ...layout,
    first: splitLeaf('left-new'),
    second: rightColumn,
  });
  assert.deepEqual(showChatAtFullHeight(layout, 'standalone-new', null), splitLeaf('standalone-new'));
});

test('workspace-layout persistence rejects malformed values', () => {
  assert.equal(parseWorkspaceLayoutMode('browser-middle'), 'browser-middle');
  assert.equal(parseWorkspaceLayoutMode('anything-else'), 'chat-browser');
  assert.deepEqual(parseBrowserMiddleColumnWidths(null), defaultBrowserMiddleColumnWidths);
  assert.deepEqual(parseBrowserMiddleColumnWidths('{"left":28,"right":24}'), { left: 28, right: 24 });
  assert.deepEqual(parseBrowserMiddleColumnWidths('{"left":2,"right":24}'), defaultBrowserMiddleColumnWidths);
  assert.equal(
    serializeBrowserMiddleColumnWidths({ left: 28, right: 24 }),
    '{"left":28,"right":24}',
  );
});
