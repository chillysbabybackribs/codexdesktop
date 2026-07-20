import { useLayoutEffect, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import type { ChatAttachment } from '../../shared/ipc'
import type { Model } from '../../shared/session-protocol'
import { AttachmentButton, AttachmentStrip, saveBrowserFiles } from './Attachments'
import { resolveModelProvider, steerComposerPlaceholder } from './app-helpers'
import type { AgentSession } from './agent-session-model'

// The per-agent composer at the bottom of an agent window: autosizing
// textarea, attachment paste/drop, and send/steer/stop/new routing. Draft
// state lives here; the textarea ref stays with AgentWindow so
// click-anywhere-to-type and the selected-window focus keep working.
export function AgentComposer({
  session,
  working,
  models,
  mainModel,
  textareaRef,
  onSend,
  onSteer,
  onStop,
  onResetSession
}: {
  session: AgentSession
  working: boolean
  models: Model[]
  mainModel: string | null
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onSend: (key: string, text: string, attachments?: ChatAttachment[]) => Promise<boolean>
  onSteer: (key: string, text: string) => Promise<boolean>
  onStop: (key: string) => Promise<void>
  onResetSession: (key: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(120, Math.max(34, textarea.scrollHeight))}px`
  }, [value])

  const hasDraft = Boolean(value.trim() || attachments.length)
  const providerId = resolveModelProvider(models, session.model ?? mainModel)

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

  return (
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
          placeholder={
            working
              ? steerComposerPlaceholder(providerId)
              : 'Message this agent…'
          }
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
  )
}

// Lives here (not AgentDock) to avoid an import cycle — AgentDock re-exports
// it so Composer.tsx keeps importing from './AgentDock'.
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
