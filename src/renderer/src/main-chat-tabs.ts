export type MainChatTabStatus = 'idle' | 'working' | 'attention'

export const maxMainChatTabs = 12

export type MainChatTab = {
  key: string
  threadId: string | null
  title: string
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
}

type PersistedMainChatTabState = {
  activeKey?: unknown
  tabs?: unknown
}

export function createMainChatTab(
  key: string,
  threadId: string | null = null,
  title = 'New Chat'
): MainChatTab {
  return { key, threadId, title, status: 'idle', turnId: null }
}

export function parseMainChatTabState(
  raw: string | null,
  legacyThreadId: string | null,
  createKey: () => string
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
        return [createMainChatTab(key, threadId, title)]
      }).slice(0, maxMainChatTabs)
    : []

  if (!tabs.length) {
    tabs.push(createMainChatTab(createKey(), legacyThreadId))
  } else if (legacyThreadId && !seenThreads.has(legacyThreadId)) {
    // Preserve the pre-tabs last-thread preference during the migration.
    tabs[0] = createMainChatTab(tabs[0].key, legacyThreadId, tabs[0].title)
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
    tabs: state.tabs.map(({ key, threadId, title }) => ({ key, threadId, title }))
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
    const replacement = createMainChatTab(createKey())
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
