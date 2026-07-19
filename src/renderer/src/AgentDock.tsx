import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent } from 'react'
import { ModelPill } from './ModelPill'
import type { Model } from '../../shared/session-protocol'
import type { ReasoningEffort } from '../../shared/session-protocol'
import type { ThreadTokenUsage } from '../../shared/session-protocol'
import type { ChatAttachment } from '../../shared/ipc'
import { AttachmentButton, AttachmentStrip, attachmentsFromUserInput, saveBrowserFiles } from './Attachments'
import { stripMainChatContext, type AgentSession } from './agent-session-model'
import type { AuditRequestSummary, LiveTurnGlance } from './audit-trigger'
import { auditBriefMarkdown, auditSummaryLabel, isAuditPrompt, parseAuditPrompt, parseAuditVerdict, stripVerdictLine } from './audit-trigger'
import { exchangeHasTurn, groupDockExchanges, type DockExchange } from './dock-exchanges'
import { MarkdownContent } from './MarkdownContent'
import { buildRows, isWorkItem, type ActivityItem, type RenderRow } from './transcript-model'
import { WorkGroup, type ItemMeta, type WorkItem } from './TaskActivity'
import { emptySessionState, type SessionStore } from './session-store'
import { agentZoomStorageKey, storedAgentZoom } from './agent-zoom'

