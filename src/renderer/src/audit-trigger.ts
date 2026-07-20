import type { ItemMeta } from './activity-model.js'
import { cleanCommand, commandDescriptionOf, narrateCommand } from './command-narrate.js'
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
    'Under 120 words. If you find a durable issue, append a dated bullet to AUDIT.md in the workspace root (create it if missing).',
    'End your reply with its verdict on one line: "VERDICT: pass" if nothing needs attention, or "VERDICT: flag" if something does.'
  ].join('\n')
}

// ── Audit feedback: the report flowing back to the doer ─────────────────
//
// The auditor ends every report with a VERDICT line. `pass` stays quiet in
// the agent window; `flag` may auto-send the report into the main chat so the
// doer can act on it. Loop control lives in shouldSendAuditFeedback: verdict
// gate (natural convergence — fixes that pass stop the cycle), idle + same-
// thread gates (never interrupt or cross threads), and a bounce cap (the hard
// stop; today one bounce per user-initiated turn, the future per-agent trust
// dial raises it).

export function parseAuditVerdict(report: string): 'pass' | 'flag' | null {
  const matches = [...report.matchAll(/^\s*VERDICT:\s*(pass|flag)\b/gim)]
  const last = matches.at(-1)
  return last ? (last[1].toLowerCase() as 'pass' | 'flag') : null
}

export function stripVerdictLine(report: string): string {
  return report.replace(/\n?^\s*VERDICT:\s*(?:pass|flag)\b.*$/gim, '').trim()
}

export function isAuditFeedback(text: string): boolean {
  return text.startsWith('[audit-feedback]')
}

export function buildAuditFeedbackMessage(input: { agentTitle: string; report: string }): string {
  const body = stripVerdictLine(input.report)
  return [
    `[audit-feedback] ${input.agentTitle} reviewed the last turn and flagged issues:`,
    body,
    'Address what is valid; push back with a reason on anything that is not.'
  ].join('\n')
}

// Display-side parse of a feedback message: the main transcript renders it as
// a compact retractable card instead of the raw block the model receives.
export function parseAuditFeedback(text: string): { agentTitle: string; report: string } | null {
  if (!isAuditFeedback(text)) return null
  const lines = text.split('\n')
  const header = lines[0].match(/^\[audit-feedback\] (.*?) reviewed the last turn and flagged issues:$/)
  const agentTitle = header ? header[1] : 'Auditor'
  const body = lines.slice(1)
  if (body.at(-1) === 'Address what is valid; push back with a reason on anything that is not.') {
    body.pop()
  }
  return { agentTitle, report: body.join('\n').trim() }
}

export function shouldSendAuditFeedback(input: {
  verdict: 'pass' | 'flag' | null
  reportsToMain: boolean
  mainIdle: boolean
  sameThread: boolean
  auditedTurnWasFeedback: boolean
  // Loop-to-done controller approval (audit-loop-controller.ts): a fix turn's
  // flagged audit may bounce again only when the controller says the loop has
  // headroom and is making progress.
  loopMayContinue: boolean
}): boolean {
  if (!input.reportsToMain) return false
  // Missing verdicts fail quiet: the report stays visible in the agent
  // window, but an ambiguous audit never starts a doer turn on its own.
  if (input.verdict !== 'flag') return false
  if (!input.mainIdle) return false
  if (!input.sameThread) return false
  // Feedback-started turns bounce again only under controller policy — the
  // old flat one-bounce cap is the controller's fallback (loopMayContinue
  // false).
  if (input.auditedTurnWasFeedback && !input.loopMayContinue) return false
  return true
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
  if (audit.answerText) sections.push(`## Answer\n\n${audit.answerText}`)
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
    lastStep: currentActionLine(items, itemMeta, turnId)
  }
}

// Natural-language caption for what the doer is doing right now — newest
// in-turn item worth narrating, progressive tense while it is still running.
// The audit briefing keeps the raw `$ command` lines; this is display only.
export function currentActionLine(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  turnId: string
): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (itemMeta[item.id]?.turnId !== turnId) continue
    const status = 'status' in item && typeof item.status === 'string' ? item.status : null
    const running = status ? status === 'inProgress' : !itemMeta[item.id]?.completedAtMs

    switch (item.type) {
      case 'reasoning':
        if (running) return 'Thinking'
        continue
      case 'agentMessage':
        if (running) return 'Writing a reply'
        continue
      case 'commandExecution': {
        const narration = narrateCommand(item.command, item.commandActions, commandDescriptionOf(item))
        if (narration.natural) return clip(running ? narration.running : narration.done)
        return clip(`$ ${cleanCommand(item.command)}`)
      }
      case 'fileChange': {
        const names = item.changes.map((change) => basename(change.path))
        const label = names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1} more`
        return clip(`${running ? 'Editing' : 'Edited'} ${label || 'files'}`)
      }
      case 'webSearch': {
        const query = (item as { query?: string }).query
        return query ? clip(`Searching the web for “${query}”`) : 'Searching the web'
      }
      case 'mcpToolCall':
      case 'dynamicToolCall': {
        const tool = (item as { tool?: string }).tool ?? 'a tool'
        return clip(`${running ? 'Using' : 'Used'} ${tool}`)
      }
      default:
        continue
    }
  }
  return null
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
  const stepBlock = text.match(
    /Steps the main chat took, in order:\n([\s\S]*?)\n(?:The turn changed|The main chat answered:|Note: file-change|Your job:)/
  )
  if (stepBlock) {
    for (const line of stepBlock[1].split('\n')) {
      const step = line.trim()
      if (step) steps.push(step)
    }
  }

  const answerBlock = text.match(/The main chat answered:\n([\s\S]*?)\n(?:Note: file-change|Your job:)/)
  const answerText = answerBlock
    ? answerBlock[1].split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
    : ''

  return { userText, files, steps, answerText }
}

// Every completed turn with anything to look at fires (files, an answer, or
// steps); only truly-empty turns and busy auditors skip. Chat-only turns are
// deliberate audit material — second viewpoints during brainstorming/research.
export function shouldTriggerAudit(input: {
  auditorStatus: 'idle' | 'working' | 'done'
  auditorTurnId: string | null
  changedFiles: string[]
  answerText?: string
  stepCount?: number
}): boolean {
  const hasSubstance =
    input.changedFiles.length > 0 ||
    Boolean(input.answerText?.trim()) ||
    (input.stepCount ?? 0) > 0
  if (!hasSubstance) return false
  if (input.auditorTurnId || input.auditorStatus === 'working') return false
  return true
}
