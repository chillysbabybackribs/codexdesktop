import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ModelPill } from './ModelPill'
import type { Model } from '../../shared/session-protocol'
import type { ReasoningEffort } from '../../shared/session-protocol'
import type { ChatAttachment } from '../../shared/ipc'
import type { AgentSession } from './agent-session-model'
import type { LiveTurnGlance } from './audit-trigger'
import { exchangeHasTurn, groupDockExchanges } from './dock-exchanges'
import { buildRows } from './transcript-model'
import { emptySessionState, type SessionStore } from './session-store'
import { agentZoomStorageKey, storedAgentZoom } from './agent-zoom'
import { areAgentWindowPropsEqual, type AgentWindowProps } from './agent-window-props'
import { hiddenAgentCounts, windowScrollTarget, type AgentColumnMetrics } from './agent-column-scroll'
import { AgentComposer } from './AgentComposer'
import { AgentWindowMenu } from './AgentWindowMenu'
import { ExchangeCapsule, renderAgentRow, type AgentRowContext } from './agent-row-render'
import { AgentContextPill, AuditStandby, GlanceActionLine } from './agent-audit-ui'

export type { AgentLiteMessage, AgentSession } from './agent-session-model'
export { SendArrowIcon } from './AgentComposer'

export function AgentTabStrip({
  sessions,
  openKeys,
  onFocus
}: {
  sessions: AgentSession[]
  openKeys: string[]
  onFocus: (key: string) => void
}): React.JSX.Element {
  return (
    <div className="agent-tabs">
      {sessions.map((session) => (
        <button
          type="button"
          key={session.key}
          className={`agent-tab ${openKeys.includes(session.key) ? 'is-open' : ''}`}
          title={session.title}
          onClick={() => onFocus(session.key)}
        >
          <AgentStatusIcon status={session.status} />
          <span className="agent-tab-title">{session.title}</span>
        </button>
      ))}
    </div>
  )
}

