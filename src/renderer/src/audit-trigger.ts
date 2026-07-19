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

export function buildAuditPrompt(input: { userText: string; files: string[] }): string {
  const request = input.userText.replace(/\s+/g, ' ').trim()
  const clipped = request.length > 300 ? `${request.slice(0, 300).trimEnd()}…` : request
  const shown = input.files.slice(0, 6)
  const more = input.files.length - shown.length
  const fileList = `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`

  return [
    '[auto-audit] The main chat just completed a turn in this shared workspace.',
    `The user's request was: "${clipped}"`,
    `The turn changed ${input.files.length} file(s): ${fileList}.`,
    'Inspect the actual changes yourself — run `git diff HEAD` (or read the touched files) in the current workspace; do not rely on this message alone.',
    'Reply with concise findings: real bugs, risky changes, or a short "looks solid" with one reason. Under 120 words.',
    'If you find an issue worth keeping, also append a dated bullet to AUDIT.md in the workspace root (create it if missing).'
  ].join('\n')
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
