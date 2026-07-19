import type { ServerNotification } from './codex-protocol/ServerNotification.js';
import type { ThreadItem } from './codex-protocol/v2/ThreadItem.js';
import type { TokenUsageBreakdown } from './codex-protocol/v2/TokenUsageBreakdown.js';
import type { Turn } from './codex-protocol/v2/Turn.js';

// Pure translation layer (Claude adapter): Agent SDK stream messages → the
// shared notification vocabulary reduceSessionNotification consumes. One
// translator instance per turn (content blocks are stateful across events).
// Everything is injected (clock, token accumulator), so the golden-replay
// tests drive this exactly like production.
//
// Spike-derived contracts (docs/claude-d5-spike-2026-07-19.md):
// - `system/init` repeats per message and on resume — it only YIELDS the
//   session id, it must never gate anything.
// - text/thinking arrive as content_block_start/delta/stop; the full
//   `assistant` message follows and is emitted as an idempotent completion
//   (the store's longest-text-wins merge makes replays safe).
// - `result` closes the turn and carries usage.

export type ClaudeTokenAccumulator = {
  addLast(last: TokenUsageBreakdown): { total: TokenUsageBreakdown; last: TokenUsageBreakdown };
  contextWindow: number;
};

export type ClaudeTurnContext = {
  threadId: string;
  turnId: string;
  nowMs: () => number;
  tokens: ClaudeTokenAccumulator;
};

export type ClaudeTranslation = {
  notifications: ServerNotification[];
  sessionId?: string;
  model?: string;
  turnEnded?: boolean;
};

export function userMessageItem(turnId: string, text: string): ThreadItem {
  return {
    type: 'userMessage',
    id: `${turnId}:user`,
    content: [{ type: 'text', text }],
  } as unknown as ThreadItem;
}

export function turnStartedNotification(
  context: ClaudeTurnContext,
  userText: string,
): ServerNotification {
  const turn = {
    id: context.turnId,
    items: [userMessageItem(context.turnId, userText)],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: Math.floor(context.nowMs() / 1000),
    completedAt: null,
    durationMs: null,
  } as unknown as Turn;
  return asNotification('turn/started', { threadId: context.threadId, turn });
}

// Tool calls are translated to the richest ThreadItem type the tool name
// implies, so Claude turns hit the exact same UI components as Codex turns
// (terminal cards, compact read/search rows, diff cards, web-search rows, the
// plan board) instead of a flat generic tool row.
type ClaudeToolKind = 'command' | 'fileChange' | 'webSearch' | 'plan' | 'mcp';

type ClaudeToolState = {
  name: string;
  kind: ClaudeToolKind;
  startedAtMs: number;
  command: string;
  commandActions: unknown[];
  changes: Array<{ path: string; kind: unknown; diff: string }>;
  query: string;
  action: unknown;
  arguments: unknown;
};

function classifyClaudeTool(name: string): ClaudeToolKind {
  switch (name) {
    case 'Bash':
    case 'Read':
    case 'Grep':
    case 'Glob':
      return 'command';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return 'fileChange';
    case 'WebSearch':
    case 'WebFetch':
      return 'webSearch';
    case 'TodoWrite':
      return 'plan';
    default:
      return 'mcp';
  }
}

export class ClaudeTurnTranslator {
  private readonly blocks = new Map<
    number,
    { id: string; kind: 'text' | 'thinking' | 'tool'; text: string }
  >();
  private readonly tools = new Map<string, ClaudeToolState>();
  private readonly context: ClaudeTurnContext;
  private messageSequence = 0;
  private messageKey = 'm0';
  // (provider message id, text) → emitted item id: keeps restated/replayed
  // assistant text idempotent even after the streaming block map resets.
  private readonly emittedTextIds = new Map<string, string>();
  private textIdCounter = 0;
  private resolvedModel: string | null = null;
  private pendingError: {
    message: string;
    codexErrorInfo:
      | 'usageLimitExceeded'
      | 'serverOverloaded'
      | 'internalServerError'
      | 'unauthorized'
      | 'badRequest'
      | 'other';
  } | null = null;

