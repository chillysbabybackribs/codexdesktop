import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadItem } from '../../shared/session-protocol/index.ts';
import type { ItemMeta } from './activity-model.ts';
import {
  basename,
  blockStatus,
  dirOf,
  displayDir,
  fmtDuration,
  fmtTokens,
  formatBytes,
  groupAdjacentReasoning,
  itemDurationMs,
  previewJson,
  reasoningGroupDurationMs,
  stripAnsi,
  truncate,
} from './activity-format.ts';

type CommandExecutionItem = Extract<ThreadItem, { type: 'commandExecution' }>;
type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>;
type ReasoningItem = Extract<ThreadItem, { type: 'reasoning' }>;

const commandItem = (over: Partial<CommandExecutionItem> = {}): CommandExecutionItem => ({
  type: 'commandExecution',
  id: 'cmd-1',
  command: 'echo hi',
  cwd: '/ws',
  processId: null,
  source: 'agent',
  status: 'completed',
  commandActions: [],
  aggregatedOutput: null,
  exitCode: 0,
  durationMs: null,
  ...over,
});

const fileItem = (over: Partial<FileChangeItem> = {}): FileChangeItem => ({
  type: 'fileChange',
  id: 'file-1',
  changes: [],
  status: 'completed',
  ...over,
});

const reasoningItem: ReasoningItem = {
  type: 'reasoning',
  id: 'thought-1',
  summary: ['Considering'],
  content: [],
};

test('fmtDuration renders sub-second, seconds, and minute forms', () => {
  assert.equal(fmtDuration(0), '0.0s');
  assert.equal(fmtDuration(500), '0.5s');
  assert.equal(fmtDuration(999), '1.0s');
  assert.equal(fmtDuration(1000), '1s');
  assert.equal(fmtDuration(59_000), '59s');
  assert.equal(fmtDuration(59_600), '1m 00s');
  assert.equal(fmtDuration(65_000), '1m 05s');
  assert.equal(fmtDuration(3_599_000), '59m 59s');
  assert.equal(fmtDuration(7_260_000), '121m 00s');
});

test('formatBytes steps through B, KB, and MB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(5.5 * 1024 * 1024), '5.5 MB');
});

test('fmtTokens abbreviates thousands and millions', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1000), '1.0k');
  assert.equal(fmtTokens(15_500), '15.5k');
  assert.equal(fmtTokens(999_999), '1000.0k');
  assert.equal(fmtTokens(1_000_000), '1.00M');
  assert.equal(fmtTokens(2_350_000), '2.35M');
});

test('basename takes the last segment and ignores trailing slashes', () => {
  assert.equal(basename('/a/b/c.ts'), 'c.ts');
  assert.equal(basename('name'), 'name');
  assert.equal(basename('/a/b/'), 'b');
  assert.equal(basename('/'), '');
});

test('dirOf returns the parent directory, empty at or above the root', () => {
  assert.equal(dirOf('/a/b/c.ts'), '/a/b');
  assert.equal(dirOf('/a/b/'), '/a');
  assert.equal(dirOf('/c'), '');
  assert.equal(dirOf('c'), '');
});

test('displayDir is workspace-relative inside, absolute outside, empty at root', () => {
  assert.equal(displayDir('/ws/src/x.ts', null), '/ws/src');
  assert.equal(displayDir('/ws/src/x.ts', '/ws'), 'src');
  assert.equal(displayDir('/ws/src/x.ts', '/ws/'), 'src');
  assert.equal(displayDir('/ws/x.ts', '/ws'), '');
  assert.equal(displayDir('/other/x.ts', '/ws'), '/other');
  assert.equal(displayDir('x.ts', '/ws'), '');
});

test('truncate flattens whitespace and clips at max with an ellipsis', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('  a\n  b\t c ', 20), 'a b c');
  assert.equal(truncate('abcde', 5), 'abcde');
  assert.equal(truncate('abcdef', 5), 'abcd…');
  assert.equal(truncate('abcdef', 5).length, 5);
});

