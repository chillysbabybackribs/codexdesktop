import { useEffect, useRef, useState } from 'react'
import type { AgentSession } from './agent-session-model'
import { ChevronDownIcon } from './agent-row-render'

// The window title button and its dropdown: watch/audit/report toggles,
// promote to main chat, and the chat-zoom controls. Open state and the
// outside-click/Escape closing live here; zoom state stays with AgentWindow
// (the transcript content scales by it too) and arrives as props.
export function AgentWindowMenu({
  session,
  zoomPercent,
  adjustZoom,
  onToggleWatch,
  onToggleAudit,
  onToggleReport,
  onPromote
}: {
  session: AgentSession
  zoomPercent: number
  adjustZoom: (direction: 'in' | 'out' | 'reset') => void
  onToggleWatch: (key: string) => void
  onToggleAudit: (key: string) => void
  onToggleReport: (key: string) => void
  onPromote: (key: string) => void
}): React.JSX.Element {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

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

  return (
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
                      : 'Second viewpoint on every turn · picks a second provider'}
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
