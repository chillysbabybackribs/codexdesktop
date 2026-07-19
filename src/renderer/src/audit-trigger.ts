import type { ItemMeta } from './activity-model.js'
import type { ChatItem } from './transcript-model.js'

// The Codex-doer / Claude-auditor pairing: pure decision + prompt building
// for the auto-audit that fires when a main-chat turn completes. Kept pure so
// the trigger conditions are testable without the App shell.
//
// Design (per the dock brainstorm): the auditor does NOT get the transcript —
// it shares the workspace, so the trigger prompt stays tiny and the auditor
// reads the actual diff itself. Cost control: only turns that changed files
// trigger, and busy auditors are skipped rather than queued (the next
// file-changing turn re-covers the workspace state).

export function turnChangedFiles(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  turnId: string
): string[] {
  const paths = new Set<string>()
  for (const item of items) {
    if (item.type !== 'fileChange') continue
    if (itemMeta[item.id]?.turnId !== turnId) continue
    for (const change of item.changes) paths.add(change.path)
  }
  return [...paths]
}

// Compact, ordered step log from the turn's work items — the app "watches"
// the task for free, so the auditor's one briefing already contains the whole
// story and it can choose per-file depth instead of exploring from scratch.
export function turnStepLines(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  turnId: string,
  maxLines = 20
): string[] {
  const lines: string[] = []
  for (const item of items) {
    if (item.type === 'system') continue
    if (itemMeta[item.id]?.turnId !== turnId) continue
    if (item.type === 'commandExecution') {
      const exit = item.exitCode === null || item.exitCode === undefined ? '' : ` (exit ${item.exitCode})`
      lines.push(clip(`$ ${item.command}${exit}`))
    } else if (item.type === 'fileChange') {
      lines.push(clip(`edited: ${item.changes.map((change) => change.path).join(', ')}`))
    } else if (item.type === 'webSearch') {
      lines.push(clip(`searched: ${(item as { query?: string }).query ?? ''}`))
    } else if (item.type === 'dynamicToolCall' || item.type === 'mcpToolCall') {
      lines.push(clip(`tool: ${(item as { tool?: string }).tool ?? item.type}`))
    }
  }
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines - 1), `… and ${lines.length - (maxLines - 1)} more steps`]
}

function clip(line: string, maxChars = 90): string {
  const flat = line.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars).trimEnd()}…` : flat
}

// Structured summary of an auto-audit request, carried on the auditor's user
// message so the agent card can render a compact, collapsible card instead of
// the full prompt verbatim. The model still receives buildAuditPrompt()'s
// string; this is presentation-only.
export type AuditRequestSummary = {
  userText: string
  files: string[]
  steps: string[]
}

// One-liner headline for the collapsed card: file count + names, e.g.
// "codex-config.ts +2 more" or "codex-config.ts, foo.ts".
export function auditSummaryLabel(files: string[]): string {
  const count = files.length
  if (count === 0) return 'no files changed'
  const names = files.map(basename)
  if (count <= 2) return names.join(', ')
  return `${names[0]} +${count - 1} more`
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function buildAuditPrompt(input: { userText: string; files: string[]; steps?: string[] }): string {
  const request = input.userText.replace(/\s+/g, ' ').trim()
  const clipped = request.length > 300 ? `${request.slice(0, 300).trimEnd()}…` : request
  const shown = input.files.slice(0, 6)
  const more = input.files.length - shown.length
  const fileList = `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`

  const steps = input.steps?.length
    ? `Steps the main chat took, in order:\n${input.steps.map((step) => `  ${step}`).join('\n')}`
    : null

  return [
    '[auto-audit] The main chat just completed a turn in this shared workspace.',
    `The user's request was: "${clipped}"`,
    ...(steps ? [steps] : []),
    `The turn changed ${input.files.length} file(s): ${fileList}.`,
    'Use the step log to decide depth: `git diff HEAD` or read only the changes that look consequential; skim the rest.',
    'Reply with concise findings: real bugs, risky changes, or a short "looks solid" with one reason. Under 120 words.',
    'If you find an issue worth keeping, also append a dated bullet to AUDIT.md in the workspace root (create it if missing).'
  ].join('\n')
}

// True when a stored user message is an auto-audit request. Cheap marker check
// so the restore path can rebuild the collapsed card instead of showing the
// full prompt verbatim after an app restart.
export function isAuditPrompt(text: string): boolean {
  return text.startsWith('[auto-audit]')
}

// Reconstruct a display summary from a stored audit prompt (restore path only;
// live audits carry the structured data directly). Per-file paths past the
// clipped list aren't recoverable from prose, so the file list holds what the
// prompt showed — enough for the collapsed headline and the expanded detail.
export function parseAuditPrompt(text: string): AuditRequestSummary {
  const requestMatch = text.match(/The user's request was: "([\s\S]*?)"\n/)
  const userText = requestMatch ? requestMatch[1] : ''

  const files: string[] = []
  const fileMatch = text.match(/The turn changed \d+ file\(s\): (.+?)\.\n/)
  if (fileMatch) {
    for (const part of fileMatch[1].split(',')) {
      const name = part.replace(/\band \d+ more\b/, '').trim()
      if (name) files.push(name)
    }
  }

  const steps: string[] = []
  const stepBlock = text.match(/Steps the main chat took, in order:\n([\s\S]*?)\nThe turn changed/)
  if (stepBlock) {
    for (const line of stepBlock[1].split('\n')) {
      const step = line.trim()
      if (step) steps.push(step)
    }
  }

  return { userText, files, steps }
}

export function shouldTriggerAudit(input: {
  auditorStatus: 'idle' | 'working' | 'done'
  auditorTurnId: string | null
  changedFiles: string[]
}): boolean {
  if (input.changedFiles.length === 0) return false
  if (input.auditorTurnId || input.auditorStatus === 'working') return false
  return true
}
