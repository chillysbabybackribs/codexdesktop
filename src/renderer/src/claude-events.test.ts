import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClaudeTurnTranslator,
  claudeContextWindowFor,
  turnStartedNotification,
  type ClaudeTurnContext,
} from '../../shared/claude-events.ts';
import {
  emptySessionState,
  reduceSessionNotification,
  type SessionRenderState,
} from './session-store.ts';
import type { TokenUsageBreakdown } from '../../shared/session-protocol/index.ts';

// End-to-end contract: spike-shaped SDK messages → translator → the SAME
// reducer the UI renders from. If this passes, a Claude turn renders.

function makeContext(): { context: ClaudeTurnContext; totals: () => TokenUsageBreakdown } {
  let total: TokenUsageBreakdown = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  const context: ClaudeTurnContext = {
    threadId: 'claude-t1',
    turnId: 'claude-t1-turn1',
    nowMs: () => 1_000_000,
    tokens: {
      contextWindow: 200_000,
      addLast(last) {
        total = {
          totalTokens: total.totalTokens + last.totalTokens,
          inputTokens: total.inputTokens + last.inputTokens,
          cachedInputTokens: total.cachedInputTokens + last.cachedInputTokens,
          outputTokens: total.outputTokens + last.outputTokens,
          reasoningOutputTokens: 0,
        };
        return { total, last };
      },
    },
  };
  return { context, totals: () => total };
}

// Message fixtures shaped exactly like the spike capture.
const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-session-1',
  model: 'claude-opus-4-8',
};
const blockStart = (index: number, block: Record<string, unknown>) => ({
  type: 'stream_event',
  event: { type: 'content_block_start', index, content_block: block },
});
const messageStart = (id: string) => ({
  type: 'stream_event',
  event: { type: 'message_start', message: { id } },
});
const textDelta = (index: number, text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
});
const blockStop = (index: number) => ({
  type: 'stream_event',
  event: { type: 'content_block_stop', index },
});
const result = (usage: Record<string, number>, subtype = 'success') => ({
  type: 'result',
  subtype,
  usage,
  duration_ms: 2500,
});

function replayTurn(
  messages: unknown[],
  userText: string,
): {
  state: SessionRenderState;
  sessionId: string | null;
  context: ClaudeTurnContext;
} {
  const { context } = makeContext();
  const translator = new ClaudeTurnTranslator(context);
  const reduceContext = { atMs: 1_000_000, fallbackModel: 'claude-opus-4-8', workspace: '/tmp/ws' };
  let state = reduceSessionNotification(
    emptySessionState(),
    turnStartedNotification(context, userText),
    reduceContext,
  );
  let sessionId: string | null = null;
  for (const message of messages) {
    const translation = translator.handle(message);
    if (translation.sessionId) sessionId = translation.sessionId;
    for (const notification of translation.notifications) {
      state = reduceSessionNotification(state, notification, reduceContext);
    }
  }
  return { state, sessionId, context };
}

test('a full claude turn renders through the shared reducer', () => {
  const { state, sessionId } = replayTurn(
    [
      init,
      blockStart(0, { type: 'text' }),
      textDelta(0, 'Hel'),
      textDelta(0, 'lo!'),
      blockStop(0),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello!' }] } },
      result({ input_tokens: 4, cache_read_input_tokens: 100, output_tokens: 12 }),
    ],
    'Say hello',
  );

  assert.equal(sessionId, 'sdk-session-1');
  assert.equal(state.turnId, null, 'turn completed');
  const user = state.items.find((item) => item.type === 'userMessage');
  assert.ok(user, 'authoritative user message present');
  const assistant = state.items.find((item) => item.type === 'agentMessage');
  assert.equal((assistant as { text: string }).text, 'Hello!');
  assert.equal(state.turnMeta['claude-t1-turn1']?.status, 'completed');
  assert.equal(state.contextUsage?.last.totalTokens, 116);
  assert.equal(state.contextUsage?.modelContextWindow, 200_000);
  assert.equal(state.turnMeta['claude-t1-turn1']?.tokens?.modelCallCount, 1);
});

