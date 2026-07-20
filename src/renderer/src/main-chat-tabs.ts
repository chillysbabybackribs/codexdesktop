export type MainChatTabStatus = 'idle' | 'working' | 'attention'

export type BrowserMiddleSide = 'left' | 'right'

export const maxMainChatTabs = 12

export type MainChatTab = {
  key: string
  threadId: string | null
  title: string
  // Composer choices belong to the conversation, not the window. Keeping
  // these on the tab lets several main chats run with different models.
  model: string | null
  reasoningEffort: string | null
  // Browser-centered workspaces own two independent tab collections. The
  // assignment is ignored in the regular chat/browser layout, but persists so
  // a chat always returns to the side where it was created.
  browserMiddleSide: BrowserMiddleSide | null
  status: MainChatTabStatus
  turnId: string | null
}

export type MainChatTabState = {
  tabs: MainChatTab[]
  activeKey: string
}

export type MainChatTabDropCandidate = {
  key: string
  left: number
  right: number
}

type PersistedMainChatTab = {
  key?: unknown
  threadId?: unknown
  title?: unknown
  model?: unknown
  reasoningEffort?: unknown
  browserMiddleSide?: unknown
}

type PersistedMainChatTabState = {
  activeKey?: unknown
  tabs?: unknown
}

export function createMainChatTab(
  key: string,
  threadId: string | null = null,
  title = 'New Chat',
  model: string | null = null,
  reasoningEffort: string | null = null,
  browserMiddleSide: BrowserMiddleSide | null = null,
): MainChatTab {
  return { key, threadId, title, model, reasoningEffort, browserMiddleSide, status: 'idle', turnId: null }
}

export function parseMainChatTabState(
  raw: string | null,
  legacyThreadId: string | null,
  createKey: () => string,
  legacySelection: { model: string | null; reasoningEffort: string | null } = {
    model: null,
    reasoningEffort: null
  }
): MainChatTabState {
  let parsed: PersistedMainChatTabState | null = null
  try {
    const value: unknown = raw ? JSON.parse(raw) : null
    if (value && typeof value === 'object') parsed = value as PersistedMainChatTabState
  } catch {
    parsed = null
  }

  const seenThreads = new Set<string>()
  const tabs = Array.isArray(parsed?.tabs)
    ? parsed.tabs.flatMap((value): MainChatTab[] => {
        if (!value || typeof value !== 'object') return []
        const candidate = value as PersistedMainChatTab
        const key = typeof candidate.key === 'string' && candidate.key ? candidate.key : createKey()
        const threadId = typeof candidate.threadId === 'string' && candidate.threadId
          ? candidate.threadId
          : null
        if (threadId && seenThreads.has(threadId)) return []
        if (threadId) seenThreads.add(threadId)
        const title = typeof candidate.title === 'string' && candidate.title.trim()
          ? candidate.title.trim()
          : 'New Chat'
        const model = typeof candidate.model === 'string' && candidate.model
          ? candidate.model
          : legacySelection.model
        const reasoningEffort = typeof candidate.reasoningEffort === 'string' && candidate.reasoningEffort
          ? candidate.reasoningEffort
          : legacySelection.reasoningEffort
        const browserMiddleSide =
          candidate.browserMiddleSide === 'left' || candidate.browserMiddleSide === 'right'
            ? candidate.browserMiddleSide
            : null
        return [createMainChatTab(key, threadId, title, model, reasoningEffort, browserMiddleSide)]
      }).slice(0, maxMainChatTabs)
    : []

  if (!tabs.length) {
    tabs.push(createMainChatTab(
      createKey(),
      legacyThreadId,
      'New Chat',
      legacySelection.model,
      legacySelection.reasoningEffort
    ))
  } else if (legacyThreadId && !seenThreads.has(legacyThreadId)) {
    // Preserve the pre-tabs last-thread preference during the migration.
    tabs[0] = createMainChatTab(
      tabs[0].key,
      legacyThreadId,
      tabs[0].title,
      tabs[0].model,
      tabs[0].reasoningEffort
    )
  }

  const requestedActiveKey = typeof parsed?.activeKey === 'string' ? parsed.activeKey : null
  const activeKey = tabs.some((tab) => tab.key === requestedActiveKey)
    ? requestedActiveKey!
    : tabs[0].key

  return { tabs, activeKey }
}

