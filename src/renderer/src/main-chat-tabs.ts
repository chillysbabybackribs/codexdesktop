export type MainChatTabStatus = 'idle' | 'working' | 'attention'

export const maxMainChatTabs = 12

export type MainChatTab = {
  key: string
  threadId: string | null
  title: string
  // Composer choices belong to the conversation, not the window. Keeping
  // these on the tab lets several main chats run with different models.
  model: string | null
  reasoningEffort: string | null
  status: MainChatTabStatus
  turnId: string | null
}

export type MainChatTabState = {
  tabs: MainChatTab[]
  activeKey: string
}

type PersistedMainChatTab = {
  key?: unknown
  threadId?: unknown
  title?: unknown
  model?: unknown
  reasoningEffort?: unknown
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
  reasoningEffort: string | null = null
): MainChatTab {
  return { key, threadId, title, model, reasoningEffort, status: 'idle', turnId: null }
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
        return [createMainChatTab(key, threadId, title, model, reasoningEffort)]
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
    tabs: state.tabs.map(({ key, threadId, title, model, reasoningEffort }) => ({
      key,
      threadId,
      title,
      model,
      reasoningEffort
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
      previous.reasoningEffort
    )
    return { tabs: [replacement], activeKey: replacement.key }
  }

  const tabs = state.tabs.filter((tab) => tab.key !== key)
  if (state.activeKey !== key) return { tabs, activeKey: state.activeKey }
  const next = tabs[Math.min(index, tabs.length - 1)]
  return { tabs, activeKey: next.key }
}

export function tabForThread(tabs: MainChatTab[], threadId: string): MainChatTab | null {
  return tabs.find((tab) => tab.threadId === threadId) ?? null
}

/**
 * Open tabs remain subscribed and their in-memory snapshots receive every live
 * notification. Rehydrating a cached tab from bounded thread history can erase
 * newer reasoning, commentary, and tool-call state, so only uncached
 * thread-backed tabs need a server resume.
 */
export function needsMainChatTabHydration(
  tab: MainChatTab,
  snapshotAvailable: boolean
): tab is MainChatTab & { threadId: string } {
  return Boolean(tab.threadId && !snapshotAvailable)
}
