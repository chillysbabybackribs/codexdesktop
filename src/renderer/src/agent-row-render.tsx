import { useState } from 'react'
import { AttachmentStrip, attachmentsFromUserInput } from './Attachments'
import { stripMainChatContext } from './agent-session-model'
import type { AuditRequestSummary } from './audit-trigger'
import { auditBriefMarkdown, auditSummaryLabel, isAuditPrompt, parseAuditPrompt, parseAuditVerdict, stripVerdictLine } from './audit-trigger'
import type { DockExchange } from './dock-exchanges'
import { MarkdownContent } from './MarkdownContent'
import { isWorkItem, type ActivityItem, type RenderRow } from './transcript-model'
import { WorkGroup, type ItemMeta, type WorkItem } from './TaskActivity'

// The first-flag decision handlers, attached to the latest flagged report of
// an agent whose send-to-main policy is still undecided.
export type SendPolicyPrompt = {
  onSendOnce: () => void
  onAlways: () => void
  onKeep: () => void
}

export type AgentRowContext = {
  itemMeta: Record<string, ItemMeta>
  activeTurnId: string | null
  workspace: string | null
  duplicateAssistantIds: ReadonlySet<string>
  lastAssistantTextId: string | null
  onSendFlagged: () => void
  sendPolicyPrompt: SendPolicyPrompt | null
}

// Assistant text with audit-verdict awareness: a "VERDICT: …" line (the
// auditor's machine-readable close) renders as a badge pinned above the
// report — verdict first, findings after. A flagged badge with a send action
// is a button — manual escalation into the main chat for reports the auto
// path did not (or could not) send.
// One transcript row for the dock's full-fidelity view. Chat rows keep the
// dock's compact message chrome (audit docs, verdict badges); activity rows
// reuse the main chat's WorkGroup so tool rows, terminal cards, thought
// blocks, and diff cards render identically at dock scale. Turn tails are
// skipped — the window header and Working shimmer already carry status.
export function renderAgentRow(row: RenderRow, context: AgentRowContext): React.JSX.Element | null {
  if (row.kind === 'tail') return null

  if (row.kind === 'activity') {
    return (
      <AgentActivity
        key={row.id}
        items={row.items}
        itemMeta={context.itemMeta}
        live={row.turnId !== null && row.turnId === context.activeTurnId}
        workspace={context.workspace}
      />
    )
  }

  const item = row.item
  if (item.type === 'userMessage') {
    const text = item.content
      .filter((content) => content.type === 'text')
      .map((content) => content.text)
      .join('\n')
    const attachments = attachmentsFromUserInput(item.content)
    const audit = isAuditPrompt(text) ? parseAuditPrompt(text) : null
    if (!audit && !text && !attachments.length) return null
    return (
      <div key={item.id} className={`agent-mini-message is-${audit ? 'audit' : 'user'}`}>
        {audit ? (
          <AuditBriefDoc audit={audit} />
        ) : (
          <>
            {text ? <span>{stripMainChatContext(text)}</span> : null}
            <AttachmentStrip attachments={attachments} compact />
          </>
        )}
      </div>
    )
  }

  if (item.type === 'agentMessage') {
    if (!item.text || context.duplicateAssistantIds.has(item.id)) return null
    const isLatestReport = item.id === context.lastAssistantTextId
    return (
      <div key={item.id} className="agent-mini-message is-assistant">
        <AssistantMessage
          text={item.text}
          // Manual escalation targets the latest audit exchange; only its
          // report gets an actionable flag badge or the first-flag prompt.
          onSendFlagged={isLatestReport ? context.onSendFlagged : undefined}
          sendPrompt={isLatestReport ? context.sendPolicyPrompt : null}
        />
      </div>
    )
  }

  // System notices, compaction markers, and other main-chat-only chrome stay
  // out of the mini windows.
  return null
}

