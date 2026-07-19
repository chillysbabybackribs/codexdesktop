import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification.js'
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem.js'
import type { TokenUsageBreakdown } from '../../shared/codex-protocol/v2/TokenUsageBreakdown.js'
import type { Turn } from '../../shared/codex-protocol/v2/Turn.js'

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
  addLast(last: TokenUsageBreakdown): { total: TokenUsageBreakdown; last: TokenUsageBreakdown }
  contextWindow: number
}

export type ClaudeTurnContext = {
  threadId: string
  turnId: string
  nowMs: () => number
  tokens: ClaudeTokenAccumulator
}

export type ClaudeTranslation = {
  notifications: ServerNotification[]
  sessionId?: string
  turnEnded?: boolean
}

export function userMessageItem(turnId: string, text: string): ThreadItem {
  return {
    type: 'userMessage',
    id: `${turnId}:user`,
    content: [{ type: 'text', text }]
  } as unknown as ThreadItem
}

export function turnStartedNotification(context: ClaudeTurnContext, userText: string): ServerNotification {
  const turn = {
    id: context.turnId,
    items: [userMessageItem(context.turnId, userText)],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: Math.floor(context.nowMs() / 1000),
    completedAt: null,
    durationMs: null
  } as unknown as Turn
  return asNotification('turn/started', { threadId: context.threadId, turn })
}

export class ClaudeTurnTranslator {
  private readonly blocks = new Map<number, { id: string; kind: 'text' | 'thinking' | 'tool'; text: string }>()
  private readonly toolNames = new Map<string, string>()
  private readonly context: ClaudeTurnContext

  constructor(context: ClaudeTurnContext) {
    this.context = context
  }

  handle(raw: unknown): ClaudeTranslation {
    const message = asRecord(raw)
    const type = message.type

    if (type === 'system') {
      // init repeats per message/resume; only the session id matters.
      return message.subtype === 'init' && typeof message.session_id === 'string'
        ? { notifications: [], sessionId: message.session_id }
        : { notifications: [] }
    }

    if (type === 'stream_event') return this.handleStreamEvent(asRecord(message.event))
    if (type === 'assistant') return this.handleAssistant(asRecord(message.message))
    if (type === 'user') return this.handleToolResults(asRecord(message.message))
    if (type === 'result') return this.handleResult(message)
    return { notifications: [] }
  }

  private handleStreamEvent(event: Record<string, unknown>): ClaudeTranslation {
    const { threadId, turnId } = this.context

    if (event.type === 'content_block_start') {
      const index = Number(event.index ?? 0)
      const block = asRecord(event.content_block)
      if (block.type === 'text') {
        const id = `${turnId}:b${index}`
        this.blocks.set(index, { id, kind: 'text', text: '' })
        return {
          notifications: [asNotification('item/started', {
            threadId,
            turnId,
            startedAtMs: this.context.nowMs(),
            item: { type: 'agentMessage', id, text: '', phase: null, memoryCitation: null } as ThreadItem
          })]
        }
      }
      if (block.type === 'thinking') {
        const id = `${turnId}:b${index}`
        this.blocks.set(index, { id, kind: 'thinking', text: '' })
        return {
          notifications: [asNotification('item/started', {
            threadId,
            turnId,
            startedAtMs: this.context.nowMs(),
            item: { type: 'reasoning', id, summary: [''], content: [] } as unknown as ThreadItem
          })]
        }
      }
      if (block.type === 'tool_use') {
        // Use the SDK's tool_use id so tool_result messages match directly.
        const id = typeof block.id === 'string' ? block.id : `${turnId}:b${index}`
        this.blocks.set(index, { id, kind: 'tool', text: '' })
        this.toolNames.set(id, typeof block.name === 'string' ? block.name : 'tool')
        return {
          notifications: [asNotification('item/started', {
            threadId,
            turnId,
            startedAtMs: this.context.nowMs(),
            item: {
              type: 'mcpToolCall',
              id,
              server: 'claude',
              tool: typeof block.name === 'string' ? block.name : 'tool',
              status: 'inProgress'
            } as unknown as ThreadItem
          })]
        }
      }
      return { notifications: [] }
    }

    if (event.type === 'content_block_delta') {
      const block = this.blocks.get(Number(event.index ?? 0))
      if (!block) return { notifications: [] }
      const delta = asRecord(event.delta)
      if (block.kind === 'text' && typeof delta.text === 'string') {
        block.text += delta.text
        return {
          notifications: [asNotification('item/agentMessage/delta', {
            threadId, turnId, itemId: block.id, delta: delta.text
          })]
        }
      }
      if (block.kind === 'thinking' && typeof delta.thinking === 'string') {
        block.text += delta.thinking
        return {
          notifications: [asNotification('item/reasoning/summaryTextDelta', {
            threadId, turnId, itemId: block.id, summaryIndex: 0, delta: delta.thinking
          })]
        }
      }
      return { notifications: [] }
    }

    if (event.type === 'content_block_stop') {
      const block = this.blocks.get(Number(event.index ?? 0))
      if (!block || block.kind === 'tool') return { notifications: [] }
      return { notifications: [this.completedBlockNotification(block)] }
    }

    return { notifications: [] }
  }