  constructor(context: ClaudeTurnContext) {
    this.context = context;
  }

  handle(raw: unknown): ClaudeTranslation {
    const message = asRecord(raw);
    const type = message.type;

    if (type === 'system') {
      // Init repeats per message/resume. Refresh both provider-owned facts.
      if (message.subtype !== 'init') return { notifications: [] };
      if (typeof message.model === 'string') this.resolvedModel = message.model;
      return {
        notifications: [],
        ...(typeof message.session_id === 'string' ? { sessionId: message.session_id } : {}),
        ...(this.resolvedModel ? { model: this.resolvedModel } : {}),
      };
    }

    if (type === 'stream_event') return this.handleStreamEvent(asRecord(message.event));
    if (type === 'assistant') {
      this.rememberAssistantError(message);
      return this.handleAssistant(asRecord(message.message));
    }
    if (type === 'user') return this.handleToolResults(asRecord(message.message));
    if (type === 'rate_limit_event') {
      const info = asRecord(message.rate_limit_info);
      if (info.status === 'rejected') {
        const reset = formatResetTime(info.resetsAt);
        this.pendingError = {
          message: `Claude usage limit reached.${reset}`,
          codexErrorInfo: 'usageLimitExceeded',
        };
      }
      return { notifications: [] };
    }
    if (type === 'result') return this.handleResult(message);
    return { notifications: [] };
  }

  private handleStreamEvent(event: Record<string, unknown>): ClaudeTranslation {
    const { threadId, turnId } = this.context;

    if (event.type === 'message_start') {
      const message = asRecord(event.message);
      this.messageSequence += 1;
      const providerId = typeof message.id === 'string' ? `-${safeId(message.id)}` : '';
      this.messageKey = `m${this.messageSequence}${providerId}`;
      this.blocks.clear();
      return { notifications: [] };
    }

    if (event.type === 'content_block_start') {
      const index = Number(event.index ?? 0);
      const block = asRecord(event.content_block);
      if (block.type === 'text') {
        const id = `${turnId}:${this.messageKey}:b${index}`;
        this.blocks.set(index, { id, kind: 'text', text: '' });
        return {
          notifications: [
            asNotification('item/started', {
              threadId,
              turnId,
              startedAtMs: this.context.nowMs(),
              item: {
                type: 'agentMessage',
                id,
                text: '',
                phase: null,
                memoryCitation: null,
              } as ThreadItem,
            }),
          ],
        };
      }
      if (block.type === 'thinking') {
        const id = `${turnId}:${this.messageKey}:b${index}`;
        this.blocks.set(index, { id, kind: 'thinking', text: '' });
        return {
          notifications: [
            asNotification('item/started', {
              threadId,
              turnId,
              startedAtMs: this.context.nowMs(),
              item: { type: 'reasoning', id, summary: [''], content: [] } as unknown as ThreadItem,
            }),
          ],
        };
      }
      if (block.type === 'tool_use') {
        // Use the SDK's tool_use id so tool_result messages match directly.
        const id =
          typeof block.id === 'string' ? block.id : `${turnId}:${this.messageKey}:b${index}`;
        this.blocks.set(index, { id, kind: 'tool', text: '' });
        return {
          notifications: this.startToolCall(id, typeof block.name === 'string' ? block.name : 'tool'),
        };
      }
      return { notifications: [] };
    }

    if (event.type === 'content_block_delta') {
      const block = this.blocks.get(Number(event.index ?? 0));
      if (!block) return { notifications: [] };
      const delta = asRecord(event.delta);
      if (block.kind === 'text' && typeof delta.text === 'string') {
        block.text += delta.text;
        return {
          notifications: [
            asNotification('item/agentMessage/delta', {
              threadId,
              turnId,
              itemId: block.id,
              delta: delta.text,
            }),
          ],
        };
      }
      if (block.kind === 'thinking' && typeof delta.thinking === 'string') {
        block.text += delta.thinking;
        return {
          notifications: [
            asNotification('item/reasoning/summaryTextDelta', {
              threadId,
              turnId,
              itemId: block.id,
              summaryIndex: 0,
              delta: delta.thinking,
            }),
          ],
        };
      }
      if (block.kind === 'tool' && typeof delta.partial_json === 'string') {
        // Tool input streams as JSON fragments; parseable only at block stop.
        block.text += delta.partial_json;
        return { notifications: [] };
      }
      return { notifications: [] };
    }

    if (event.type === 'content_block_stop') {
      const block = this.blocks.get(Number(event.index ?? 0));
      if (!block) return { notifications: [] };
      if (block.kind === 'tool') {
        return { notifications: this.enrichToolCall(block.id, parseJsonRecord(block.text)) };
      }
      return {
        notifications: [
          this.completedBlockNotification({
            id: block.id,
            kind: block.kind as 'text' | 'thinking',
            text: block.text,
          }),
        ],
      };
    }

    return { notifications: [] };
  }

