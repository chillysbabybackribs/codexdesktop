import type { RenderRow } from './transcript-model.js'
import {
  auditSummaryLabel,
  isAuditPrompt,
  parseAuditPrompt,
  parseAuditVerdict,
  type AuditRequestSummary
} from './audit-trigger.js'
import { stripMainChatContext } from './agent-session-model.js'

// Recency-weighted density for the small dock window: the transcript groups
// into exchanges (a user message plus everything until the next one). The
// newest exchange renders at full fidelity; older ones collapse to a one-line
// capsule — verdict badge + headline — and expand in place on click. Nothing
// is dropped; pixels just favor "now".

export type DockExchange = {
  id: string
  rows: RenderRow[]
  // Present when the exchange opened with an auto-audit briefing.
  audit: AuditRequestSummary | null
  // The exchange's final verdict, when its reply carries one.
  verdict: 'pass' | 'flag' | null
  headline: string
}

export function groupDockExchanges(rows: RenderRow[]): DockExchange[] {
  const exchanges: DockExchange[] = []
  let current: RenderRow[] = []

  const flush = (): void => {
    if (!current.length) return
    exchanges.push(buildExchange(current))
    current = []
  }

  for (const row of rows) {
    if (rowUserText(row) !== null) flush()
    current.push(row)
  }
  flush()
  return exchanges
}

// True when any of the exchange's rows belong to the given turn — used to
// keep an exchange expanded while its turn is still streaming.
export function exchangeHasTurn(exchange: DockExchange, turnId: string | null): boolean {
  if (!turnId) return false
  return exchange.rows.some((row) => row.turnId === turnId)
}

function buildExchange(rows: RenderRow[]): DockExchange {
  const opening = rowUserText(rows[0])
  const audit = opening !== null && isAuditPrompt(opening) ? parseAuditPrompt(opening) : null
  let verdict: 'pass' | 'flag' | null = null
  for (const row of rows) {
    if (row.kind === 'chat' && row.item.type === 'agentMessage' && row.item.text.trim()) {
      const parsed = parseAuditVerdict(row.item.text)
      if (parsed) verdict = parsed
    }
  }
  const id = rows[0].kind === 'chat' ? rows[0].item.id : rows[0].id
  return { id, rows, audit, verdict, headline: headlineFor(audit, opening) }
}

function rowUserText(row: RenderRow): string | null {
  if (row.kind !== 'chat' || row.item.type !== 'userMessage') return null
  return row.item.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
}

function headlineFor(audit: AuditRequestSummary | null, opening: string | null): string {
  if (audit) {
    return audit.files.length
      ? `audited ${auditSummaryLabel(audit.files)}`
      : `reviewed: ${clip(audit.userText || 'turn', 48)}`
  }
  const flat = stripMainChatContext(opening ?? '')
  return clip(flat, 64) || 'earlier exchange'
}

function clip(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > maxChars ? `${flat.slice(0, maxChars).trimEnd()}…` : flat
}