// Activity rows interleave work items with commentary prose. Consecutive work
// items share a WorkGroup (the main chat's component); commentary renders as
// muted markdown between groups.
function AgentActivity({
  items,
  itemMeta,
  live,
  workspace
}: {
  items: ActivityItem[]
  itemMeta: Record<string, ItemMeta>
  live: boolean
  workspace: string | null
}): React.JSX.Element {
  const nodes: React.JSX.Element[] = []
  let run: WorkItem[] = []
  const flush = (): void => {
    if (!run.length) return
    nodes.push(
      <WorkGroup key={`work-${run[0].id}`} items={run} itemMeta={itemMeta} live={live} workspace={workspace} />
    )
    run = []
  }
  for (const item of items) {
    if (isWorkItem(item)) {
      run.push(item)
      continue
    }
    flush()
    if (item.text) {
      nodes.push(
        <div key={item.id} className="agent-mini-commentary">
          <MarkdownContent text={item.text} />
        </div>
      )
    }
  }
  flush()
  return <div className="agent-mini-activity">{nodes}</div>
}

function AssistantMessage({
  text,
  onSendFlagged,
  sendPrompt
}: {
  text: string
  onSendFlagged?: () => void
  sendPrompt?: SendPolicyPrompt | null
}): React.JSX.Element {
  const verdict = parseAuditVerdict(text)
  if (!verdict) return <MarkdownContent text={text} />
  // The undecided first flag asks instead of acting: the user judges a real
  // finding before granting (or declining) the standing auto-send.
  const asksPolicy = verdict === 'flag' && sendPrompt
  const actionable = verdict === 'flag' && !asksPolicy && onSendFlagged
  return (
    <>
      {actionable ? (
        <button
          type="button"
          className="agent-audit-verdict is-flag is-actionable is-lead"
          title="Send this report to the main chat"
          onClick={onSendFlagged}
        >
          ⚑ flagged · send to main chat
        </button>
      ) : (
        <span className={`agent-audit-verdict is-${verdict} is-lead`}>
          {verdict === 'pass' ? '✓ pass' : '⚑ flagged'}
        </span>
      )}
      <MarkdownContent text={stripVerdictLine(text)} />
      {asksPolicy ? (
        <div className="agent-send-prompt" role="group" aria-label="Send this report to the main chat?">
          <span className="agent-send-prompt-copy">Send this report to the main chat?</span>
          <div className="agent-send-prompt-actions">
            <button type="button" className="agent-send-prompt-button is-primary" onClick={sendPrompt.onSendOnce}>
              Send
            </button>
            <button type="button" className="agent-send-prompt-button" onClick={sendPrompt.onAlways}>
              Always send
            </button>
            <button type="button" className="agent-send-prompt-button is-quiet" onClick={sendPrompt.onKeep}>
              Keep here
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

// A collapsed exchange: verdict glyph + one-line headline. Click to expand
// the full-fidelity rows in place; click again on the open capsule to fold.
export function ExchangeCapsule({
  exchange,
  open,
  onToggle
}: {
  exchange: DockExchange
  open: boolean
  onToggle: (id: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`agent-exchange-capsule ${open ? 'is-open' : ''}`}
      aria-expanded={open}
      onClick={() => onToggle(exchange.id)}
    >
      <span
        className={`agent-capsule-verdict ${exchange.verdict ? `is-${exchange.verdict}` : 'is-none'}`}
        aria-hidden="true"
      >
        {exchange.verdict === 'pass' ? '✓' : exchange.verdict === 'flag' ? '⚑' : '·'}
      </span>
      <span className="agent-capsule-headline">{exchange.headline}</span>
      <span className="agent-capsule-chevron" aria-hidden="true">
        <ChevronDownIcon />
      </span>
    </button>
  )
}

// The audit briefing as a retractable markdown doc — a quiet, tool-call-style
// row that expands to a scrollable rendering of what the auditor was given.
function AuditBriefDoc({ audit }: { audit: AuditRequestSummary }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`agent-audit-doc ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="agent-audit-doc-row"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="agent-audit-doc-name">audit-brief.md</span>
        <span className="agent-audit-doc-files">{auditSummaryLabel(audit.files)}</span>
        <span className="agent-audit-chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>
      {open ? (
        <div className="agent-audit-doc-body">
          <MarkdownContent text={auditBriefMarkdown(audit)} />
        </div>
      ) : null}
    </div>
  )
}

// Shared chevron for capsules, audit docs, and the window title button — the
// menu (AgentWindowMenu) imports it from here to avoid a cycle with AgentDock.
export function ChevronDownIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
