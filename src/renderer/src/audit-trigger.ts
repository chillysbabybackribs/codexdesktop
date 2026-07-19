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

// The doer's final answer for the turn — what a chat-only audit reasons
// about. Last non-empty agent message, clipped to keep the briefing small.
export function turnAnswerText(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  turnId: string,
  maxChars = 1500
): string {
  let answer = ''
  for (const item of items) {
    if (item.type !== 'agentMessage') continue
    if (itemMeta[item.id]?.turnId !== turnId) continue
    if (item.text.trim()) answer = item.text
  }
  const flat = answer.trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars).trimEnd()}…` : flat
}

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
  answerText: string
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

// Every completed turn is audit material. File-changing turns get the
// workspace-grounded diff audit; chat-only turns (brainstorming, research,
// Q&A) get a second-opinion review of the answer itself — with an explicit
// escape hatch for trivial turns so a "hello" earns a few words, not a report.
export function buildAuditPrompt(input: {
  userText: string
  files: string[]
  steps?: string[]
  answerText?: string
  detectionUnavailable?: boolean
}): string {
  const request = input.userText.replace(/\s+/g, ' ').trim()
  const clipped = request.length > 300 ? `${request.slice(0, 300).trimEnd()}…` : request
  const shown = input.files.slice(0, 6)
  const more = input.files.length - shown.length
  const fileList = `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`

  const steps = input.steps?.length
    ? `Steps the main chat took, in order:\n${input.steps.map((step) => `  ${step}`).join('\n')}`
    : null
  // Blank lines squashed: the prompt stays one compact block, and the parse
  // path recovers the answer without ambiguity.
  const answerLines = (input.answerText ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
  const answer = answerLines.length
    ? `The main chat answered:\n${answerLines.map((line) => `  ${line}`).join('\n')}`
    : null

  const job = input.files.length
    ? 'Your job: audit the changes. Use the step log to decide depth: `git diff HEAD` or read only what looks consequential; skim the rest. Reply with concise findings: real bugs, risky changes, or a short "looks solid" with one reason.'
    : 'Your job: give a brief second opinion on the answer — a gap, a risk, a sharper angle, or agreement with one concrete reason.'

  return [
    '[auto-audit] The main chat just completed a turn in this shared workspace.',
    `The user's request was: "${clipped}"`,
    ...(steps ? [steps] : []),
    ...(input.files.length ? [`The turn changed ${input.files.length} file(s): ${fileList}.`] : []),
    ...(answer ? [answer] : []),
    ...(input.detectionUnavailable
      ? ['Note: file-change detection is unavailable here (workspace is not a git repo); check for edits yourself if relevant.']
      : []),
    job,
    'If the turn was trivial (a greeting or small acknowledgment), reply in a few words.',
    'Under 120 words. If you find a durable issue, append a dated bullet to AUDIT.md in the workspace root (create it if missing).'
  ].join('\n')
}

// The briefing as a markdown document — rendered in the agent card as a
// retractable "audit-brief.md" the auditor's work is grounded in.
export function auditBriefMarkdown(audit: AuditRequestSummary): string {
  const sections: string[] = []
  if (audit.userText) sections.push(`## Request\n\n${audit.userText}`)
  if (audit.files.length) {
    sections.push(`## Changed files\n\n${audit.files.map((file) => `- \`${file}\``).join('\n')}`)
  }
  if (audit.steps.length) {
    sections.push(`## Steps\n\n${audit.steps.map((step, index) => `${index + 1}. \`${step}\``).join('\n')}`)
  }
  return sections.join('\n\n') || '_No details captured._'
}

// Live glance at the in-flight main-chat turn, shown in auditor cards while
// the doer works ("watching" POV). Pure and cheap — recomputed per items
// change from state the renderer already holds; no model cost.
export type LiveTurnGlance = {
  turnId: string
  stepCount: number
  fileCount: number
  lastStep: string | null
}

export function liveTurnGlance(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  turnId: string
): LiveTurnGlance {
  // No cap: the glance wants the true count and the genuinely-latest step,
  // not the overflow summary line the audit briefing uses.
  const steps = turnStepLines(items, itemMeta, turnId, Number.MAX_SAFE_INTEGER)
  const files = turnChangedFiles(items, itemMeta, turnId)
  return {
    turnId,
    stepCount: steps.length,
    fileCount: files.length,
    lastStep: steps.at(-1) ?? null
  }
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