  // The full assistant message re-states every block; emitting completions is
  // idempotent through the store's upsert/longest-text-wins merge.
  private handleAssistant(message: Record<string, unknown>): ClaudeTranslation {
    const notifications: ServerNotification[] = []
    const content = Array.isArray(message.content) ? message.content : []
    content.forEach((rawBlock, index) => {
      const block = asRecord(rawBlock)
      const tracked = this.blocks.get(index)
      if (block.type === 'text' && typeof block.text === 'string') {
        const id = tracked?.id ?? `${this.context.turnId}:b${index}`
        this.blocks.set(index, { id, kind: 'text', text: block.text })
        notifications.push(this.completedBlockNotification({ id, kind: 'text', text: block.text }))
      }
    })
    return { notifications }
  }

  private handleToolResults(message: Record<string, unknown>): ClaudeTranslation {
    const notifications: ServerNotification[] = []
    const content = Array.isArray(message.content) ? message.content : []
    for (const rawBlock of content) {
      const block = asRecord(rawBlock)
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        notifications.push(asNotification('item/completed', {
          threadId: this.context.threadId,
          turnId: this.context.turnId,
          completedAtMs: this.context.nowMs(),
          item: {
            type: 'mcpToolCall',
            id: block.tool_use_id,
            server: 'claude',
            tool: this.toolNames.get(block.tool_use_id) ?? 'tool',
            status: block.is_error === true ? 'failed' : 'completed'
          } as unknown as ThreadItem
        }))
      }
    }
    return { notifications }
  }

  private handleResult(message: Record<string, unknown>): ClaudeTranslation {
    const { threadId, turnId } = this.context
    const usage = asRecord(message.usage)
    const inputTokens = readCount(usage.input_tokens)
    const cachedInput = readCount(usage.cache_read_input_tokens)
    const outputTokens = readCount(usage.output_tokens)
    const last: TokenUsageBreakdown = {
      totalTokens: inputTokens + cachedInput + outputTokens,
      inputTokens: inputTokens + cachedInput,
      cachedInputTokens: cachedInput,
      outputTokens,
      reasoningOutputTokens: 0
    }
    const { total } = this.context.tokens.addLast(last)

    const failed = message.subtype !== 'success'
    const completedAtMs = this.context.nowMs()
    const turn = {
      id: turnId,
      items: [],
      itemsView: 'full',
      status: failed ? 'failed' : 'completed',
      error: failed
        ? { message: typeof message.result === 'string' ? message.result : `claude turn ended: ${String(message.subtype)}` }
        : null,
      startedAt: null,
      completedAt: Math.floor(completedAtMs / 1000),
      durationMs: readCount(message.duration_ms) || null
    } as unknown as Turn

    return {
      notifications: [
        asNotification('thread/tokenUsage/updated', {
          threadId,
          turnId,
          tokenUsage: { total, last, modelContextWindow: this.context.tokens.contextWindow }
        }),
        asNotification('turn/completed', { threadId, turn })
      ],
      turnEnded: true
    }
  }

  private completedBlockNotification(block: { id: string; kind: 'text' | 'thinking'; text: string }): ServerNotification {
    const item: ThreadItem = block.kind === 'text'
      ? ({ type: 'agentMessage', id: block.id, text: block.text, phase: null, memoryCitation: null } as ThreadItem)
      : ({ type: 'reasoning', id: block.id, summary: [block.text], content: [] } as unknown as ThreadItem)
    return asNotification('item/completed', {
      threadId: this.context.threadId,
      turnId: this.context.turnId,
      completedAtMs: this.context.nowMs(),
      item
    })
  }
}

export function claudeContextWindowFor(model: string | null): number {
  return model && model.includes('[1m]') ? 1_000_000 : 200_000
}

function asNotification(method: string, params: Record<string, unknown>): ServerNotification {
  return { method, params } as unknown as ServerNotification
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