export function serializeMainChatTabState(state: MainChatTabState): string {
  return JSON.stringify({
    activeKey: state.activeKey,
    tabs: state.tabs.map(({ key, threadId, title, model, reasoningEffort, browserMiddleSide }) => ({
      key,
      threadId,
      title,
      model,
      reasoningEffort,
      browserMiddleSide
    }))
  })
}

export function closeMainChatTab(
  state: MainChatTabState,
  key: string,
  createKey: () => string
): MainChatTabState {
  const index = state.tabs.findIndex((tab) => tab.key === key)
  if (index === -1) return state

  if (state.tabs.length === 1) {
    const previous = state.tabs[0]
    const replacement = createMainChatTab(
      createKey(),
      null,
      'New Chat',
      previous.model,
      previous.reasoningEffort,
      previous.browserMiddleSide,
    )
    return { tabs: [replacement], activeKey: replacement.key }
  }

  const tabs = state.tabs.filter((tab) => tab.key !== key)
  if (state.activeKey !== key) return { tabs, activeKey: state.activeKey }
  const next = tabs[Math.min(index, tabs.length - 1)]
  return { tabs, activeKey: next.key }
}

export function reorderMainChatTabs(
  state: MainChatTabState,
  sourceKey: string,
  targetKey: string,
  placement: 'before' | 'after'
): MainChatTabState {
  if (sourceKey === targetKey) return state

  const source = state.tabs.find((tab) => tab.key === sourceKey)
  if (!source || !state.tabs.some((tab) => tab.key === targetKey)) return state

  const withoutSource = state.tabs.filter((tab) => tab.key !== sourceKey)
  const targetIndex = withoutSource.findIndex((tab) => tab.key === targetKey)
  const insertAt = placement === 'before' ? targetIndex : targetIndex + 1
  const tabs = [
    ...withoutSource.slice(0, insertAt),
    source,
    ...withoutSource.slice(insertAt)
  ]

  return { ...state, tabs }
}

export function findMainChatTabDropTarget(
  sourceKey: string,
  sourceLeft: number,
  previewLeft: number,
  previewWidth: number,
  candidates: MainChatTabDropCandidate[],
  overlapRatio = 0.1
): { key: string; placement: 'before' | 'after' } | null {
  const previewRight = previewLeft + previewWidth
  const minimumOverlap = previewWidth * overlapRatio
  const previewCenter = previewLeft + previewWidth / 2

  const target = candidates
    .filter((candidate) => candidate.key !== sourceKey)
    .map((candidate) => ({
      candidate,
      overlap: Math.max(0, Math.min(previewRight, candidate.right) - Math.max(previewLeft, candidate.left))
    }))
    .filter(({ overlap }) => overlap >= minimumOverlap)
    .sort((first, second) => (
      second.overlap - first.overlap ||
      Math.abs((first.candidate.left + first.candidate.right) / 2 - previewCenter) -
        Math.abs((second.candidate.left + second.candidate.right) / 2 - previewCenter)
    ))[0]?.candidate

  if (!target) return null
  return {
    key: target.key,
    placement: previewLeft > sourceLeft ? 'after' : 'before'
  }
}

export function tabForThread(tabs: MainChatTab[], threadId: string): MainChatTab | null {
  return tabs.find((tab) => tab.threadId === threadId) ?? null
}

/**
 * Open tabs remain subscribed and their in-memory sessions receive every live
 * notification. Rehydrating a cached tab from bounded thread history can erase
 * newer reasoning, commentary, and tool-call state, so only uncached
 * thread-backed tabs need a server resume. "Cached" means the stored session
 * holds THIS tab's thread — an auto-created empty session (threadId null) or a
 * session left over from a different thread does not count.
 */
export function needsMainChatTabHydration(
  tab: MainChatTab,
  cachedThreadId: string | null | undefined
): tab is MainChatTab & { threadId: string } {
  return Boolean(tab.threadId && cachedThreadId !== tab.threadId)
}
