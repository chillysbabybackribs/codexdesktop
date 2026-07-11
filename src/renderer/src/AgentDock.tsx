import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type AgentLiteMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

// Lightweight state for a background agent conversation. The focused thread
// keeps the full activity/telemetry pipeline in App; background threads only
// track what the dock renders: plain messages and turn status.
export type AgentSession = {
  key: string
  threadId: string | null
  title: string
  status: 'idle' | 'working' | 'done'
  turnId: string | null
  messages: AgentLiteMessage[]
  // Optional helper mode: when true, each send includes a compact digest of
  // the main chat so the agent can answer questions about it.
  watchesMain: boolean
}

export function AgentTabStrip({
  sessions,
  openKeys,
  onFocus,
  onNewAgent
}: {
  sessions: AgentSession[]
  openKeys: string[]
  onFocus: (key: string) => void
  onNewAgent: () => void
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
      <button
        type="button"
        className="icon-button agent-new-button"
        aria-label="New agent"
        title="New agent"
        onClick={onNewAgent}
      >
        <AgentPlusIcon />
      </button>
    </div>
  )
}

export function AgentColumn({
  sessions,
  onMinimize,
  onCloseSession,
  onPromote,
  onToggleWatch,
  onSend,
  onStop
}: {
  sessions: AgentSession[]
  onMinimize: (key: string) => void
  onCloseSession: (key: string) => void
  onPromote: (key: string) => void
  onToggleWatch: (key: string) => void
  onSend: (key: string, text: string) => Promise<boolean>
  onStop: (key: string) => Promise<void>
}): React.JSX.Element {
  return (
    <div className="agent-column">
      {sessions.map((session) => (
        <AgentWindow
          key={session.key}
          session={session}
          onMinimize={onMinimize}
          onCloseSession={onCloseSession}
          onPromote={onPromote}
          onToggleWatch={onToggleWatch}
          onSend={onSend}
          onStop={onStop}
        />
      ))}
    </div>
  )
}

function AgentWindow({
  session,
  onMinimize,
  onCloseSession,
  onPromote,
  onToggleWatch,
  onSend,
  onStop
}: {
  session: AgentSession
  onMinimize: (key: string) => void
  onCloseSession: (key: string) => void
  onPromote: (key: string) => void
  onToggleWatch: (key: string) => void
  onSend: (key: string, text: string) => Promise<boolean>
  onStop: (key: string) => Promise<void>
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [isSending, setIsSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [session.messages, session.status])

  const working = session.status === 'working'

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = value.trim()
    if (!text || isSending || working) return
    setValue('')
    setIsSending(true)
    try {
      const accepted = await onSend(session.key, text)
      if (!accepted) setValue((current) => (current ? `${text}\n${current}` : text))
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="agent-overlay" data-agent-key={session.key} role="dialog" aria-label={`Agent: ${session.title}`}>
      <div className="agent-overlay-header">
        <AgentStatusIcon status={session.status} />
        <span className="agent-overlay-title">{session.title}</span>
        <div className="agent-overlay-actions">
          <button
            type="button"
            className={`icon-button agent-watch-toggle ${session.watchesMain ? 'is-active' : ''}`}
            aria-label={session.watchesMain ? 'Stop sharing main-chat context' : 'Share main-chat context'}
            aria-pressed={session.watchesMain}
            title={
              session.watchesMain
                ? 'Helper mode on: sends recent main-chat context with each message'
                : 'Helper mode off: independent agent'
            }
            onClick={() => onToggleWatch(session.key)}
          >
            <EyeIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Focus in main chat"
            title="Focus in main chat (current chat moves to a tab)"
            disabled={!session.threadId}
            onClick={() => onPromote(session.key)}
          >
            <ExpandIcon />
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
            title="Close agent (unsubscribes the thread)"
            onClick={() => onCloseSession(session.key)}
          >
            ×
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="agent-overlay-scroll">
        {session.messages.length === 0 ? (
          <div className="agent-overlay-empty">
            An independent agent with its own conversation, running in parallel and sharing the
            workspace. Toggle the eye to let it see recent main-chat context.
          </div>
        ) : (
          session.messages.map((message) => (
            <div key={message.id} className={`agent-mini-message is-${message.role}`}>
              {message.role === 'assistant' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
              ) : (
                message.text
              )}
            </div>
          ))
        )}
        {working ? <div className="agent-overlay-working shimmer-text">Working…</div> : null}
      </div>

      <form className="agent-overlay-composer" onSubmit={handleSubmit}>
        <textarea
          value={value}
          rows={1}
          placeholder={working ? 'Agent is working…' : 'Message this agent…'}
          disabled={isSending}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        {working ? (
          <button
            type="button"
            className="agent-stop-button"
            aria-label="Stop agent turn"
            title="Stop"
            onClick={() => void onStop(session.key)}
          >
            <span className="agent-stop-square" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            className="send-button"
            aria-label="Send to agent"
            disabled={isSending || !value.trim()}
          >
            ↑
          </button>
        )}
      </form>
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

function AgentPlusIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="6.5" width="13" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.5 11h5M10 8.5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M17.5 4.5v5M15 7h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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
