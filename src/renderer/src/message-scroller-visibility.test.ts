import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMessageScrollerSnapshot } from './message-scroller-visibility.ts';

test('keeps the latest turn above the reading line as the current anchor', () => {
  assert.deepEqual(
    resolveMessageScrollerSnapshot({
      anchors: [
        { id: 'turn-1', top: -600, bottom: -540 },
        { id: 'turn-2', top: 34, bottom: 82 },
        { id: 'turn-3', top: 760, bottom: 820 },
      ],
      messages: [
        { id: 'turn-1', top: -500, bottom: 20 },
        { id: 'turn-2', top: 34, bottom: 690 },
        { id: 'turn-3', top: 760, bottom: 820 },
      ],
      viewportTop: 0,
      viewportBottom: 700,
    }),
    { currentAnchorId: 'turn-2', visibleMessageIds: ['turn-1', 'turn-2'] },
  );
});

test('uses the first anchor before any turn reaches the reading line', () => {
  assert.deepEqual(
    resolveMessageScrollerSnapshot({
      anchors: [{ id: 'turn-1', top: 120, bottom: 180 }],
      messages: [{ id: 'turn-1', top: 120, bottom: 640 }],
      viewportTop: 0,
      viewportBottom: 700,
    }),
    { currentAnchorId: 'turn-1', visibleMessageIds: ['turn-1'] },
  );
});

test('deduplicates visible rows that belong to the same turn', () => {
  assert.deepEqual(
    resolveMessageScrollerSnapshot({
      anchors: [{ id: 'turn-1', top: -40, bottom: 20 }],
      messages: [
        { id: 'turn-1', top: -40, bottom: 20 },
        { id: 'turn-1', top: 20, bottom: 300 },
      ],
      viewportTop: 0,
      viewportBottom: 700,
    }),
    { currentAnchorId: 'turn-1', visibleMessageIds: ['turn-1'] },
  );
});
