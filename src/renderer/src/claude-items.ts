// Maps Claude Agent SDK tool calls into the same Codex ThreadItem shapes the
// rich in-task UI renders (terminal cards, live diffs, plans, browse rows).
//
// The renderer's WorkGroup/WorkBlock/TurnTail pipeline dispatches purely on
// `item.type`, so once a Claude tool is synthesized into e.g. a
// `commandExecution` or `fileChange` item it renders identically to Codex —
// no component changes required. Anything we don't recognize falls back to a
// generic `dynamicToolCall`, which is exactly how every Claude tool rendered
// before this module existed.

import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem'
import type { CommandAction } from '../../shared/codex-protocol/v2/CommandAction'
import type { TurnPlanStep } from '../../shared/codex-protocol/v2/TurnPlanStep'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort'
import type { ClaudeEffort } from '../../shared/ipc'
import type { TurnPlanItem } from './activity-model'

// Codex reasoning efforts that map 1:1 onto Claude effort levels; anything
// else (e.g. 'minimal') sends no override so the SDK default applies.
export function asClaudeEffort(value: ReasoningEffort | null): ClaudeEffort | null {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
    ? value
    : null
}

type CommandExecutionItem = Extract<ThreadItem, { type: 'commandExecution' }>
type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>
type DynamicToolCallItem = Extract<ThreadItem, { type: 'dynamicToolCall' }>

// The renderer-facing item union these builders can produce.
export type ClaudeWorkItem = CommandExecutionItem | FileChangeItem | DynamicToolCallItem | TurnPlanItem

type ToolInput = Record<string, unknown>

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function basename(path: string): string {
  const clean = path.replace(/\/+$/, '')
  return clean.split('/').pop() || clean
}

// ---------------------------------------------------------------------------
// Unified-diff synthesis — Claude gives us before/after strings (Edit) or the
// full new contents (Write); parseUnifiedDiff in diff.ts consumes standard
// `@@ … @@` + +/-/space unified-diff text, so we emit exactly that. We do not
// try to reconstruct git context lines: the changed region is what the card
// needs, and DiffCard already labels the file in its header.
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  // Drop a single trailing newline so a file that ends in "\n" doesn't yield a
  // phantom empty final line in the diff.
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  return normalized.length ? normalized.split('\n') : []
}

// Minimal LCS-free diff: emit all old lines as deletions then all new lines as
// additions when they differ. For an Edit this is scoped to old_string/
// new_string (already the changed region), so it stays compact and readable
// without a full Myers implementation.
function unifiedDiff(oldText: string, newText: string): string {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  // Trim shared prefix/suffix so an edit that changes one line in a large block
  // doesn't render the whole block as removed+added.
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1
  }
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1
    endNew -= 1
  }

  const removed = oldLines.slice(start, endOld)
  const added = newLines.slice(start, endNew)
  const context = oldLines.slice(0, start).slice(-2) // up to 2 leading context lines

  const body: string[] = []
  for (const line of context) body.push(` ${line}`)
  for (const line of removed) body.push(`-${line}`)
  for (const line of added) body.push(`+${line}`)

  const hunk = `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`
  return [hunk, ...body].join('\n')
}

function addDiff(newText: string): string {
  const lines = splitLines(newText)
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n')
}

// ---------------------------------------------------------------------------
// Tool → item classification
// ---------------------------------------------------------------------------

// Which Codex item type a given Claude tool maps to. Returned so the same
// decision drives both the in-progress shell (tool.started) and the completed
// patch (tool.completed).
export function claudeToolItemType(
  tool: string
): 'commandExecution' | 'fileChange' | 'turnPlan' | 'dynamicToolCall' {
  switch (tool) {
    case 'Bash':
    case 'BashOutput':
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'commandExecution'
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'fileChange'
    case 'TodoWrite':
      return 'turnPlan'
    default:
      return 'dynamicToolCall'
  }
}

function browseActions(tool: string, input: ToolInput): CommandAction[] {
  const path = str(input.file_path) ?? str(input.path)
  if (tool === 'Read' && path) {
    return [{ type: 'read', command: `Read ${path}`, name: basename(path), path }]
  }
  if (tool === 'LS' && path) {
    return [{ type: 'listFiles', command: `ls ${path}`, path }]
  }
  if (tool === 'Glob') {
    const pattern = str(input.pattern)
    return [{ type: 'search', command: `glob ${pattern ?? ''}`, query: pattern, path: str(input.path) }]
  }
  if (tool === 'Grep') {
    const pattern = str(input.pattern)
    return [{ type: 'search', command: `grep ${pattern ?? ''}`, query: pattern, path: str(input.path) }]
  }
  return []
}