test('thinking blocks render as reasoning; tool_use renders as a tool call that completes', () => {
  const { state } = replayTurn(
    [
      init,
      messageStart('msg-tool'),
      blockStart(0, { type: 'thinking' }),
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'pondering…' },
        },
      },
      blockStop(0),
      blockStart(1, { type: 'tool_use', id: 'toolu_123', name: 'Bash' }),
      blockStop(1),
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_123', is_error: false }] },
      },
      messageStart('msg-answer'),
      blockStart(0, { type: 'text' }),
      textDelta(0, 'done'),
      blockStop(0),
      result({ input_tokens: 10, output_tokens: 5 }),
    ],
    'run something',
  );

  const reasoning = state.items.find((item) => item.type === 'reasoning');
  assert.deepEqual((reasoning as { summary: string[] }).summary, ['pondering…']);
  // Bash now maps to the same commandExecution item type Codex emits.
  const tool = state.items.find((item) => item.type === 'commandExecution');
  assert.equal((tool as { status: string }).status, 'completed');
  const answer = state.items.find((item) => item.id.includes('msg-answer'));
  assert.equal((answer as { text: string }).text, 'done');
});

const inputJsonDelta = (index: number, partialJson: string) => ({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  },
});
const toolResult = (id: string, content: unknown, isError = false) => ({
  type: 'user',
  message: {
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
});

test('Bash maps to a commandExecution with command, output, and duration', () => {
  const { state } = replayTurn(
    [
      init,
      messageStart('msg-bash'),
      blockStart(0, { type: 'tool_use', id: 'toolu_bash', name: 'Bash' }),
      inputJsonDelta(0, '{"command": "npm te'),
      inputJsonDelta(0, 'st", "description": "Run tests"}'),
      blockStop(0),
      toolResult('toolu_bash', [{ type: 'text', text: 'ok\n42 passing' }]),
    ],
    'run the tests',
  );

  const tool = state.items.find((item) => item.type === 'commandExecution') as {
    command: string;
    aggregatedOutput: string;
    status: string;
    exitCode: number | null;
    durationMs: number | null;
  };
  assert.equal(tool.command, 'npm test');
  assert.equal(tool.aggregatedOutput, 'ok\n42 passing');
  assert.equal(tool.status, 'completed');
  assert.equal(tool.exitCode, 0);
  assert.equal(typeof tool.durationMs, 'number');
});

test('Read maps to a commandExecution with a compact read action', () => {
  const { state } = replayTurn(
    [
      init,
      messageStart('msg-read'),
      blockStart(0, { type: 'tool_use', id: 'toolu_read', name: 'Read' }),
      inputJsonDelta(0, '{"file_path": "/tmp/ws/src/app.ts"}'),
      blockStop(0),
      toolResult('toolu_read', 'file contents…'),
    ],
    'read the file',
  );

  const tool = state.items.find((item) => item.type === 'commandExecution') as {
    commandActions: Array<{ type: string; name: string; path: string }>;
    status: string;
  };
  assert.equal(tool.status, 'completed');
  assert.deepEqual(tool.commandActions, [
    { type: 'read', command: 'Read /tmp/ws/src/app.ts', name: 'app.ts', path: '/tmp/ws/src/app.ts' },
  ]);
});

test('Edit maps to a fileChange with a synthesized diff that completes', () => {
  const { state } = replayTurn(
    [
      init,
      messageStart('msg-edit'),
      blockStart(0, { type: 'tool_use', id: 'toolu_edit', name: 'Edit' }),
      blockStop(0),
      {
        type: 'assistant',
        message: {
          id: 'msg-edit',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_edit',
              name: 'Edit',
              input: {
                file_path: '/tmp/ws/src/app.ts',
                old_string: 'const a = 1',
                new_string: 'const a = 2',
              },
            },
          ],
        },
      },
      toolResult('toolu_edit', 'edited'),
    ],
    'edit the file',
  );

  const tool = state.items.find((item) => item.type === 'fileChange') as {
    status: string;
    changes: Array<{ path: string; kind: { type: string }; diff: string }>;
  };
  assert.equal(tool.status, 'completed');
  assert.equal(tool.changes[0].path, '/tmp/ws/src/app.ts');
  assert.equal(tool.changes[0].kind.type, 'update');
  assert.equal(tool.changes[0].diff, '-const a = 1\n+const a = 2');
});

