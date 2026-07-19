import type { ItemMeta } from './TaskActivity'
import type { TraceInputItem, TurnTraceEvent } from './trace-types'
import { clip, iso, maxTextChars, singleLine } from './trace-utils.ts'

const maxFieldChars = 8_000

export function traceEvent(item: TraceInputItem, meta: ItemMeta | undefined, index: number): TurnTraceEvent {
  const base = {
    index: index + 1,
    id: item.id,
    type: item.type,
    label: itemLabel(item),
    startedAt: iso(meta?.startedAtMs),
    completedAt: iso(meta?.completedAtMs),
    durationMs: itemDuration(item, meta),
    status: itemStatus(item),
    details: itemDetails(item, meta)
  }

  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined)) as TurnTraceEvent
}

function itemLabel(item: TraceInputItem): string {
  switch (item.type) {
    case 'userMessage': return 'User prompt'
    case 'agentMessage': return item.phase === 'commentary' ? 'Agent commentary' : 'Agent response'
    case 'commandExecution': return `Command: ${clip(singleLine(item.command), 80)}`
    case 'fileChange': return `Changed ${item.changes.length} ${item.changes.length === 1 ? 'file' : 'files'}`
    case 'dynamicToolCall': return `Tool: ${item.tool}`
    case 'mcpToolCall': return `MCP: ${item.server}/${item.tool}`
    case 'webSearch': return `Search: ${clip(item.query, 90)}`
    case 'reasoning': return 'Reasoning summary'
    case 'turnPlan': return 'Turn plan'
    case 'plan': return 'Plan'
    case 'system': return `System ${item.level}`
    default: return item.type
  }
}

function itemStatus(item: TraceInputItem): string | null | undefined {
  if (item.type === 'dynamicToolCall' && item.success !== null) return item.success ? 'completed' : 'failed'
  if ('status' in item && typeof item.status === 'string') return item.status
  if (item.type === 'system') return item.level
  return null
}

function itemDuration(item: TraceInputItem, meta: ItemMeta | undefined): number | null | undefined {
  if ('durationMs' in item && typeof item.durationMs === 'number') return item.durationMs
  if (meta?.startedAtMs && meta.completedAtMs) return Math.max(0, meta.completedAtMs - meta.startedAtMs)
  return null
}

function itemDetails(item: TraceInputItem, meta: ItemMeta | undefined): Record<string, unknown> {
  switch (item.type) {
    case 'userMessage':
      return {
        content: item.content.map((content) => {
          if (content.type === 'text') return { type: 'text', text: clip(content.text, maxFieldChars) }
          if (content.type === 'skill') return { type: 'skill', name: content.name, path: content.path }
          if (content.type === 'image' || content.type === 'localImage') return { type: content.type, image: '[omitted from trace]' }
          return bounded(content)
        })
      }
    case 'agentMessage':
      return { phase: item.phase, text: clip(item.text, maxTextChars) }
    case 'commandExecution':
      return {
        command: item.command,
        cwd: item.cwd,
        source: item.source,
        commandActions: bounded(item.commandActions),
        exitCode: item.exitCode,
        output: clip(item.aggregatedOutput ?? '', maxTextChars),
        outputTruncated: Boolean(item.aggregatedOutput && item.aggregatedOutput.length > maxTextChars)
      }
    case 'fileChange':
      return {
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind,
          diff: clip(change.diff, maxTextChars),
          diffTruncated: change.diff.length > maxTextChars
        }))
      }
    case 'dynamicToolCall':
      return {
        namespace: item.namespace,
        tool: item.tool,
        arguments: bounded(item.arguments),
        success: item.success,
        output: item.contentItems?.map((content) =>
          content.type === 'inputText'
            ? { type: content.type, text: clip(content.text, maxTextChars), truncated: content.text.length > maxTextChars }
            : { type: content.type, image: '[omitted from trace]' }
        ) ?? null
      }
    case 'mcpToolCall':
      return {
        server: item.server,
        tool: item.tool,
        arguments: bounded(item.arguments),
        result: bounded(item.result),
        error: bounded(item.error)
      }
    case 'reasoning':
      return {
        summary: item.summary.map((part) => clip(part, maxFieldChars)),
        content: item.content.map((part) => clip(part, maxFieldChars))
      }
    case 'plan': return { text: clip(item.text, maxTextChars) }
    case 'turnPlan': return { explanation: item.explanation, steps: item.steps }
    case 'webSearch': return { query: item.query, action: bounded(item.action) }
    case 'system': return { level: item.level, text: clip(item.text, maxFieldChars) }
    default:
      return {
        item: bounded(item),
        ...(meta?.progress?.length ? { progress: meta.progress.map((message) => clip(message, 500)) } : {})
      }
  }
}

function bounded(value: unknown): unknown {
  if (value === null || value === undefined) return value
  try {
    const serialized = JSON.stringify(value, (_key, part) =>
      typeof part === 'string' ? clip(part, maxFieldChars) : part
    )
    if (serialized.length <= maxTextChars) return JSON.parse(serialized)
    return { preview: clip(serialized, maxTextChars), truncated: true }
  } catch {
    return clip(String(value), maxFieldChars)
  }
}