// Build the in-progress item when a tool call starts. Output/exit/diff fill in
// on completion via patchClaudeToolItem.
export function startClaudeToolItem(callId: string, tool: string, input: unknown): ClaudeWorkItem {
  const args = (input && typeof input === 'object' ? input : {}) as ToolInput
  const kind = claudeToolItemType(tool)

  if (kind === 'commandExecution') {
    return {
      type: 'commandExecution',
      id: callId,
      command: tool === 'Bash' ? (str(args.command) ?? 'bash') : `${tool} ${str(args.file_path) ?? str(args.path) ?? str(args.pattern) ?? ''}`.trim(),
      cwd: '' as CommandExecutionItem['cwd'],
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: browseActions(tool, args),
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null
    }
  }

  if (kind === 'fileChange') {
    const path = str(args.file_path) ?? str(args.notebook_path) ?? ''
    return {
      type: 'fileChange',
      id: callId,
      // Diff synthesized on completion; empty while running shows the "Editing…"
      // skeleton row DiffCard renders for in-progress changes.
      changes: path ? [{ path, kind: { type: tool === 'Write' ? 'add' : 'update', ...(tool === 'Write' ? {} : { move_path: null }) } as FileChangeItem['changes'][number]['kind'], diff: '' }] : [],
      status: 'inProgress'
    }
  }

  if (kind === 'turnPlan') {
    return { type: 'turnPlan', id: callId, explanation: null, steps: todoSteps(args) }
  }

  return {
    type: 'dynamicToolCall',
    id: callId,
    namespace: 'claude',
    tool,
    arguments: args as DynamicToolCallItem['arguments'],
    status: 'inProgress',
    contentItems: null,
    success: null,
    durationMs: null
  }
}

// Patch the item on completion: fill command output / diff / status, or the
// generic tool result. `previous` is the in-progress item (carries the tool
// name, command, and args we synthesized at start time).
export function patchClaudeToolItem(
  previous: ClaudeWorkItem | undefined,
  tool: string,
  input: unknown,
  failed: boolean,
  content: unknown
): ClaudeWorkItem {
  const args = (input && typeof input === 'object' ? input : {}) as ToolInput
  const kind = claudeToolItemType(tool)
  const output = resultText(content)

  if (kind === 'commandExecution') {
    const base = previous?.type === 'commandExecution' ? previous : (startClaudeToolItem(previous?.id ?? '', tool, input) as CommandExecutionItem)
    return {
      ...base,
      status: failed ? 'failed' : 'completed',
      aggregatedOutput: output || base.aggregatedOutput,
      // No structured exit code from the SDK; is_error drives failed status and
      // the card falls back to a plain "failed" chip.
      exitCode: failed ? 1 : 0
    }
  }

  if (kind === 'fileChange') {
    const path = str(args.file_path) ?? str(args.notebook_path) ?? (previous?.type === 'fileChange' ? previous.changes[0]?.path : '') ?? ''
    return {
      type: 'fileChange',
      id: previous?.id ?? '',
      changes: path ? [{ path, ...fileChangeDiff(tool, args) }] : [],
      status: failed ? 'failed' : 'completed'
    }
  }

  if (kind === 'turnPlan') {
    return { type: 'turnPlan', id: previous?.id ?? '', explanation: null, steps: todoSteps(args) }
  }

  return {
    type: 'dynamicToolCall',
    id: previous?.id ?? '',
    namespace: 'claude',
    tool,
    arguments: args as DynamicToolCallItem['arguments'],
    status: failed ? 'failed' : 'completed',
    contentItems: output ? [{ type: 'inputText', text: output }] : null,
    success: !failed,
    durationMs: null
  }
}

function fileChangeDiff(tool: string, args: ToolInput): { kind: FileChangeItem['changes'][number]['kind']; diff: string } {
  if (tool === 'Write') {
    return { kind: { type: 'add' }, diff: addDiff(str(args.content) ?? '') }
  }
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : []
    const diff = edits
      .map((edit) => unifiedDiff(str(edit.old_string) ?? '', str(edit.new_string) ?? ''))
      .join('\n')
    return { kind: { type: 'update', move_path: null }, diff }
  }
  if (tool === 'NotebookEdit') {
    return { kind: { type: 'update', move_path: null }, diff: unifiedDiff(str(args.old_source) ?? '', str(args.new_source) ?? '') }
  }
  // Edit
  return { kind: { type: 'update', move_path: null }, diff: unifiedDiff(str(args.old_string) ?? '', str(args.new_string) ?? '') }
}

function todoSteps(args: ToolInput): TurnPlanStep[] {
  const todos = Array.isArray(args.todos) ? (args.todos as Array<Record<string, unknown>>) : []
  return todos.map((todo) => ({
    step: str(todo.content) ?? str(todo.activeForm) ?? '',
    status: normalizeTodoStatus(str(todo.status))
  }))
}

function normalizeTodoStatus(status: string | null): TurnPlanStep['status'] {
  if (status === 'in_progress') return 'inProgress'
  if (status === 'completed') return 'completed'
  return 'pending'
}

// Claude tool results are usually a string, sometimes an array of content
// blocks ({ type: 'text', text }). Flatten to displayable text.
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object' && 'text' in block && typeof (block as { text: unknown }).text === 'string') {
        return (block as { text: string }).text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}