test('WebSearch maps to a webSearch item; unknown tools stay mcpToolCall', () => {
  const { state } = replayTurn(
    [
      init,
      messageStart('msg-web'),
      blockStart(0, { type: 'tool_use', id: 'toolu_web', name: 'WebSearch' }),
      inputJsonDelta(0, '{"query": "cursor chat ui"}'),
      blockStop(0),
      toolResult('toolu_web', 'results…'),
      blockStart(1, { type: 'tool_use', id: 'toolu_mcp', name: 'mcp__browser__app_screenshot' }),
      inputJsonDelta(1, '{}'),
      blockStop(1),
      toolResult('toolu_mcp', 'shot'),
    ],
    'search the web',
  );

  const search = state.items.find((item) => item.type === 'webSearch') as {
    query: string;
    action: { type: string; query: string | null };
  };
  assert.equal(search.query, 'cursor chat ui');
  assert.equal(search.action.type, 'search');
  const mcp = state.items.find((item) => item.type === 'mcpToolCall') as {
    tool: string;
    status: string;
  };
  assert.equal(mcp.tool, 'mcp__browser__app_screenshot');
  assert.equal(mcp.status, 'completed');
});

test('TodoWrite emits turn/plan/updated and no transcript item', () => {
  const { context } = makeContext();
  const translator = new ClaudeTurnTranslator(context);
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const messages = [
    init,
    messageStart('msg-plan'),
    blockStart(0, { type: 'tool_use', id: 'toolu_todo', name: 'TodoWrite' }),
    inputJsonDelta(
      0,
      '{"todos": [{"content": "Map the UI", "status": "completed"}, {"content": "Ship it", "status": "in_progress"}]}',
    ),
    blockStop(0),
    toolResult('toolu_todo', 'ok'),
  ];
  for (const message of messages) {
    for (const notification of translator.handle(message).notifications) {
      notifications.push(notification as unknown as { method: string; params: Record<string, unknown> });
    }
  }

  const plan = notifications.find((notification) => notification.method === 'turn/plan/updated');
  assert.ok(plan, 'plan notification emitted');
  assert.deepEqual(plan?.params.plan, [
    { step: 'Map the UI', status: 'completed' },
    { step: 'Ship it', status: 'inProgress' },
  ]);
  assert.equal(
    notifications.filter((notification) => notification.method.startsWith('item/')).length,
    0,
    'no transcript item for the todo board',
  );
});

test('content-block indexes are scoped to each assistant message', () => {
  const { state } = replayTurn(
    [
      messageStart('msg-first'),
      blockStart(0, { type: 'text' }),
      textDelta(0, 'first'),
      blockStop(0),
      {
        type: 'assistant',
        message: { id: 'msg-first', content: [{ type: 'text', text: 'first' }] },
      },
      messageStart('msg-second'),
      blockStart(0, { type: 'text' }),
      textDelta(0, 'second response'),
      blockStop(0),
      {
        type: 'assistant',
        message: { id: 'msg-second', content: [{ type: 'text', text: 'second response' }] },
      },
    ],
    'use a tool',
  );

  const messages = state.items.filter((item) => item.type === 'agentMessage') as Array<{
    id: string;
    text: string;
  }>;
  assert.deepEqual(
    messages.map(({ text }) => text),
    ['first', 'second response'],
  );
  assert.equal(new Set(messages.map(({ id }) => id)).size, 2);
});

test('split assistant records (one per block, same provider id) do not duplicate the answer', () => {
  // Live-caught shape: the SDK emits one `assistant` record per content block
  // — thinking first, then text — both with the same provider message id,
  // after the text already streamed. The report used to render twice.
  const { state } = replayTurn(
    [
      init,
      messageStart('msg-final'),
      blockStart(0, { type: 'thinking' }),
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'checking…' },
        },
      },
      blockStop(0),
      blockStart(1, { type: 'text' }),
      textDelta(1, 'Looks solid.'),
      blockStop(1),
      {
        type: 'assistant',
        message: { id: 'msg-final', content: [{ type: 'thinking', thinking: 'checking…' }] },
      },
      {
        type: 'assistant',
        message: { id: 'msg-final', content: [{ type: 'text', text: 'Looks solid.' }] },
      },
      result({ input_tokens: 5, output_tokens: 5 }),
    ],
    'audit the turn',
  );

  const messages = state.items.filter((item) => item.type === 'agentMessage') as Array<{
    text: string;
  }>;
  assert.equal(messages.length, 1, 'split records must not duplicate the message');
  assert.equal(messages[0].text, 'Looks solid.');
});

