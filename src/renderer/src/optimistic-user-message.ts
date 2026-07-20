import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem'
import type { UserInput } from '../../shared/codex-protocol/v2/UserInput'
import type { ChatAttachment } from '../../shared/ipc'
import type { ChatItem } from './transcript-model.js'

export function buildOptimisticUserMessage(
  id: string,
  text: string,
  attachments: ChatAttachment[]
): Extract<ThreadItem, { type: 'userMessage' }> {
  const content: UserInput[] = [
    ...(text ? [{ type: 'text', text, text_elements: [] } satisfies UserInput] : []),
    ...attachments.map((attachment): UserInput => attachment.kind === 'image'
      ? { type: 'localImage', path: attachment.path, detail: 'high' }
      : { type: 'mention', name: attachment.name, path: attachment.path })
  ]

  return { type: 'userMessage', id, clientId: null, content }
}

export function hasAuthoritativeUserMessage(items: ThreadItem[]): boolean {
  return items.some((item) => item.type === 'userMessage')
}

export function stripOptimisticUserMessage(
  items: ChatItem[],
  optimisticId: string | null,
  incoming: ThreadItem[]
): ChatItem[] {
  if (!optimisticId || !hasAuthoritativeUserMessage(incoming)) return items
  return items.filter((item) => item.id !== optimisticId)
}