export type { AgentLiteMessage, AgentSession } from './agent-session-model'

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

  const updateChevrons = (): void => {
    const node = scrollRef.current
    if (!node) return
    const first = node.firstElementChild
    const slot = first instanceof HTMLElement ? first.offsetHeight + 10 : node.clientHeight / 2
    const above = Math.max(0, Math.round(node.scrollTop / slot))
    const below = Math.max(
      0,
      Math.round((node.scrollHeight - node.scrollTop - node.clientHeight) / slot)
    )
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
    const first = node.firstElementChild
    const slot = first instanceof HTMLElement ? first.offsetHeight + 10 : node.clientHeight / 2
    // Absolute target from the CURRENT slot index — repeated clicks land on
    // exact snap points instead of compounding relative deltas mid-animation.
    const index = Math.round(node.scrollTop / slot) + direction
    const target = Math.max(0, Math.min(index * slot, node.scrollHeight - node.clientHeight))
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

type AgentWindowProps = {
  session: AgentSession
  isSelected: boolean
  isExtended: boolean
  sessionStore: SessionStore
  workspace: string | null
  models: Model[]
  mainModel: string | null
  mainReasoningEffort: ReasoningEffort | null
  liveMainTurn: LiveTurnGlance | null
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
  onToggleExtend: (key: string) => void
  onSend: (key: string, text: string, attachments?: ChatAttachment[]) => Promise<boolean>
  onSteer: (key: string, text: string) => Promise<boolean>
  onStop: (key: string) => Promise<void>
  onCompact: (key: string) => Promise<void>
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
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [zoomPercent, setZoomPercent] = useState(() => readAgentZoom(session.key))
  // Older exchanges the user re-opened from their capsules.
  const [expandedExchanges, setExpandedExchanges] = useState<ReadonlySet<string>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const suppressScrollRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    window.localStorage.setItem(agentZoomStorageKey(session.key), String(zoomPercent))
  }, [session.key, zoomPercent])

  useEffect(() => {
    if (!isMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setIsMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isMenuOpen])

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

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(120, Math.max(34, textarea.scrollHeight))}px`
  }, [value])

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
  const hasDraft = Boolean(value.trim() || attachments.length)

  const adjustZoom = (direction: 'in' | 'out' | 'reset'): void => {
    setZoomPercent((current) => direction === 'reset'
      ? 100
      : Math.max(80, Math.min(140, current + (direction === 'in' ? 10 : -10))))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = value.trim()
    if ((!text && !attachments.length) || isSending) return
    setValue('')
    const submittedAttachments = attachments
    if (!working) setAttachments([])
    setIsSending(true)
    try {
      // While a turn runs, typed text steers it instead of starting a new turn
      // — same routing as the main composer.
      const accepted = working
        ? await onSteer(session.key, text)
        : await onSend(session.key, text, submittedAttachments)
      if (!accepted) {
        setValue((current) => (current ? `${text}\n${current}` : text))
        if (!working) setAttachments(submittedAttachments)
      }
    } finally {
      setIsSending(false)
      // The composer stays text-ready: refocus once the textarea re-enables.
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
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
        <div className="agent-overlay-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className={`agent-overlay-title-button ${isMenuOpen ? 'is-open' : ''}`}
            aria-expanded={isMenuOpen}
            aria-haspopup="menu"
            onClick={() => setIsMenuOpen((open) => !open)}
          >
            <span className="agent-overlay-title">{session.title}</span>
            <ChevronDownIcon />
          </button>
          {isMenuOpen ? (
            <div className="agent-overlay-menu" role="menu" aria-label={`${session.title} controls`}>
              <div className="agent-menu-label">Agent controls</div>
              <button
                type="button"
                className="agent-menu-item"
                role="menuitemcheckbox"
                aria-checked={session.watchesMain}
                onClick={() => {
                  onToggleWatch(session.key)
                  setIsMenuOpen(false)
                }}
              >
                <EyeIcon />
                <span className="agent-menu-item-copy">
                  <strong>{session.watchesMain ? 'Sharing main-chat context' : 'Share main-chat context'}</strong>
                  <small>{session.watchesMain ? 'Helper mode is on' : 'Keep this agent independent'}</small>
                </span>
                <span className={`agent-menu-status ${session.watchesMain ? 'is-active' : ''}`}>
                  {session.watchesMain ? 'On' : 'Off'}
                </span>
              </button>
              <button
                type="button"
                className="agent-menu-item"
                role="menuitemcheckbox"
                aria-checked={session.auditsMain}
                onClick={() => {
                  onToggleAudit(session.key)
                  setIsMenuOpen(false)
                }}
              >
                <EyeIcon />
                <span className="agent-menu-item-copy">
                  <strong>{session.auditsMain ? 'Auditing main-chat turns' : 'Audit main-chat turns'}</strong>
                  <small>
                    {session.auditsMain
                      ? 'Reviews every completed main-chat turn'
                      : 'Second viewpoint on every turn (defaults to Claude)'}
                  </small>
                </span>
                <span className={`agent-menu-status ${session.auditsMain ? 'is-active' : ''}`}>
                  {session.auditsMain ? 'On' : 'Off'}
                </span>
              </button>
              <button
                type="button"
                className="agent-menu-item"
                role="menuitemcheckbox"
                aria-checked={session.reportsToMain}
                onClick={() => {
                  onToggleReport(session.key)
                  setIsMenuOpen(false)
                }}
              >
                <EyeIcon />
                <span className="agent-menu-item-copy">
                  <strong>{session.reportsToMain ? 'Sending findings to main chat' : 'Send findings to main chat'}</strong>
                  <small>
                    {session.reportsToMain
                      ? 'Flagged audits go to the doer automatically'
                      : 'Flagged audits auto-send · one round per turn'}
                  </small>
                </span>
                <span className={`agent-menu-status ${session.reportsToMain ? 'is-active' : ''}`}>
                  {session.reportsToMain ? 'On' : 'Off'}
                </span>
              </button>
              <button
                type="button"
                className="agent-menu-item"
                role="menuitem"
                onClick={() => {
                  onPromote(session.key)
                  setIsMenuOpen(false)
                }}
              >
                <ExpandIcon />
                <span className="agent-menu-item-copy">
                  <strong>Switch to main chat</strong>
                  <small>Save this conversation to chat history</small>
                </span>
              </button>
              <div className="agent-menu-divider" />
              <div className="agent-menu-zoom" role="group" aria-label="Chat zoom">
                <span className="agent-menu-zoom-label">
                  <ZoomIcon />
                  <span>Chat zoom</span>
                </span>
                <div className="agent-zoom-controls">
                  <button
                    type="button"
                    aria-label="Zoom chat out"
                    title="Zoom out"
                    disabled={zoomPercent <= 80}
                    onClick={() => adjustZoom('out')}
                  >
                    <MinusIcon />
                  </button>
                  <button
                    type="button"
                    className="agent-zoom-value"
                    aria-label="Reset chat zoom"
                    title="Reset chat zoom"
                    onClick={() => adjustZoom('reset')}
                  >
                    {zoomPercent}%
                  </button>
                  <button
                    type="button"
                    aria-label="Zoom chat in"
                    title="Zoom in"
                    disabled={zoomPercent >= 140}
                    onClick={() => adjustZoom('in')}
                  >
                    <PlusIcon />
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
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
              <AgentModeSelector
                session={session}
                onToggleWatch={onToggleWatch}
                onToggleAudit={onToggleAudit}
                onToggleReport={onToggleReport}
              />
            )
          ) : (
            messageNodes
          )}
          {hasTranscript && watchingMain && liveMainTurn ? (
            <div className="agent-audit-live" role="status">
              <span className="agent-audit-live-pulse" aria-hidden="true" />
              <div className="agent-audit-live-copy">
                <span className="agent-audit-live-title shimmer-text">Watching main chat</span>
                <span className="agent-audit-live-stats">
                  {liveMainTurn.stepCount} step{liveMainTurn.stepCount === 1 ? '' : 's'}
                  {' · '}
                  {liveMainTurn.fileCount} file{liveMainTurn.fileCount === 1 ? '' : 's'} touched
                </span>
                {liveMainTurn.lastStep ? (
                  <code className="agent-audit-live-step">{liveMainTurn.lastStep}</code>
                ) : null}
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

      <form
        className="agent-overlay-composer"
        onSubmit={handleSubmit}
        onDragOver={(event) => { if (!working && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
        onDrop={(event) => {
          if (working) return
          const files = Array.from(event.dataTransfer.files)
          if (!files.length) return
          event.preventDefault()
          setAttachmentError(null)
          void saveBrowserFiles(files).then((items) => setAttachments((current) => [...current, ...items])).catch((error: unknown) => setAttachmentError(error instanceof Error ? error.message : String(error)))
        }}
      >
        <div className="agent-composer-body">
          <AttachmentStrip attachments={attachments} removable compact onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))} />
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={working ? 'Add guidance while the agent works…' : 'Message this agent…'}
          disabled={isSending}
          onChange={(event) => setValue(event.target.value)}
          onPaste={(event) => {
            if (working) return
            const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
            if (!images.length) return
            const pastedText = event.clipboardData.getData('text/plain')
            const start = event.currentTarget.selectionStart
            const end = event.currentTarget.selectionEnd
            event.preventDefault()
            if (pastedText) setValue((current) => `${current.slice(0, start)}${pastedText}${current.slice(end)}`)
            setAttachmentError(null)
            void saveBrowserFiles(images).then((items) => setAttachments((current) => [...current, ...items])).catch((error: unknown) => setAttachmentError(error instanceof Error ? error.message : String(error)))
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
          {attachmentError ? <span className="agent-attachment-error" role="status">{attachmentError}</span> : null}
        </div>
        <AttachmentButton disabled={working || isSending} onAdd={(items) => { setAttachmentError(null); setAttachments((current) => [...current, ...items]) }} onError={setAttachmentError} />
        {working ? (
          <button
            type="button"
            className="stop-square-button"
            aria-label="Stop agent turn"
            title="Stop"
            onClick={() => void onStop(session.key)}
          >
            <span className="stop-square" aria-hidden="true" />
          </button>
        ) : hasDraft ? (
          <button
            type="submit"
            className="send-button"
            aria-label="Send to agent"
            disabled={isSending}
          >
            <SendArrowIcon />
          </button>
        ) : (
          <button
            type="button"
            className="send-button agent-new-chat-button"
            aria-label="Start a new agent chat"
            title="New chat"
            disabled={isSending}
            onClick={() => onResetSession(session.key)}
          >
            <NewChatPlusIcon />
          </button>
        )}
      </form>
    </div>
  )
}, areAgentWindowPropsEqual)

function areAgentWindowPropsEqual(
  previous: AgentWindowProps,
  next: AgentWindowProps
): boolean {
  return previous.session === next.session &&
    previous.isSelected === next.isSelected &&
    previous.models === next.models &&
    previous.mainModel === next.mainModel &&
    previous.mainReasoningEffort === next.mainReasoningEffort &&
    // Only auditors render the live glance; everyone else skips those updates.
    (!next.session.auditsMain || isSameLiveGlance(previous.liveMainTurn, next.liveMainTurn))
}

function isSameLiveGlance(a: LiveTurnGlance | null, b: LiveTurnGlance | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.turnId === b.turnId &&
    a.stepCount === b.stepCount &&
    a.fileCount === b.fileCount &&
    a.lastStep === b.lastStep
}

function readAgentZoom(key: string): number {
  return storedAgentZoom(window.localStorage.getItem(agentZoomStorageKey(key)))
}

function AgentContextPill({
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

// The empty-state setup panel: the agent's pairing modes as minimal
// text-and-toggle rows. The same flags live in the header menu afterwards.
function AgentModeSelector({
  session,
  onToggleWatch,
  onToggleAudit,
  onToggleReport
}: {
  session: AgentSession
  onToggleWatch: (key: string) => void
  onToggleAudit: (key: string) => void
  onToggleReport: (key: string) => void
}): React.JSX.Element {
  return (
    <div className="agent-mode-selector">
      <button
        type="button"
        className="agent-mode-option"
        role="switch"
        aria-checked={session.watchesMain}
        onClick={() => onToggleWatch(session.key)}
      >
        <span className="agent-mode-copy">
          <strong>Share main-chat context</strong>
          <small>Each message carries a snapshot of the main conversation</small>
        </span>
        <span className={`agent-mode-switch ${session.watchesMain ? 'is-on' : ''}`} aria-hidden="true">
          <span className="agent-mode-knob" />
        </span>
      </button>
      <button
        type="button"
        className="agent-mode-option"
        role="switch"
        aria-checked={session.auditsMain}
        onClick={() => onToggleAudit(session.key)}
      >
        <span className="agent-mode-copy">
          <strong>Audit main-chat turns</strong>
          <small>Second viewpoint on every turn — diffs, answers, ideas · defaults to Claude</small>
        </span>
        <span className={`agent-mode-switch ${session.auditsMain ? 'is-on' : ''}`} aria-hidden="true">
          <span className="agent-mode-knob" />
        </span>
      </button>
      <button
        type="button"
        className="agent-mode-option"
        role="switch"
        aria-checked={session.reportsToMain}
        onClick={() => onToggleReport(session.key)}
      >
        <span className="agent-mode-copy">
          <strong>Send findings to main chat</strong>
          <small>Flagged audits auto-send to the doer · one round per turn</small>
        </span>
        <span className={`agent-mode-switch ${session.reportsToMain ? 'is-on' : ''}`} aria-hidden="true">
          <span className="agent-mode-knob" />
        </span>
      </button>
    </div>
  )
}

// Centered standby for an armed auditor with no conversation yet: waiting for
// the main chat, then live progress from the auditor's POV once a turn runs.
// `note` explains the last turn that completed without triggering an audit.
function AuditStandby({
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
          <span className="agent-standby-meta">
            {live.stepCount} step{live.stepCount === 1 ? '' : 's'}
            {' · '}
            {live.fileCount} file{live.fileCount === 1 ? '' : 's'} touched
          </span>
          {live.lastStep ? <code className="agent-standby-step">{live.lastStep}</code> : null}
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

// Assistant text with audit-verdict awareness: a trailing "VERDICT: …" line
// (the auditor's machine-readable close) renders as a quiet badge instead of
// prose. A flagged badge with a send action is a button — manual escalation
// into the main chat for reports the auto path did not (or could not) send.
// One transcript row for the dock's full-fidelity view. Chat rows keep the
// dock's compact message chrome (audit docs, verdict badges); activity rows
// reuse the main chat's WorkGroup so tool rows, terminal cards, thought
// blocks, and diff cards render identically at dock scale. Turn tails are
// skipped — the window header and Working shimmer already carry status.
function renderAgentRow(
  row: RenderRow,
  context: {
    itemMeta: Record<string, ItemMeta>
    activeTurnId: string | null
    workspace: string | null
    duplicateAssistantIds: ReadonlySet<string>
    lastAssistantTextId: string | null
    onSendFlagged: () => void
  }
): React.JSX.Element | null {
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
    return (
      <div key={item.id} className="agent-mini-message is-assistant">
        <AssistantMessage
          text={item.text}
          // Manual escalation targets the latest audit exchange; only its
          // report gets an actionable flag badge.
          onSendFlagged={item.id === context.lastAssistantTextId ? context.onSendFlagged : undefined}
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
  onSendFlagged
}: {
  text: string
  onSendFlagged?: () => void
}): React.JSX.Element {
  const verdict = parseAuditVerdict(text)
  if (!verdict) return <MarkdownContent text={text} />
  const actionable = verdict === 'flag' && onSendFlagged
  return (
    <>
      <MarkdownContent text={stripVerdictLine(text)} />
      {actionable ? (
        <button
          type="button"
          className="agent-audit-verdict is-flag is-actionable"
          title="Send this report to the main chat"
          onClick={onSendFlagged}
        >
          ⚑ flagged · send to main chat
        </button>
      ) : (
        <span className={`agent-audit-verdict is-${verdict}`}>
          {verdict === 'pass' ? '✓ pass' : '⚑ flagged'}
        </span>
      )}
    </>
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

export function SendArrowIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V5M5.5 11.5L12 5l6.5 6.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function NewChatPlusIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function EyeIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function ZoomIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="5.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="m15 15 5 5M8 10.5h5M10.5 8v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

function ChevronDownIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function MinusIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function ExpandIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
