import type { ThreadTokenUsage } from '../../shared/session-protocol'
import type { LiveTurnGlance } from './audit-trigger'

export function AgentContextPill({
  usage,
  disabled,
  compacting,
  onCompact
}: {
  usage: ThreadTokenUsage | null
  disabled: boolean
  compacting: boolean
  onCompact: () => Promise<void>
}): React.JSX.Element | null {
  const window = usage?.modelContextWindow
  const contextTokens = usage?.last.totalTokens ?? 0
  if (!usage || !window || contextTokens <= 0) return null

  const percent = Math.min(100, Math.round((contextTokens / window) * 100))
  const level = percent >= 80 ? 'is-high' : percent >= 60 ? 'is-warm' : ''

  return (
    <button
      type="button"
      className={`context-pill agent-context-pill ${level} ${compacting ? 'is-compacting' : ''}`}
      disabled={disabled}
      title={compacting
        ? 'Compacting this agent conversation…'
        : `Context ${percent}% full (${contextTokens.toLocaleString()} of ${window.toLocaleString()} tokens). Click to compact this agent conversation.`}
      onClick={() => void onCompact()}
    >
      <span className="context-pill-track" aria-hidden="true">
        <span className="context-pill-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="context-pill-label">{compacting ? '…' : `${percent}%`}</span>
    </button>
  )
}

// The glance caption is prose ("Checking git status") except when narration
// fell back to the raw command line — keep that in code so it reads as one.
export function GlanceActionLine({ text, className }: { text: string; className: string }): React.JSX.Element {
  return text.startsWith('$ ') ? (
    <code className={className}>{text}</code>
  ) : (
    <span className={className}>{text}</span>
  )
}

// Centered standby for an armed auditor with no conversation yet: waiting for
// the main chat, then live progress from the auditor's POV once a turn runs.
// `note` explains the last turn that completed without triggering an audit.
export function AuditStandby({
  live,
  note
}: {
  live: LiveTurnGlance | null
  note: string | null
}): React.JSX.Element {
  return (
    <div className="agent-audit-standby" role="status">
      <span className="agent-standby-spinner" aria-hidden="true" />
      {live ? (
        <>
          <span className="agent-standby-title shimmer-text">Watching main chat</span>
          {live.lastStep ? (
            <GlanceActionLine className="agent-standby-action" text={live.lastStep} />
          ) : null}
          <span className="agent-standby-meta">
            {live.stepCount} step{live.stepCount === 1 ? '' : 's'}
            {' · '}
            {live.fileCount} file{live.fileCount === 1 ? '' : 's'} touched
          </span>
        </>
      ) : (
        <>
          <span className="agent-standby-title">Waiting for the main chat</span>
          <span className="agent-standby-meta">{note ?? 'Reviews every completed turn — brief when trivial'}</span>
        </>
      )}
    </div>
  )
}