test('replayed assistant records stay idempotent even after the block map resets', () => {
  const restate = {
    type: 'assistant',
    message: { id: 'msg-a', content: [{ type: 'text', text: 'answer' }] },
  };
  const { state } = replayTurn(
    [
      init,
      messageStart('msg-a'),
      blockStart(0, { type: 'text' }),
      textDelta(0, 'answer'),
      blockStop(0),
      restate,
      // A later message resets the streaming block map…
      messageStart('msg-b'),
      // …then the SDK replays the earlier assistant record verbatim.
      restate,
      result({ input_tokens: 2, output_tokens: 2 }),
    ],
    'q',
  );

  const messages = state.items.filter((item) => item.type === 'agentMessage') as Array<{
    text: string;
  }>;
  assert.deepEqual(
    messages.map(({ text }) => text),
    ['answer'],
  );
});

test('rate-limit and SDK error details survive into the failed turn', () => {
  const { context } = makeContext();
  const translator = new ClaudeTurnTranslator(context);
  translator.handle({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: 2_000_000_000 },
  });
  const translation = translator.handle({
    type: 'result',
    subtype: 'error_during_execution',
    usage: { input_tokens: 1, output_tokens: 0 },
    errors: ['provider detail'],
    duration_ms: 20,
  });
  const completed = translation.notifications.at(-1) as unknown as {
    params: {
      turn: {
        status: string;
        error: { message: string; codexErrorInfo: string; additionalDetails: string };
      };
    };
  };

  assert.equal(completed.params.turn.status, 'failed');
  assert.match(completed.params.turn.error.message, /usage limit reached/i);
  assert.equal(completed.params.turn.error.codexErrorInfo, 'usageLimitExceeded');
  assert.equal(completed.params.turn.error.additionalDetails, 'provider detail');
});

test('a failed result marks the turn failed with the error message', () => {
  const { state } = replayTurn(
    [init, result({ input_tokens: 1, output_tokens: 0 }, 'error_during_execution')],
    'boom',
  );
  assert.equal(state.turnMeta['claude-t1-turn1']?.status, 'failed');
  assert.match(state.turnMeta['claude-t1-turn1']?.errorMessage ?? '', /claude turn ended/);
});

test('token totals accumulate across turns via the injected accumulator', () => {
  const { context } = makeContext();
  const first = new ClaudeTurnTranslator(context).handle(
    result({ input_tokens: 10, output_tokens: 5 }),
  );
  const second = new ClaudeTurnTranslator(context).handle(
    result({ input_tokens: 20, output_tokens: 5 }),
  );
  const firstUsage = (
    first.notifications[0] as unknown as { params: { tokenUsage: { total: TokenUsageBreakdown } } }
  ).params.tokenUsage;
  const secondUsage = (
    second.notifications[0] as unknown as { params: { tokenUsage: { total: TokenUsageBreakdown } } }
  ).params.tokenUsage;
  assert.equal(firstUsage.total.totalTokens, 15);
  assert.equal(secondUsage.total.totalTokens, 40);
});

test('context window inference: 1m-tagged models get the large window', () => {
  assert.equal(claudeContextWindowFor('claude-opus-4-8[1m]'), 1_000_000);
  assert.equal(claudeContextWindowFor('claude-opus-4-8'), 200_000);
  assert.equal(claudeContextWindowFor(null), 200_000);
});

test('result modelUsage overrides the fallback context-window guess', () => {
  const { context } = makeContext();
  const translator = new ClaudeTurnTranslator(context);
  const initialized = translator.handle(init);
  assert.equal(initialized.model, 'claude-opus-4-8');

  const translation = translator.handle({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {
      'claude-opus-4-8': {
        inputTokens: 10,
        outputTokens: 5,
        contextWindow: 1_000_000,
      },
    },
  });
  const usage = (
    translation.notifications[0] as unknown as {
      params: { tokenUsage: { modelContextWindow: number } };
    }
  ).params.tokenUsage;
  assert.equal(usage.modelContextWindow, 1_000_000);
});