  // The SDK restates assistant content as full messages — often SPLIT into one
  // record per content block, all sharing the provider message id — after the
  // same text already streamed. Completions must land on the SAME item id as
  // the streamed block, or split records and replays turn into duplicate
  // messages (live-caught: the audit report rendered twice). Match restated
  // text to a streamed block by content; otherwise key off the provider
  // message id, memoized so exact replays stay idempotent even after the
  // streaming block map resets.
  private handleAssistant(message: Record<string, unknown>): ClaudeTranslation {
    const providerId = typeof message.id === 'string' ? safeId(message.id) : 'anon';
    const notifications: ServerNotification[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        // Restated tool_use carries the complete input — the enrichment path
        // for runs without stream events, and an idempotent re-emit otherwise.
        if (!this.tools.has(block.id)) {
          notifications.push(
            ...this.startToolCall(block.id, typeof block.name === 'string' ? block.name : 'tool'),
          );
        }
        notifications.push(...this.enrichToolCall(block.id, asRecord(block.input)));
        continue;
      }
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      const memoKey = `${providerId} ${block.text}`;
      let id = this.emittedTextIds.get(memoKey);
      if (!id) {
        const streamed = this.matchStreamedTextBlock(block.text);
        id = streamed?.id ?? `${this.context.turnId}:${providerId}:t${this.textIdCounter++}`;
        this.emittedTextIds.set(memoKey, id);
      }
      notifications.push(this.completedBlockNotification({ id, kind: 'text', text: block.text }));
    }
    return { notifications };
  }

  // The streamed block this restated text corresponds to: exact match first,
  // then prefix in either direction (an interrupted stream holds a prefix of
  // the final text; the store's longest-text-wins merge reconciles).
  private matchStreamedTextBlock(text: string): { id: string } | null {
    let prefix: { id: string } | null = null;
    for (const block of this.blocks.values()) {
      if (block.kind !== 'text') continue;
      if (block.text === text) return block;
      if (
        !prefix &&
        block.text.length > 0 &&
        (text.startsWith(block.text) || block.text.startsWith(text))
      ) {
        prefix = block;
      }
    }
    return prefix;
  }

  private handleToolResults(message: Record<string, unknown>): ClaudeTranslation {
    const notifications: ServerNotification[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const id = block.tool_use_id;
      const state = this.tools.get(id) ?? this.rememberFallbackTool(id);
      // The todo board is turn-level state, not a transcript item — its
      // tool_result carries nothing the plan notification didn't.
      if (state.kind === 'plan') continue;
      notifications.push(
        this.toolItemNotification(
          'item/completed',
          id,
          state,
          block.is_error === true ? 'failed' : 'completed',
          extractToolResultText(block.content),
        ),
      );
    }
    return { notifications };
  }

  // -- Tool call translation ------------------------------------------------

  private startToolCall(id: string, name: string): ServerNotification[] {
    const state: ClaudeToolState = {
      name,
      kind: classifyClaudeTool(name),
      startedAtMs: this.context.nowMs(),
      command: '',
      commandActions: [],
      changes: [],
      query: '',
      action: null,
      arguments: null,
    };
    this.tools.set(id, state);
    if (state.kind === 'plan') return [];
    return [this.toolItemNotification('item/started', id, state, 'inProgress')];
  }

  private rememberFallbackTool(id: string): ClaudeToolState {
    const state: ClaudeToolState = {
      name: 'tool',
      kind: 'mcp',
      startedAtMs: this.context.nowMs(),
      command: '',
      commandActions: [],
      changes: [],
      query: '',
      action: null,
      arguments: null,
    };
    this.tools.set(id, state);
    return state;
  }

  // Fill the typed item in once the tool input is known — at
  // content_block_stop from accumulated input deltas, and again (idempotently,
  // via the item upsert) from the restated assistant message.
  private enrichToolCall(id: string, input: Record<string, unknown>): ServerNotification[] {
    const state = this.tools.get(id);
    if (!state || Object.keys(input).length === 0) return [];
    const path = str(input.file_path);

    switch (state.name) {
      case 'Bash':
        state.command = str(input.command) ?? '';
        break;
      case 'Read':
        if (!path) return [];
        state.command = `Read ${path}`;
        state.commandActions = [
          { type: 'read', command: state.command, name: basename(path), path },
        ];
        break;
      case 'Glob':
        state.command = `Glob ${str(input.pattern) ?? ''}`.trim();
        state.commandActions = [
          { type: 'listFiles', command: state.command, path: str(input.path) },
        ];
        break;
      case 'Grep': {
        const pattern = str(input.pattern);
        state.command = `Grep ${pattern ?? ''}`.trim();
        state.commandActions = [
          { type: 'search', command: state.command, query: pattern, path: str(input.path) },
        ];
        break;
      }
      case 'Edit':
        if (!path) return [];
        state.changes = [
          {
            path,
            kind: { type: 'update', move_path: null },
            diff: synthesizeReplaceDiff(str(input.old_string) ?? '', str(input.new_string) ?? ''),
          },
        ];
        break;
      case 'Write':
        if (!path) return [];
        state.changes = [
          { path, kind: { type: 'add' }, diff: prefixLines(str(input.content) ?? '', '+') },
        ];
        break;
      case 'MultiEdit': {
        if (!path) return [];
        const edits = Array.isArray(input.edits) ? input.edits : [];
        const hunks = edits
          .map((edit) => {
            const record = asRecord(edit);
            return synthesizeReplaceDiff(
              str(record.old_string) ?? '',
              str(record.new_string) ?? '',
            );
          })
          .filter(Boolean);
        state.changes = [
          { path, kind: { type: 'update', move_path: null }, diff: hunks.join('\n@@\n') },
        ];
        break;
      }
      case 'WebSearch':
        state.query = str(input.query) ?? '';
        state.action = { type: 'search', query: state.query || null, queries: null };
        break;
      case 'WebFetch':
        state.query = str(input.url) ?? '';
        state.action = { type: 'openPage', url: str(input.url) };
        break;
      case 'TodoWrite': {
        const plan = planStepsFrom(input.todos);
        if (plan.length === 0) return [];
        return [
          asNotification('turn/plan/updated', {
            threadId: this.context.threadId,
            turnId: this.context.turnId,
            explanation: null,
            plan,
          }),
        ];
      }
      default:
        state.arguments = input;
        break;
    }

    if (state.kind === 'plan') return [];
    return [this.toolItemNotification('item/started', id, state, 'inProgress')];
  }

  private toolItemNotification(
    method: 'item/started' | 'item/completed',
    id: string,
    state: ClaudeToolState,
    status: 'inProgress' | 'completed' | 'failed',
    output?: string,
  ): ServerNotification {
    const nowMs = this.context.nowMs();
    const completed = method === 'item/completed';
    const durationMs = completed ? Math.max(0, nowMs - state.startedAtMs) : null;

    let item: ThreadItem;
    if (state.kind === 'command') {
      item = {
        type: 'commandExecution',
        id,
        command: state.command,
        cwd: '',
        processId: null,
        source: 'agent',
        status,
        commandActions: state.commandActions,
        aggregatedOutput: output ?? '',
        exitCode: completed && status === 'completed' ? 0 : null,
        durationMs,
      } as unknown as ThreadItem;
    } else if (state.kind === 'fileChange') {
      item = { type: 'fileChange', id, changes: state.changes, status } as unknown as ThreadItem;
    } else if (state.kind === 'webSearch') {
      item = {
        type: 'webSearch',
        id,
        query: state.query,
        action: state.action,
      } as unknown as ThreadItem;
    } else {
      item = {
        type: 'mcpToolCall',
        id,
        server: 'claude',
        tool: state.name,
        status,
        ...(state.arguments === null ? {} : { arguments: state.arguments }),
        ...(durationMs === null ? {} : { durationMs }),
      } as unknown as ThreadItem;
    }

    return completed
      ? asNotification('item/completed', {
          threadId: this.context.threadId,
          turnId: this.context.turnId,
          completedAtMs: nowMs,
          item,
        })
      : asNotification('item/started', {
          threadId: this.context.threadId,
          turnId: this.context.turnId,
          startedAtMs: state.startedAtMs,
          item,
        });
  }

  private handleResult(message: Record<string, unknown>): ClaudeTranslation {
    const { threadId, turnId } = this.context;
    const usage = asRecord(message.usage);
    const inputTokens = readCount(usage.input_tokens);
    const cachedInput = readCount(usage.cache_read_input_tokens);
    const outputTokens = readCount(usage.output_tokens);
    const last: TokenUsageBreakdown = {
      totalTokens: inputTokens + cachedInput + outputTokens,
      inputTokens: inputTokens + cachedInput,
      cachedInputTokens: cachedInput,
      outputTokens,
      reasoningOutputTokens: 0,
    };
    const { total } = this.context.tokens.addLast(last);
    const modelContextWindow = readModelContextWindow(
      message.modelUsage ?? message.model_usage,
      this.resolvedModel,
      this.context.tokens.contextWindow,
    );

    const failed = message.subtype !== 'success';
    const sdkErrors = Array.isArray(message.errors)
      ? message.errors.filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        )
      : [];
    const errorMessage =
      this.pendingError?.message ??
      (sdkErrors.length > 0 ? sdkErrors.join('\n') : null) ??
      (typeof message.result === 'string' && message.result.trim() ? message.result : null) ??
      `claude turn ended: ${String(message.subtype)}`;
    const completedAtMs = this.context.nowMs();
    const turn = {
      id: turnId,
      items: [],
      itemsView: 'full',
      status: failed ? 'failed' : 'completed',
      error: failed
        ? {
            message: errorMessage,
            codexErrorInfo: this.pendingError?.codexErrorInfo ?? classifyClaudeError(errorMessage),
            additionalDetails:
              this.pendingError && sdkErrors.length > 0
                ? sdkErrors.join('\n')
                : sdkErrors.length > 1
                  ? sdkErrors.slice(1).join('\n')
                  : null,
          }
        : null,
      startedAt: null,
      completedAt: Math.floor(completedAtMs / 1000),
      durationMs: readCount(message.duration_ms) || null,
    } as unknown as Turn;

    return {
      notifications: [
        asNotification('thread/tokenUsage/updated', {
          threadId,
          turnId,
          tokenUsage: { total, last, modelContextWindow },
        }),
        asNotification('turn/completed', { threadId, turn }),
      ],
      turnEnded: true,
    };
  }

  private completedBlockNotification(block: {
    id: string;
    kind: 'text' | 'thinking';
    text: string;
  }): ServerNotification {
    const item: ThreadItem =
      block.kind === 'text'
        ? ({
            type: 'agentMessage',
            id: block.id,
            text: block.text,
            phase: null,
            memoryCitation: null,
          } as ThreadItem)
        : ({
            type: 'reasoning',
            id: block.id,
            summary: [block.text],
            content: [],
          } as unknown as ThreadItem);
    return asNotification('item/completed', {
      threadId: this.context.threadId,
      turnId: this.context.turnId,
      completedAtMs: this.context.nowMs(),
      item,
    });
  }

  private rememberAssistantError(message: Record<string, unknown>): void {
    if (typeof message.error !== 'string') return;
    const mapping = {
      authentication_failed: 'unauthorized',
      oauth_org_not_allowed: 'unauthorized',
      billing_error: 'usageLimitExceeded',
      rate_limit: 'usageLimitExceeded',
      overloaded: 'serverOverloaded',
      server_error: 'internalServerError',
      invalid_request: 'badRequest',
      model_not_found: 'badRequest',
    } as const;
    this.pendingError = {
      message: `Claude request failed: ${message.error.replaceAll('_', ' ')}`,
      codexErrorInfo: mapping[message.error as keyof typeof mapping] ?? 'other',
    };
  }
}