export function AgentColumn({
  sessions,
  selectedKey,
  sessionStore,
  workspace,
  models,
  mainModel,
  mainReasoningEffort,
  liveMainTurn,
  isMainFocused,
  onSetModel,
  onSetModelEffort,
  onSelect,
  onMinimize,
  onCloseSession,
  onResetSession,
  onPromote,
  onToggleWatch,
  onToggleAudit,
  onToggleReport,
  onSendFeedback,
  onDecideSendPolicy,
  onSend,
  onSteer,
  onStop,
  onCompact
}: {
  sessions: AgentSession[]
  selectedKey: string | null
  sessionStore: SessionStore
  workspace: string | null
  models: Model[]
  mainModel: string | null
  mainReasoningEffort: ReasoningEffort | null
  liveMainTurn: LiveTurnGlance | null
  isMainFocused: boolean
  onSetModel: (key: string, model: string) => void
  onSetModelEffort: (key: string, model: string, effort: ReasoningEffort) => void
  onSelect: (key: string) => void
  onMinimize: (key: string) => void
  onCloseSession: (key: string) => void
  onResetSession: (key: string) => void
  onPromote: (key: string) => void
  onToggleWatch: (key: string) => void
  onToggleAudit: (key: string) => void
  onToggleReport: (key: string) => void
  onSendFeedback: (key: string) => void
  onDecideSendPolicy: (key: string, policy: 'always' | 'keep') => void
  onSend: (key: string, text: string, attachments?: ChatAttachment[]) => Promise<boolean>
  onSteer: (key: string, text: string) => Promise<boolean>
  onStop: (key: string) => Promise<void>
  onCompact: (key: string) => Promise<void>
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [hiddenAbove, setHiddenAbove] = useState(0)
  const [hiddenBelow, setHiddenBelow] = useState(0)
  // The extend state: one card at a time grows to a real reading surface.
  // Entering is explicit (the header button); exiting is implicit — focusing
  // the main chat, Escape, or extending another card. No mode to clean up.
  const [extendedKey, setExtendedKey] = useState<string | null>(null)

  useEffect(() => {
    if (isMainFocused) setExtendedKey(null)
  }, [isMainFocused])

  useEffect(() => {
    if (!extendedKey) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExtendedKey(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [extendedKey])

  // Closed/minimized cards can no longer hold the extend.
  useEffect(() => {
    if (extendedKey && !sessions.some((session) => session.key === extendedKey)) {
      setExtendedKey(null)
    }
  }, [extendedKey, sessions])

  const toggleExtend = (key: string): void => {
    setExtendedKey((current) => (current === key ? null : key))
    onSelect(key)
    // The card grows to the full column height — align its top to the
    // column so the reading surface starts where the eye is.
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-agent-key="${key}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'auto' })
    })
  }

  const readColumnMetrics = (node: HTMLDivElement): AgentColumnMetrics => {
    const first = node.firstElementChild
    return {
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      firstItemHeight: first instanceof HTMLElement ? first.offsetHeight : null
    }
  }

  const updateChevrons = (): void => {
    const node = scrollRef.current
    if (!node) return
    const { above, below } = hiddenAgentCounts(readColumnMetrics(node))
    setHiddenAbove(above)
    setHiddenBelow(below)
  }

  useEffect(() => {
    updateChevrons()
  }, [sessions.length])

  useEffect(() => {
    const handler = (): void => updateChevrons()
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])

  const scrollByWindow = (direction: 1 | -1): void => {
    const node = scrollRef.current
    if (!node) return
    const target = windowScrollTarget(readColumnMetrics(node), direction)
    node.scrollTo({ top: target, behavior: 'smooth' })
  }

  return (
    <>
      {extendedKey ? (
        <div
          className="agent-extend-scrim"
          aria-hidden="true"
          onClick={() => setExtendedKey(null)}
        />
      ) : null}
      <div className={`agent-column-shell ${extendedKey ? 'has-extended' : ''}`}>
      {hiddenAbove > 0 ? (
        <button
          type="button"
          className="agent-scroll-bar"
          aria-label={`${hiddenAbove} more agent${hiddenAbove > 1 ? 's' : ''} above`}
          onClick={() => scrollByWindow(-1)}
        >
          <ChevronIcon direction="up" />
          <span>
            {hiddenAbove} more {hiddenAbove > 1 ? 'agents' : 'agent'}
          </span>
        </button>
      ) : null}
      <div ref={scrollRef} className={`agent-column ${extendedKey ? 'has-extended' : ''}`} onScroll={updateChevrons}>
        {sessions.map((session) => (
          <AgentWindow
            key={session.key}
            session={session}
            isSelected={session.key === selectedKey}
            isExtended={session.key === extendedKey}
            sessionStore={sessionStore}
            workspace={workspace}
            models={models}
            mainModel={mainModel}
            mainReasoningEffort={mainReasoningEffort}
            liveMainTurn={liveMainTurn}
            onSetModel={onSetModel}
            onSetModelEffort={onSetModelEffort}
            onSelect={onSelect}
            onMinimize={onMinimize}
            onCloseSession={onCloseSession}
            onResetSession={onResetSession}
            onPromote={onPromote}
            onToggleWatch={onToggleWatch}
            onToggleAudit={onToggleAudit}
            onToggleReport={onToggleReport}
            onSendFeedback={onSendFeedback}
            onDecideSendPolicy={onDecideSendPolicy}
            onToggleExtend={toggleExtend}
            onSend={onSend}
            onSteer={onSteer}
            onStop={onStop}
            onCompact={onCompact}
          />
        ))}
      </div>
      {hiddenBelow > 0 ? (
        <button
          type="button"
          className="agent-scroll-bar"
          aria-label={`${hiddenBelow} more agent${hiddenBelow > 1 ? 's' : ''} below`}
          onClick={() => scrollByWindow(1)}
        >
          <ChevronIcon direction="down" />
          <span>
            {hiddenBelow} more {hiddenBelow > 1 ? 'agents' : 'agent'}
          </span>
        </button>
      ) : null}
      </div>
    </>
  )
}

function ChevronIcon({ direction }: { direction: 'up' | 'down' }): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={direction === 'up' ? 'M5 15l7-7 7 7' : 'M5 9l7 7 7-7'}
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Stable empty fallback for sessions the store has not seen yet —
// useSyncExternalStore requires a referentially stable snapshot.
const emptyAgentRenderState = emptySessionState()

const AgentWindow = memo(function AgentWindow({
  session,
  isSelected,
  isExtended,
  sessionStore,
  workspace,
  models,
  mainModel,
  mainReasoningEffort,
  liveMainTurn,
  onSetModel,
  onSetModelEffort,
  onSelect,
  onMinimize,
  onCloseSession,
  onResetSession,
  onPromote,
  onToggleWatch,
  onToggleAudit,
  onToggleReport,
  onSendFeedback,
  onDecideSendPolicy,
  onToggleExtend,
  onSend,
  onSteer,
  onStop,
  onCompact
}: AgentWindowProps): React.JSX.Element {
  const [zoomPercent, setZoomPercent] = useState(() => readAgentZoom(session.key))
  // Older exchanges the user re-opened from their capsules.
  const [expandedExchanges, setExpandedExchanges] = useState<ReadonlySet<string>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const suppressScrollRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    window.localStorage.setItem(agentZoomStorageKey(session.key), String(zoomPercent))
  }, [session.key, zoomPercent])

  // Phase 5: the dock renders the FULL transcript from the shared session
  // store — the same ThreadItem → rows pipeline as the main chat, so agents
  // get thought blocks, tool rows, terminal cards, and diff cards instead of
  // a prose-only projection.
  const subscribeRenderState = useCallback(
    (onChange: () => void) => sessionStore.subscribe(session.key, onChange),
    [sessionStore, session.key]
  )
  const renderState = useSyncExternalStore(
    subscribeRenderState,
    () => sessionStore.peek(session.key) ?? emptyAgentRenderState
  )
  const { rows } = useMemo(
    () => buildRows(renderState.items, renderState.itemMeta, renderState.turnId),
    [renderState.items, renderState.itemMeta, renderState.turnId]
  )

  const followTail = useCallback(() => {
    const node = scrollRef.current
    if (!node || !pinnedRef.current) return
    const target = Math.max(0, node.scrollHeight - node.clientHeight)
    if (Math.abs(node.scrollTop - target) <= 1) return
    suppressScrollRef.current = true
    node.scrollTop = target
  }, [])

  useEffect(() => {
    followTail()
  }, [followTail, rows, session.status, liveMainTurn])

  const handleScroll = useCallback(() => {
    // Ignore the scroll event caused by our own bottom-follow write.
    if (suppressScrollRef.current) {
      suppressScrollRef.current = false
      return
    }

    const node = scrollRef.current
    if (!node) return
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    pinnedRef.current = distanceFromBottom <= 48
  }, [])

  // Selected windows come up text-ready.
  useEffect(() => {
    if (isSelected) textareaRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const working = session.status === 'working'

  // Adjacent identical assistant restatements carry no information (same
  // policy the lite projection applied).
  const duplicateAssistantIds = useMemo(() => {
    const skip = new Set<string>()
    let previous: { text: string } | null = null
    for (const item of renderState.items) {
      if (item.type === 'agentMessage') {
        if (previous && previous.text === item.text) skip.add(item.id)
        previous = item
      } else if (item.type === 'userMessage') {
        previous = null
      }
    }
    return skip
  }, [renderState.items])

  let lastAssistantTextId: string | null = null
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.kind === 'chat' && row.item.type === 'agentMessage' && row.item.text && !duplicateAssistantIds.has(row.item.id)) {
      lastAssistantTextId = row.item.id
      break
    }
  }

  const renderContext: AgentRowContext = {
    itemMeta: renderState.itemMeta,
    activeTurnId: renderState.turnId,
    workspace,
    duplicateAssistantIds,
    lastAssistantTextId,
    onSendFlagged: () => onSendFeedback(session.key),
    // The first-flag decision moment: shown on the latest flagged report
    // until the user settles the send policy (here or via the menu toggle).
    sendPolicyPrompt:
      session.auditsMain && !session.sendPolicyDecided && !session.reportsToMain
        ? {
            onSendOnce: () => onSendFeedback(session.key),
            onAlways: () => {
              onDecideSendPolicy(session.key, 'always')
              onSendFeedback(session.key)
            },
            onKeep: () => onDecideSendPolicy(session.key, 'keep')
          }
        : null
  }

  // Recency-weighted density: the newest exchange (and any exchange still
  // streaming) renders at full fidelity; older ones collapse to one-line
  // capsules that expand in place. Nothing is dropped from the transcript —
  // pixels just favor "now" inside the small window.
  const exchanges = useMemo(() => groupDockExchanges(rows), [rows])
  const toggleExchange = (id: string): void => {
    setExpandedExchanges((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const messageNodes = exchanges.map((exchange, index) => {
    const pinnedOpen =
      index === exchanges.length - 1 || exchangeHasTurn(exchange, renderState.turnId)
    if (pinnedOpen) {
      return (
        <Fragment key={exchange.id}>
          {exchange.rows.map((row) => renderAgentRow(row, renderContext))}
        </Fragment>
      )
    }
    const isOpen = expandedExchanges.has(exchange.id)
    return (
      <div key={exchange.id} className={`agent-exchange ${isOpen ? 'is-open' : ''}`}>
        <ExchangeCapsule exchange={exchange} open={isOpen} onToggle={toggleExchange} />
        {isOpen ? exchange.rows.map((row) => renderAgentRow(row, renderContext)) : null}
      </div>
    )
  })
  const hasTranscript = rows.some((row) => row.kind !== 'tail')
  // The audit watch strip: while the main chat's turn is in flight and this
  // agent is armed to audit, show the doer's progress from the auditor's POV.
  const watchingMain = session.auditsMain && liveMainTurn !== null && !working

  const adjustZoom = (direction: 'in' | 'out' | 'reset'): void => {
    setZoomPercent((current) => direction === 'reset'
      ? 100
      : Math.max(80, Math.min(140, current + (direction === 'in' ? 10 : -10))))
  }

  // Click-anywhere-to-type: clicking empty window space focuses the composer,
  // but never when the click hit an interactive element or completed a text
  // selection (so copying transcript text still works).
  const handleWindowClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (target instanceof HTMLElement && target.closest('button, textarea, input, a')) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    textareaRef.current?.focus()
  }

  return (
    <div
      className={`agent-overlay ${isSelected ? 'is-selected' : ''} ${isExtended ? 'is-extended' : ''}`}
      data-agent-key={session.key}
      role="dialog"
      aria-label={`Agent: ${session.title}`}
      onPointerDownCapture={() => onSelect(session.key)}
      onClick={handleWindowClick}
    >
      <div className="agent-overlay-header">
        <AgentStatusIcon status={session.status} />
        <AgentWindowMenu
          session={session}
          zoomPercent={zoomPercent}
          adjustZoom={adjustZoom}
          onToggleWatch={onToggleWatch}
          onToggleAudit={onToggleAudit}
          onToggleReport={onToggleReport}
          onPromote={onPromote}
        />
        <div className="agent-overlay-actions">
          <button
            type="button"
            className={`icon-button ${isExtended ? 'is-active' : ''}`}
            aria-label={isExtended ? 'Collapse window' : 'Extend window'}
            title={isExtended ? 'Collapse' : 'Extend — click the main chat to collapse'}
            onClick={() => onToggleExtend(session.key)}
          >
            <ExtendIcon active={isExtended} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Minimize to tab"
            title="Minimize to tab"
            onClick={() => onMinimize(session.key)}
          >
            <MinimizeIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close agent"
            title="Close agent (stops the turn and unsubscribes the thread)"
            onClick={() => onCloseSession(session.key)}
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="agent-overlay-scroll" onScroll={handleScroll}>
        <div
          className="agent-overlay-content"
          style={{ '--agent-chat-zoom': `${zoomPercent / 100}` } as React.CSSProperties}
        >
          {!hasTranscript ? (
            session.auditsMain ? (
              <AuditStandby live={liveMainTurn} note={session.lastAuditNote} />
            ) : (
              <div className="agent-empty-hint" role="note">
                Message this agent below — or turn on “Audit main-chat turns” from the
                title menu to make it a reviewer again.
              </div>
            )
          ) : (
            messageNodes
          )}
          {hasTranscript && watchingMain && liveMainTurn ? (
            <div className="agent-audit-live" role="status">
              <span className="agent-audit-live-pulse" aria-hidden="true" />
              <div className="agent-audit-live-copy">
                <span className="agent-audit-live-title shimmer-text">Watching main chat</span>
                {liveMainTurn.lastStep ? (
                  <GlanceActionLine className="agent-audit-live-step" text={liveMainTurn.lastStep} />
                ) : null}
                <span className="agent-audit-live-stats">
                  {liveMainTurn.stepCount} step{liveMainTurn.stepCount === 1 ? '' : 's'}
                  {' · '}
                  {liveMainTurn.fileCount} file{liveMainTurn.fileCount === 1 ? '' : 's'} touched
                </span>
              </div>
            </div>
          ) : null}
          {hasTranscript && !working && session.lastAuditNote ? (
            <div className="agent-audit-note" role="status">{session.lastAuditNote}</div>
          ) : null}
          {working ? <div className="agent-overlay-working shimmer-text">Working…</div> : null}
        </div>
      </div>

      {models.length || session.contextUsage ? (
        <div className="agent-overlay-context">
          {models.length ? (
            <ModelPill
              models={models}
              selectedModel={session.model ?? mainModel}
              selectedEffort={session.reasoningEffort ?? mainReasoningEffort}
              onSelectModel={(model) => onSetModel(session.key, model)}
              onSelectModelEffort={(model, effort) => onSetModelEffort(session.key, model, effort)}
              reasoningMenuSide="left"
            />
          ) : null}
          <AgentContextPill
            usage={session.contextUsage}
            disabled={working || !session.threadId}
            compacting={session.isCompacting}
            onCompact={() => onCompact(session.key)}
          />
        </div>
      ) : null}

      <AgentComposer
        session={session}
        working={working}
        models={models}
        mainModel={mainModel}
        textareaRef={textareaRef}
        onSend={onSend}
        onSteer={onSteer}
        onStop={onStop}
        onResetSession={onResetSession}
      />
    </div>
  )
}, areAgentWindowPropsEqual)

function readAgentZoom(key: string): number {
  return storedAgentZoom(window.localStorage.getItem(agentZoomStorageKey(key)))
}

function AgentStatusIcon({ status }: { status: AgentSession['status'] }): React.JSX.Element {
  if (status === 'working') {
    return <span className="agent-status agent-status-spinner" role="status" aria-label="Working" />
  }
  if (status === 'done') {
    return (
      <svg
        className="agent-status agent-status-check"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        role="status"
        aria-label="Completed"
      >
        <path
          d="M4.5 12.5l5 5L19.5 7"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return <span className="agent-status agent-status-dot" aria-hidden="true" />
}

// Extend (corners out) vs collapse (corners in) for the window-size toggle —
// distinct from ExpandIcon, which the menu uses for "Switch to main chat".
function ExtendIcon({ active }: { active: boolean }): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {active ? (
        <path
          d="M10 4v6H4M14 20v-6h6M10 10 4 4M14 14l6 6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

function MinimizeIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 19h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
