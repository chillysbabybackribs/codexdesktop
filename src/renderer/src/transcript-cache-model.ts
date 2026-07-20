import { isResumeEnumeratedId, type SessionRenderState } from './session-store.js'

const CACHE_VERSION = 1

type CachedTranscript = {
  version: number
  savedAt: number
  session: Pick<
    SessionRenderState,
    'threadId' | 'title' | 'turnId' | 'goal' | 'reasoningEffort' | 'items' | 'itemMeta' |
    'turnMeta' | 'contextUsage' | 'isCompacting' | 'activeCompaction'
  >
}

export function serializeTranscriptSession(session: SessionRenderState): CachedTranscript | null {
  if (!session.threadId) return null
  return {
    version: CACHE_VERSION,
    savedAt: Date.now(),
    session: {
      threadId: session.threadId,
      title: session.title,
      turnId: session.turnId,
      goal: session.goal,
      reasoningEffort: session.reasoningEffort,
      items: session.items,
      itemMeta: session.itemMeta,
      turnMeta: session.turnMeta,
      contextUsage: session.contextUsage,
      isCompacting: session.isCompacting,
      activeCompaction: session.activeCompaction
    }
  }
}

export function parseTranscriptSession(value: unknown, threadId: string): Partial<SessionRenderState> | null {
  if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.session)) return null
  const session = value.session
  if (session.threadId !== threadId || !Array.isArray(session.items) || !isRecord(session.itemMeta) || !isRecord(session.turnMeta)) {
    return null
  }
  return {
    threadId,
    title: typeof session.title === 'string' ? session.title : 'New Chat',
    turnId: typeof session.turnId === 'string' ? session.turnId : null,
    goal: isRecord(session.goal) ? session.goal as SessionRenderState['goal'] : null,
    reasoningEffort: typeof session.reasoningEffort === 'string' ? session.reasoningEffort as SessionRenderState['reasoningEffort'] : null,
    items: session.items as SessionRenderState['items'],
    itemMeta: session.itemMeta as SessionRenderState['itemMeta'],
    turnMeta: session.turnMeta as SessionRenderState['turnMeta'],
    contextUsage: isRecord(session.contextUsage) ? session.contextUsage as SessionRenderState['contextUsage'] : null,
    isCompacting: session.isCompacting === true,
    activeCompaction: isRecord(session.activeCompaction) ? session.activeCompaction as SessionRenderState['activeCompaction'] : null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
