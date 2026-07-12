import type { MemoryStore } from './memory-store.js'
import { shouldAttachPriorChatMemory } from './codex/codex-config.js'

const openingTag = '<codexdesktop-prior-chat-memory>'
const closingTag = '</codexdesktop-prior-chat-memory>'

export type PrepareOpeningTextRequest = {
  requestText: string
  visibleText: string
  workspace: string | null
  isNewSession: boolean
}

export class ConversationMemoryService {
  constructor(private readonly store: MemoryStore) {}

  async prepareOpeningText(request: PrepareOpeningTextRequest): Promise<string> {
    if (!request.isNewSession || !shouldAttachPriorChatMemory(request.requestText)) {
      return request.visibleText
    }

    const checkpoint = await this.store.readWorkspaceCheckpoint(request.workspace)
    if (!checkpoint?.trim()) return request.visibleText

    return [
      openingTag,
      escapeSentinels(checkpoint.trim()),
      closingTag,
      '',
      'Current user request:',
      request.visibleText
    ].join('\n')
  }
}

function escapeSentinels(value: string): string {
  return value
    .replaceAll(openingTag, '&lt;codexdesktop-prior-chat-memory&gt;')
    .replaceAll(closingTag, '&lt;/codexdesktop-prior-chat-memory&gt;')
}