test('stripAnsi removes escape sequences and keeps plain text', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripAnsi('\u001b[2K\u001b[1Gdone'), 'done');
  assert.equal(stripAnsi('plain output'), 'plain output');
});

test('previewJson hides empty payloads and truncates real ones', () => {
  assert.equal(previewJson(null, 80), null);
  assert.equal(previewJson(undefined, 80), null);
  assert.equal(previewJson({}, 80), null);
  assert.equal(previewJson('', 80), null);
  assert.equal(previewJson('null', 80), null);
  assert.equal(previewJson('hello', 80), 'hello');
  assert.equal(previewJson({ a: 1 }, 80), '{"a":1}');
  const long = previewJson({ text: 'x'.repeat(200) }, 40);
  assert.equal(long?.length, 40);
  assert.ok(long?.endsWith('…'));
});

test('previewJson returns null for unserializable values', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(previewJson(circular, 80), null);
});

test('itemDurationMs prefers the item duration, falls back to meta timestamps', () => {
  const meta: ItemMeta = { turnId: 't1', startedAtMs: 1_000, completedAtMs: 3_500 };
  assert.equal(itemDurationMs(commandItem({ durationMs: 1234 }), meta), 1234);
  assert.equal(itemDurationMs(commandItem({ durationMs: null }), meta), 2500);
  assert.equal(itemDurationMs(fileItem(), meta), 2500);
  assert.equal(
    itemDurationMs(fileItem(), { turnId: 't1', startedAtMs: 5_000, completedAtMs: 4_000 }),
    0,
  );
  assert.equal(itemDurationMs(fileItem(), { turnId: 't1', startedAtMs: 1_000 }), null);
  assert.equal(itemDurationMs(fileItem(), undefined), null);
});

test('adjacent reasoning items consolidate without crossing work boundaries', () => {
  const first = { ...reasoningItem, id: 'thought-1' };
  const second = { ...reasoningItem, id: 'thought-2' };
  const third = { ...reasoningItem, id: 'thought-3' };
  const groups = groupAdjacentReasoning([first, second, commandItem(), third, fileItem()]);

  assert.deepEqual(
    groups.map((group) =>
      group.kind === 'reasoning'
        ? ['reasoning', group.items.map((item) => item.id)]
        : ['item', group.item.id],
    ),
    [
      ['reasoning', ['thought-1', 'thought-2']],
      ['item', 'cmd-1'],
      ['reasoning', ['thought-3']],
      ['item', 'file-1'],
    ],
  );
});

test('a consolidated reasoning duration spans the uninterrupted sequence', () => {
  const first = { ...reasoningItem, id: 'thought-1' };
  const second = { ...reasoningItem, id: 'thought-2' };
  assert.equal(
    reasoningGroupDurationMs([first, second], {
      'thought-1': { turnId: 't1', startedAtMs: 1_000, completedAtMs: 1_600 },
      'thought-2': { turnId: 't1', startedAtMs: 1_600, completedAtMs: 2_000 },
    }),
    1_000,
  );
  assert.equal(reasoningGroupDurationMs([first, second], {}), null);
});

test('blockStatus maps raw statuses, downgrading abandoned inProgress to stopped', () => {
  assert.equal(blockStatus(commandItem({ status: 'failed' }), true), 'failed');
  assert.equal(blockStatus(commandItem({ status: 'declined' }), true), 'declined');
  assert.equal(blockStatus(commandItem({ status: 'inProgress' }), true), 'running');
  assert.equal(blockStatus(commandItem({ status: 'inProgress' }), false), 'stopped');
  assert.equal(blockStatus(commandItem({ status: 'completed' }), false), 'done');
  // Items without a status field (reasoning) always read as done.
  assert.equal(blockStatus(reasoningItem, true), 'done');
  assert.equal(blockStatus(reasoningItem, false), 'done');
});