export function claudeContextWindowFor(model: string | null): number {
  return model?.includes('[1m]') ? 1_000_000 : 200_000;
}

function asNotification(method: string, params: Record<string, unknown>): ServerNotification {
  return { method, params } as unknown as ServerNotification;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readModelContextWindow(
  value: unknown,
  resolvedModel: string | null,
  fallback: number,
): number {
  const usage = asRecord(value);
  if (resolvedModel) {
    const preferred = readCount(asRecord(usage[resolvedModel]).contextWindow);
    if (preferred > 0) return preferred;
  }
  for (const entry of Object.values(usage)) {
    const contextWindow = readCount(asRecord(entry).contextWindow);
    if (contextWindow > 0) return contextWindow;
  }
  return fallback;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 120) || 'message';
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  return index >= 0 ? clean.slice(index + 1) || clean : clean;
}

function parseJsonRecord(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

// Every line gets an explicit +/- marker so file content containing its own
// leading "+"/"-" characters can never be misparsed by the diff renderer.
function prefixLines(text: string, prefix: '+' | '-'): string {
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function synthesizeReplaceDiff(oldText: string, newText: string): string {
  const parts = [prefixLines(oldText, '-'), prefixLines(newText, '+')].filter(Boolean);
  return parts.join('\n');
}

const maxToolOutputChars = 40_000;

function extractToolResultText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((entry) => {
        const record = asRecord(entry);
        return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return text.length > maxToolOutputChars
    ? `${text.slice(0, maxToolOutputChars)}\n… [output truncated]`
    : text;
}

function planStepsFrom(
  value: unknown,
): Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }> {
  if (!Array.isArray(value)) return [];
  const steps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const label = str(record.content) ?? str(record.activeForm);
    if (!label) continue;
    steps.push({
      step: label,
      status:
        record.status === 'completed'
          ? 'completed'
          : record.status === 'in_progress'
            ? 'inProgress'
            : 'pending',
    });
  }
  return steps;
}

function classifyClaudeError(
  message: string,
):
  | 'usageLimitExceeded'
  | 'serverOverloaded'
  | 'internalServerError'
  | 'unauthorized'
  | 'badRequest'
  | 'other' {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('rate limit') ||
    normalized.includes('usage limit') ||
    normalized.includes('billing')
  )
    return 'usageLimitExceeded';
  if (normalized.includes('overload')) return 'serverOverloaded';
  if (normalized.includes('auth') || normalized.includes('oauth')) return 'unauthorized';
  if (normalized.includes('invalid request') || normalized.includes('model not found'))
    return 'badRequest';
  if (normalized.includes('server error') || normalized.includes('internal'))
    return 'internalServerError';
  return 'other';
}

function formatResetTime(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? '' : ` Resets at ${date.toISOString()}.`;
}
