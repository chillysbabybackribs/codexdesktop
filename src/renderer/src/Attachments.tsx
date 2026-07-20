import { useEffect, useState } from 'react'
import { File, Paperclip, X } from 'lucide-react'
import type { AttachmentSaveInput, ChatAttachment } from '../../shared/ipc'
import type { UserInput } from '../../shared/session-protocol'
import { IconButton } from './UiPrimitives'

export function AttachmentButton({ disabled, onAdd, onError }: { disabled?: boolean; onAdd: (items: ChatAttachment[]) => void; onError?: (message: string) => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <IconButton
      className="attachment-button"
      label="Add images or files"
      tooltip="Attach images or files"
      disabled={disabled || busy}
      onClick={() => {
        setBusy(true)
        void window.api.attachments.pick()
          .then(onAdd)
          .catch((error: unknown) => onError?.(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false))
      }}
    >
      <Paperclip strokeWidth={1.7} aria-hidden="true" />
    </IconButton>
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
      {preview ? removable ? (
        <img src={preview} alt={attachment.name} loading="lazy" />
      ) : (
        <button
          type="button"
          className="attachment-open"
          aria-label={`Open ${attachment.name} in browser`}
          title="Open in browser"
          onClick={() => void window.api.attachments.open({ path: attachment.path })}
        >
          <img src={preview} alt={attachment.name} loading="lazy" />
        </button>
      ) : attachment.kind === 'image' ? (
        <span className="attachment-image-placeholder" aria-hidden="true" />
      ) : (
        <span className="attachment-file-icon" aria-hidden="true"><File strokeWidth={1.5} /></span>
      )}
      <figcaption>{attachment.name}</figcaption>
      {removable ? (
        <IconButton
          className="attachment-remove"
          label={`Remove ${attachment.name}`}
          tooltip="Remove attachment"
          onClick={() => onRemove?.(attachment.id)}
        >
          <X aria-hidden="true" />
        </IconButton>
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
  const attachments: ChatAttachment[] = []
  for (const item of content) {
    if (item.type === 'localImage') {
      const name = displayNameFromPath(item.path)
      attachments.push({ id: item.path, kind: 'image', name, path: item.path, mediaType: 'image/*', size: 0 })
    }
    if (item.type === 'mention') {
      attachments.push({ id: item.path, kind: 'file', name: item.name || displayNameFromPath(item.path), path: item.path, mediaType: 'application/octet-stream', size: 0 })
    }
  }
  return attachments
}

function displayNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? 'attachment'
  return base.replace(/^[0-9a-f-]{36}--/i, '')
}
