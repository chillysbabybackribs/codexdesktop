import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ModelPill } from './ModelPill'
import type { Model } from '../../shared/codex-protocol/v2/Model'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort'
import type { ThreadTokenUsage } from '../../shared/codex-protocol/v2/ThreadTokenUsage'
import type { ChatAttachment } from '../../shared/ipc'
import { AttachmentButton, AttachmentStrip, saveBrowserFiles } from './Attachments'
import type { AgentSession } from './agent-session-model'
import { browserLinkComponents } from './MarkdownContent'

import { writeConversationDragTarget } from './ConversationLayout'
import type { ConversationTarget } from './conversation-layout'

export type { AgentLiteMessage, AgentSession } from './agent-session-model'

export function ConversationTabStrip({
  sessions,
  focusedTarget,
  visibleTargets,
  mainWorking,
  onSelectMain,
  onSelectAgent,
  onNewAgent,
  onCloseAgent,
  onTabDragStart,
  onTabDragEnd
}: {
  sessions: AgentSession[]
  focusedTarget: ConversationTarget
  visibleTargets: ConversationTarget[]
  mainWorking: boolean
  onSelectMain: () => void
  onSelectAgent: (key: string) => void
  onNewAgent: () => void
  onCloseAgent: (key: string) => void
  onTabDragStart: (target: ConversationTarget) => void
  onTabDragEnd: () => void
}): React.JSX.Element {
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const selectedId = focusedTarget === 'main' ? 'main' : focusedTarget
  const visible = new Set(visibleTargets)

  useEffect(() => {
    tabRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedId, sessions.length])

  const startTabDrag = (event: React.DragEvent<HTMLDivElement>, target: ConversationTarget): void => {
    writeConversationDragTarget(event.dataTransfer, target)
    onTabDragStart(target)
    event.currentTarget.classList.add('is-dragging')
  }

  const endTabDrag = (event: React.DragEvent<HTMLDivElement>): void => {
    event.currentTarget.classList.remove('is-dragging')
    onTabDragEnd()
  }

  const selectByKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, currentId: string): void => {
    const ids = ['main', ...sessions.map((session) => session.key)]
    const currentIndex = Math.max(0, ids.indexOf(currentId))
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % ids.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + ids.length) % ids.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = ids.length - 1
    else return

    event.preventDefault()
    const nextId = ids[nextIndex]
    if (nextId === 'main') onSelectMain()
    else onSelectAgent(nextId)
    requestAnimationFrame(() => tabRefs.current.get(nextId)?.focus())
  }

  const registerTab = (id: string, node: HTMLButtonElement | null): void => {
    if (node) tabRefs.current.set(id, node)
    else tabRefs.current.delete(id)
  }

  return (
    <div className="conversation-tabs" role="tablist" aria-label="Conversations">
      <div className={`conversation-tab-item is-main ${focusedTarget === 'main' ? 'is-active' : ''} ${visible.has('main') ? 'is-visible' : ''}`}>
        <div
          className="conversation-tab-drag"
          draggable
          onDragStart={(event) => startTabDrag(event, 'main')}
          onDragEnd={endTabDrag}
        >
          <button
            type="button"
            ref={(node) => registerTab('main', node)}
            id="conversation-tab-main"
            className="conversation-tab"
            role="tab"
            aria-selected={focusedTarget === 'main'}
            aria-controls="conversation-panel-main"
            tabIndex={focusedTarget === 'main' ? 0 : -1}
            title="Main chat — drag into the chat area to tile"
            onClick={onSelectMain}
            onKeyDown={(event) => selectByKeyboard(event, 'main')}
          >
            {mainWorking ? <span className="agent-status agent-status-spinner" role="status" aria-label="Working" /> : <MainChatIcon />}
            <span className="conversation-tab-title">Main chat</span>
          </button>
        </div>
      </div>
      <div className="conversation-agent-tabs">
        {sessions.map((session) => {
          const active = focusedTarget === session.key
          return (
            <div className={`conversation-tab-item ${active ? 'is-active' : ''} ${visible.has(session.key) ? 'is-visible' : ''}`} key={session.key}>
              <div
                className="conversation-tab-drag"
                draggable
                onDragStart={(event) => startTabDrag(event, session.key)}
                onDragEnd={endTabDrag}
              >
                <button
                  type="button"
                  ref={(node) => registerTab(session.key, node)}
                  id={`conversation-tab-${session.key}`}
                  className="conversation-tab"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`conversation-panel-${session.key}`}
                  tabIndex={active ? 0 : -1}
                  title={`${session.title} — drag into the chat area to tile`}
                  onClick={() => onSelectAgent(session.key)}
                  onKeyDown={(event) => selectByKeyboard(event, session.key)}
                >
                  <AgentStatusIcon status={session.status} />
                  <span className="conversation-tab-title">{session.title}</span>
                </button>
              </div>
              <button
                type="button"
                className="conversation-tab-close"
                aria-label={`Close ${session.title}`}
                title="Close agent"
                onClick={() => onCloseAgent(session.key)}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="conversation-new-agent"
        aria-label="New agent"
        title="New agent"
        onClick={onNewAgent}
      >
        <AgentPlusIcon />
      </button>
    </div>
  )
}

export function AgentConversationPanel({
  session,
  active,
  models,
  secondaryModels,
  primaryLabel,
  secondaryLabel,
  onSelectSecondaryModel,
  onRequestSecondaryModels,
  mainModel,
  mainReasoningEffort,
  onSetModel,
  onSetModelEffort,
  onCloseSession,
  onResetSession,
  onPromote,
  onToggleWatch,
  onSend,
  onSteer,
  onStop,
  onCompact
}: {
  session: AgentSession
  active: boolean
  models: Model[]
  // The other provider's catalog; picking from it re-homes this agent tab.
  secondaryModels?: Model[]
  primaryLabel?: string
  secondaryLabel?: string
  onSelectSecondaryModel?: (key: string, model: string) => void
  onRequestSecondaryModels?: () => void
  mainModel: string | null
  mainReasoningEffort: ReasoningEffort | null
  onSetModel: (key: string, model: string) => void
  onSetModelEffort: (key: string, model: string, effort: ReasoningEffort) => void
  onCloseSession: (key: string) => void
  onResetSession: (key: string) => void
  onPromote: (key: string) => void
  onToggleWatch: (key: string) => void
  onSend: (key: string, text: string, attachments?: ChatAttachment[]) => Promise<boolean>
  onSteer: (key: string, text: string) => Promise<boolean>
  onStop: (key: string) => Promise<void>
  onCompact: (key: string) => Promise<void>
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [session.messages, session.status])

  // Selected conversations come up text-ready without losing drafts when the
  // user switches away and back; every panel remains mounted.
  useEffect(() => {
    if (active) textareaRef.current?.focus()
  }, [active])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(120, Math.max(34, textarea.scrollHeight))}px`
  }, [value])

  const working = session.status === 'working'
  const hasDraft = Boolean(value.trim() || attachments.length)

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
  const handleWindowClick = (event: React.MouseEvent<HTMLElement>): void => {
    const target = event.target
    if (target instanceof HTMLElement && target.closest('button, textarea, input, a')) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    textareaRef.current?.focus()
  }

  return (
    <section
      className="agent-conversation-panel"
      data-agent-key={session.key}
      id={`conversation-panel-${session.key}`}
      role="tabpanel"
      aria-labelledby={`conversation-tab-${session.key}`}
      onClick={handleWindowClick}
    >
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
            aria-label="Open in main chat"
            title="Open in main chat (current chat is saved to history)"
            onClick={() => onPromote(session.key)}
          >
            <ExpandIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close agent"
            title="Close agent (stops the turn and unsubscribes the thread)"
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
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={browserLinkComponents}>{message.text}</ReactMarkdown>
              ) : (
                <>{message.text ? <span>{message.text}</span> : null}<AttachmentStrip attachments={message.attachments ?? []} compact /></>
              )}
            </div>
          ))
        )}
        {working ? <div className="agent-overlay-working shimmer-text">Working…</div> : null}
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
              primaryLabel={primaryLabel}
              secondaryLabel={secondaryLabel}
              secondaryModels={secondaryModels}
              onSelectSecondaryModel={
                onSelectSecondaryModel
                  ? (model) => onSelectSecondaryModel(session.key, model)
                  : undefined
              }
              onOpen={onRequestSecondaryModels}
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
    </section>
  )
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

function MainChatIcon(): React.JSX.Element {
  return (
    <svg className="conversation-main-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5.5 6.5h13v9h-7l-4.5 3v-3H5.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
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

function AgentPlusIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="6.5" width="13" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.5 11h5M10 8.5v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M17.5 4.5v5M15 7h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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
