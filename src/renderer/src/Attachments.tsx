import { useEffect, useState } from 'react'
import type { AttachmentSaveInput, ChatAttachment } from '../../shared/ipc'
import type { UserInput } from '../../shared/codex-protocol/v2/UserInput'

export function AttachmentButton({ disabled, onAdd, onError }: { disabled?: boolean; onAdd: (items: ChatAttachment[]) => void; onError?: (message: string) => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="attachment-button"
      aria-label="Add images or files"
      title="Add images or files"
      disabled={disabled || busy}
      onClick={() => {
        setBusy(true)
        void window.api.attachments.pick()
          .then(onAdd)
          .catch((error: unknown) => onError?.(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false))
      }}
    >
      <PaperclipIcon />
    </button>
  )
}

export function AttachmentStrip({
  attachments,
  removable = false,
  compact = false,
  onRemove
}: {
  attachments: ChatAttachment[]
  removable?: boolean
  compact?: boolean
  onRemove?: (id: string) => void
}): React.JSX.Element | null {
  if (!attachments.length) return null
  return (
    <div className={`attachment-strip ${compact ? 'is-compact' : ''}`} aria-label="Attachments">
      {attachments.map((attachment) => (
        <AttachmentItem key={attachment.id} attachment={attachment} removable={removable} onRemove={onRemove} />
      ))}
    </div>
  )
}

function AttachmentItem({ attachment, removable, onRemove }: {
  attachment: ChatAttachment
  removable: boolean
  onRemove?: (id: string) => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    if (attachment.kind === 'image') {
      void window.api.attachments.preview({ path: attachment.path }).then((result) => {
        if (active) setPreview(result.dataUrl)
      })
    }
    return () => { active = false }
  }, [attachment.kind, attachment.path])

  return (
    <figure className={`attachment-item is-${attachment.kind}`} title={attachment.name}>
      {preview ? (
        <img src={preview} alt={attachment.name} loading="lazy" />
      ) : attachment.kind === 'image' ? (
        <span className="attachment-image-placeholder" aria-hidden="true" />
      ) : (
        <span className="attachment-file-icon" aria-hidden="true"><FileIcon /></span>
      )}
      <figcaption>{attachment.name}</figcaption>
      {removable ? (
        <button
          type="button"
          className="attachment-remove"
          aria-label={`Remove ${attachment.name}`}
          title="Remove"
          onClick={() => onRemove?.(attachment.id)}
        >×</button>
      ) : null}
    </figure>
  )
}

export async function saveBrowserFiles(files: File[]): Promise<ChatAttachment[]> {
  const inputs: AttachmentSaveInput[] = await Promise.all(files.map(async (file) => ({
    name: file.name || `pasted-image-${Date.now()}.png`,
    mediaType: file.type || 'application/octet-stream',
    data: new Uint8Array(await file.arrayBuffer())
  })))
  return window.api.attachments.save(inputs)
}

export function attachmentsFromUserInput(content: UserInput[]): ChatAttachment[] {
  return content.flatMap((item) => {
    if (item.type === 'localImage') {
      const name = displayNameFromPath(item.path)
      return [{ id: item.path, kind: 'image' as const, name, path: item.path, mediaType: 'image/*', size: 0 }]
    }
    if (item.type === 'mention') {
      return [{ id: item.path, kind: 'file' as const, name: item.name || displayNameFromPath(item.path), path: item.path, mediaType: 'application/octet-stream', size: 0 }]
    }
    return []
  })
}

function displayNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? 'attachment'
  return base.replace(/^[0-9a-f-]{36}--/i, '')
}

function PaperclipIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 12.5 6.25-6.25a3 3 0 0 1 4.25 4.25l-8.1 8.1a5 5 0 0 1-7.08-7.07l8.1-8.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function FileIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24"><path d="M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
}
