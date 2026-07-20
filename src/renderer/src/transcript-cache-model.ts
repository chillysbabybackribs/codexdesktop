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
  const itemMeta = session.itemMeta as SessionRenderState['itemMeta']
  return {
    threadId,
    title: typeof session.title === 'string' ? session.title : 'New Chat',
    turnId: typeof session.turnId === 'string' ? session.turnId : null,
    goal: isRecord(session.goal) ? session.goal as SessionRenderState['goal'] : null,
    reasoningEffort: typeof session.reasoningEffort === 'string' ? session.reasoningEffort as SessionRenderState['reasoningEffort'] : null,
    items: healMixedIdFamilies(session.items as SessionRenderState['items'], itemMeta),
    itemMeta,
    turnMeta: session.turnMeta as SessionRenderState['turnMeta'],
    contextUsage: isRecord(session.contextUsage) ? session.contextUsage as SessionRenderState['contextUsage'] : null,
    isCompacting: session.isCompacting === true,
    activeCompaction: isRecord(session.activeCompaction) ? session.activeCompaction as SessionRenderState['activeCompaction'] : null
  }
}

// Snapshots written before the one-source-per-turn fix can hold the same turn
// under both id families: the live stream's stable ids plus the resume page's
// re-enumerated item-N ids — every row doubled. Heal on load: in a mixed turn
// the live family wins, except a live user message with empty content adopts
// the text of the enumerated copy it displaces (the resume copy was the one
// that carried the words).
function healMixedIdFamilies(
  items: SessionRenderState['items'],
  itemMeta: SessionRenderState['itemMeta']
): SessionRenderState['items'] {
  const turnsWithLiveIds = new Set<string>()
  const turnsWithEnumeratedIds = new Set<string>()
  for (const item of items) {
    if (item.type === 'system' || item.type === 'turnPlan') continue
    const turnId = itemMeta[item.id]?.turnId
    if (!turnId) continue
    ;(isResumeEnumeratedId(item.id) ? turnsWithEnumeratedIds : turnsWithLiveIds).add(turnId)
  }
  const mixedTurns = [...turnsWithEnumeratedIds].filter((turnId) => turnsWithLiveIds.has(turnId))
  if (mixedTurns.length === 0) return items
  const mixed = new Set(mixedTurns)

  const displacedUserTextByTurn = new Map<string, unknown>()
  for (const item of items) {
    if (item.type !== 'userMessage' || !isResumeEnumeratedId(item.id)) continue
    const turnId = itemMeta[item.id]?.turnId
    if (turnId && mixed.has(turnId)) displacedUserTextByTurn.set(turnId, item.content)
  }

  return items
    .filter((item) => {
      if (item.type === 'system' || item.type === 'turnPlan') return true
      if (!isResumeEnumeratedId(item.id)) return true
      const turnId = itemMeta[item.id]?.turnId
      return !turnId || !mixed.has(turnId)
    })
    .map((item) => {
      if (item.type !== 'userMessage' || isResumeEnumeratedId(item.id)) return item
      const turnId = itemMeta[item.id]?.turnId
      const displaced = turnId ? displacedUserTextByTurn.get(turnId) : undefined
      const content = (item as { content?: unknown[] }).content
      const isEmpty = !Array.isArray(content) || content.length === 0 ||
        content.every((entry) => isRecord(entry) && entry.type === 'text' && !entry.text)
      return displaced !== undefined && isEmpty ? { ...item, content: displaced } as typeof item : item
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
