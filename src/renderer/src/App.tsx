import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import ReactMarkdown from 'react-markdown'
import type {
  BrowserBounds,
  BrowserState,
  BrowserTabState,
  CodexEvent
} from '../../shared/ipc'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification'
import type { FileUpdateChange } from '../../shared/codex-protocol/v2/FileUpdateChange'
import type { Thread } from '../../shared/codex-protocol/v2/Thread'
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem'
import { summarizeTurnDiff } from './diff'
import {
  TurnTail,
  WorkGroup,
  workItemTypes,
  type ItemMeta,
  type TurnMeta,
  type TurnPlanItem,
  type WorkItem
} from './TaskActivity'

type SystemItem = {
  type: 'system'
  id: string
  level: 'info' | 'warning' | 'error'
  text: string
}

type ChatItem = ThreadItem | SystemItem | TurnPlanItem

// Item types that represent Codex "working" — its streamed thinking, tool
// calls, file edits, and searches. These render sequentially as WorkGroup
// blocks in the transcript and stay expanded after the turn completes; user
// and assistant messages (and system notices) render as normal chat.
const workTypes = new Set<string>(workItemTypes)

function isWorkItem(item: ChatItem): item is WorkItem {
  return workTypes.has(item.type)
}

// The transcript renders as a flat sequence of rows: chat messages, groups of
// consecutive work blocks, and one "tail" per turn — the live shimmer status
// while the turn runs, then a permanent receipt row once it finishes. Nothing
// auto-collapses.
type RenderRow =
  | { kind: 'chat'; item: ChatItem; turnId: string | null }
  | { kind: 'work'; id: string; turnId: string | null; items: WorkItem[] }
  | { kind: 'tail'; id: string; turnId: string }

function buildRows(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  activeTurnId: string | null
): { rows: RenderRow[]; turnWork: Map<string, WorkItem[]> } {
  const rows: RenderRow[] = []
  const turnWork = new Map<string, WorkItem[]>()
  const lastWorkRowIndex = new Map<string, number>()
  let run: WorkItem[] | null = null
  let runTurnId: string | null = null

  const flush = (): void => {
    if (run && run.length) {
      rows.push({ kind: 'work', id: `work-${run[0].id}`, turnId: runTurnId, items: run })
      if (runTurnId) {
        lastWorkRowIndex.set(runTurnId, rows.length - 1)
      }
    }
    run = null
    runTurnId = null
  }

  for (const item of items) {
    const turnId = item.type === 'system' ? null : (itemMeta[item.id]?.turnId ?? null)

    if (isWorkItem(item)) {
      if (run && runTurnId !== turnId) {
        flush()
      }
      run ??= []
      runTurnId = turnId
      run.push(item)
      if (turnId) {
        const bucket = turnWork.get(turnId) ?? []
        bucket.push(item)
        turnWork.set(turnId, bucket)
      }
      continue
    }

    flush()
    rows.push({ kind: 'chat', item, turnId })
  }

  flush()

  // Close each finished turn's work section with its receipt row. The live
  // turn instead gets a single tail at the very end of the transcript.
  const inserts: Array<{ index: number; row: RenderRow }> = []
  for (const [turnId, index] of lastWorkRowIndex) {
    if (turnId !== activeTurnId) {
      inserts.push({ index, row: { kind: 'tail', id: `tail-${turnId}`, turnId } })
    }
  }
  inserts.sort((a, b) => b.index - a.index)
  for (const insert of inserts) {
    rows.splice(insert.index + 1, 0, insert.row)
  }

  if (activeTurnId) {
    rows.push({ kind: 'tail', id: `tail-${activeTurnId}`, turnId: activeTurnId })
  }

  return { rows, turnWork }
}

const minChatWidth = 280
const minBrowserWidth = 420
const dividerWidth = 8

export default function App(): JSX.Element {
  const [split, setSplit] = useState(() => {
    const stored = Number(window.localStorage.getItem('codexdesktop.split'))
    return Number.isFinite(stored) && stored > 20 && stored < 70 ? stored : 37
  })
  const [items, setItems] = useState<ChatItem[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [activeThreadTitle, setActiveThreadTitle] = useState('New Chat')
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [codexStatus, setCodexStatus] = useState('idle')
  const [threads, setThreads] = useState<Thread[]>([])
  const [workspace, setWorkspace] = useState<string | null>(
    () => window.localStorage.getItem('codexdesktop.workspace')
  )
  const [isThreadMenuOpen, setIsThreadMenuOpen] = useState(false)
  const [browserState, setBrowserState] = useState<BrowserState>({ tabs: [], activeTabId: null })
  const [viewBounds, setViewBounds] = useState<BrowserBounds | null>(null)
  // Lifecycle data the item payloads don't carry: which turn an item belongs
  // to, start/completion timestamps, MCP progress. Keyed by item id.
  const [itemMeta, setItemMeta] = useState<Record<string, ItemMeta>>({})
  // Per-turn status, timing, token usage, and diff stats for the tail rows.
  const [turnMeta, setTurnMeta] = useState<Record<string, TurnMeta>>({})
  const appRef = useRef<HTMLDivElement | null>(null)
  const viewHostRef = useRef<HTMLDivElement | null>(null)
  const pendingBoundsRef = useRef<BrowserBounds | null>(null)
  const rafRef = useRef<number | null>(null)
  const isDraggingDividerRef = useRef(false)
  const splitRef = useRef(split)
  const activeThreadIdRef = useRef<string | null>(activeThreadId)
  const activeTurnIdRef = useRef<string | null>(activeTurnId)

  useEffect(() => window.api.browser.onState(setBrowserState), [])

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId
  }, [activeThreadId])

  useEffect(() => {
    activeTurnIdRef.current = activeTurnId
  }, [activeTurnId])

  useEffect(() => {
    splitRef.current = split
  }, [split])

  useEffect(() => {
    if (workspace) {
      window.localStorage.setItem('codexdesktop.workspace', workspace)
    } else {
      window.localStorage.removeItem('codexdesktop.workspace')
    }
  }, [workspace])

  useEffect(() => {
    const dispose = window.api.codex.onEvent((event) => {
      if (event.type === 'status') {
        setCodexStatus(event.status)

        if (event.status === 'exited' || event.status === 'error') {
          addSystemItem(event.message ?? 'Codex app-server is not available.', event.status === 'error' ? 'error' : 'warning')
        }

        return
      }

      handleCodexNotification(event.notification as ServerNotification)
    })

    void window.api.codex.getAuthStatus().catch((error: Error) => {
      addSystemItem(`Codex auth check failed: ${error.message}`, 'error')
    })
    void refreshThreads()

    return dispose
  }, [])

  const measureBrowserBounds = useCallback((): BrowserBounds | null => {
    const host = viewHostRef.current

    if (!host) {
      return null
    }

    const rect = host.getBoundingClientRect()

    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    }
  }, [])

  const updateBrowserBounds = useCallback((sendFinal = false) => {
    const bounds = measureBrowserBounds()

    if (!bounds) {
      return
    }

    setViewBounds(bounds)
    pendingBoundsRef.current = bounds

    if (sendFinal) {
      void window.api.browser.setBounds(bounds)
      return
    }

    if (rafRef.current !== null) {
      return
    }

    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null

      if (!isDraggingDividerRef.current && pendingBoundsRef.current) {
        void window.api.browser.setBounds(pendingBoundsRef.current)
      }
    })
  }, [measureBrowserBounds])

  useEffect(() => {
    updateBrowserBounds(true)
  }, [split, updateBrowserBounds])

  useEffect(() => {
    const host = viewHostRef.current

    if (!host) {
      return
    }

    const observer = new ResizeObserver(() => updateBrowserBounds())
    const handleResize = (): void => updateBrowserBounds()

    observer.observe(host)
    window.addEventListener('resize', handleResize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [updateBrowserBounds])

  const activeTab = useMemo(
    () => browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ?? null,
    [browserState]
  )

  const handleDividerPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const app = appRef.current

    if (!app) {
      return
    }

    isDraggingDividerRef.current = true
    void window.api.browser.beginDividerDrag()
    event.currentTarget.setPointerCapture(event.pointerId)

    const appRect = app.getBoundingClientRect()

    const handleMove = (moveEvent: globalThis.PointerEvent): void => {
      const rawChatWidth = moveEvent.clientX - appRect.left
      const maxChatWidth = appRect.width - minBrowserWidth - dividerWidth
      const clamped = Math.min(Math.max(rawChatWidth, minChatWidth), maxChatWidth)
      const nextSplit = (clamped / appRect.width) * 100
      splitRef.current = nextSplit
      setSplit(nextSplit)
    }

    const handleUp = (): void => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.localStorage.setItem('codexdesktop.split', String(splitRef.current))
      isDraggingDividerRef.current = false
      const latestBounds = measureBrowserBounds() ?? pendingBoundsRef.current

      if (latestBounds) {
        void window.api.browser.endDividerDrag(latestBounds)
      }
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp, { once: true })
  }

  const handleSend = async (text: string): Promise<void> => {
    const trimmed = text.trim()

    if (!trimmed || isSending || activeTurnId) {
      return
    }

    setIsSending(true)

    try {
      const response = await window.api.codex.sendMessage({
        threadId: activeThreadId,
        text: trimmed,
        cwd: workspace
      })
      setActiveThreadId(response.threadId)
      setActiveTurnId(response.turn.id)
      noteTurn(response.turn.id, {
        status: 'inProgress',
        startedAtMs: response.turn.startedAt ? response.turn.startedAt * 1000 : Date.now()
      })
      adoptTurnItems(response.turn.id, response.turn.items)
      mergeItems(response.turn.items)
    } catch (error) {
      addSystemItem(`Codex turn failed to start: ${(error as Error).message}`, 'error')
    } finally {
      setIsSending(false)
    }
  }

  const handleStop = async (): Promise<void> => {
    if (!activeThreadId || !activeTurnId) {
      return
    }

    try {
      await window.api.codex.interruptTurn({ threadId: activeThreadId, turnId: activeTurnId })
    } catch (error) {
      addSystemItem(`Stop failed: ${(error as Error).message}`, 'error')
    }
  }

  const handleNewThread = (): void => {
    setIsThreadMenuOpen(false)
    setActiveThreadId(null)
    setActiveThreadTitle('New Chat')
    setActiveTurnId(null)
    setItems([])
    setItemMeta({})
    setTurnMeta({})
  }

  const handleResumeThread = async (threadId: string): Promise<void> => {
    setIsThreadMenuOpen(false)

    try {
      const resumed = await window.api.codex.resumeThread(threadId)
      hydrateThread(resumed.thread)
      const read = await window.api.codex.readThread(threadId)
      hydrateThread(read.thread)
    } catch (error) {
      addSystemItem(`Thread resume failed: ${(error as Error).message}`, 'error')
    }
  }

  const handlePickWorkspace = async (): Promise<void> => {
    try {
      const picked = await window.api.workspace.pick()

      if (picked) {
        setWorkspace(picked)
      }
    } catch (error) {
      addSystemItem(`Workspace selection failed: ${(error as Error).message}`, 'error')
    }
  }

  const hasThreadContent = items.length > 0

  function handleCodexNotification(notification: ServerNotification): void {
    const currentThreadId = activeThreadIdRef.current

    switch (notification.method) {
      case 'thread/started':
        setActiveThreadId(notification.params.thread.id)
        setActiveThreadTitle(threadTitle(notification.params.thread))
        return
      case 'thread/name/updated':
        if (notification.params.threadId === currentThreadId) {
          setActiveThreadTitle(notification.params.threadName || 'New Chat')
        }
        void refreshThreads()
        return
      case 'turn/started':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          const turn = notification.params.turn
          setActiveThreadId(notification.params.threadId)
          setActiveTurnId(turn.id)
          noteTurn(turn.id, {
            status: 'inProgress',
            startedAtMs: turn.startedAt ? turn.startedAt * 1000 : Date.now()
          })
          adoptTurnItems(turn.id, turn.items)
          mergeItems(turn.items)
        }
        return
      case 'turn/completed':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          const turn = notification.params.turn
          adoptTurnItems(turn.id, turn.items)
          mergeItems(turn.items)
          noteTurn(turn.id, {
            status: turn.status === 'inProgress' ? 'completed' : turn.status,
            completedAtMs: turn.completedAt ? turn.completedAt * 1000 : Date.now(),
            durationMs: turn.durationMs ?? undefined,
            errorMessage: turn.error?.message
          })
          setActiveTurnId((current) => (current === turn.id ? null : current))
        }
        void refreshThreads()
        return
      case 'item/started':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteItem(notification.params.item.id, notification.params.turnId, {
            startedAtMs: notification.params.startedAtMs
          })
          upsertItem(notification.params.item)
        }
        return
      case 'item/completed':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteItem(notification.params.item.id, notification.params.turnId, {
            completedAtMs: notification.params.completedAtMs
          })
          upsertItem(notification.params.item)
        }
        return
      case 'item/agentMessage/delta':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchItemText(notification.params.itemId, notification.params.delta, 'agentMessage')
        }
        return
      case 'item/commandExecution/outputDelta':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchCommandOutput(notification.params.itemId, notification.params.delta)
        }
        return
      case 'item/fileChange/patchUpdated':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchFileChanges(notification.params.itemId, notification.params.changes)
        }
        return
      case 'item/mcpToolCall/progress':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteItemProgress(
            notification.params.itemId,
            notification.params.turnId,
            notification.params.message
          )
        }
        return
      case 'thread/tokenUsage/updated':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteTurn(notification.params.turnId, { tokens: notification.params.tokenUsage })
        }
        return
      case 'turn/diff/updated':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteTurn(notification.params.turnId, {
            diffSummary: summarizeTurnDiff(notification.params.diff)
          })
        }
        return
      case 'item/reasoning/summaryTextDelta':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchReasoningPart(notification.params.itemId, 'summary', notification.params.summaryIndex, notification.params.delta)
        }
        return
      case 'item/reasoning/summaryPartAdded':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchReasoningPart(notification.params.itemId, 'summary', notification.params.summaryIndex, '')
        }
        return
      case 'item/reasoning/textDelta':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchReasoningPart(notification.params.itemId, 'content', notification.params.contentIndex, notification.params.delta)
        }
        return
      case 'item/plan/delta':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchPlan(notification.params.itemId, notification.params.delta)
        }
        return
      case 'turn/plan/updated':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          upsertTurnPlan(notification.params.turnId, notification.params.explanation, notification.params.plan)
        }
        return
      case 'error':
        if (isRelevantThread(notification.params.threadId, currentThreadId)) {
          addSystemItem(notification.params.error.message, 'error')
          const failedTurnId = activeTurnIdRef.current
          if (failedTurnId) {
            noteTurn(failedTurnId, {
              status: 'failed',
              completedAtMs: Date.now(),
              errorMessage: notification.params.error.message
            })
          }
          setActiveTurnId(null)
        }
        return
      case 'warning':
        if (!notification.params.threadId || isRelevantThread(notification.params.threadId, currentThreadId)) {
          addSystemItem(notification.params.message, 'warning')
        }
        return
      default:
        return
    }
  }

  function mergeItems(nextItems: ThreadItem[]): void {
    setItems((current) => upsertMany(current, nextItems))
  }

  // Record lifecycle metadata for an item. The incoming turnId wins when
  // present; existing fields survive partial updates.
  function noteItem(itemId: string, turnId: string | null, patch: Partial<ItemMeta> = {}): void {
    setItemMeta((current) => {
      const existing = current[itemId]
      return {
        ...current,
        [itemId]: { ...existing, ...patch, turnId: turnId ?? existing?.turnId ?? null }
      }
    })
  }

  function noteItemProgress(itemId: string, turnId: string | null, message: string): void {
    setItemMeta((current) => {
      const existing = current[itemId]
      const progress = [...(existing?.progress ?? []), message].slice(-5)
      return {
        ...current,
        [itemId]: { ...existing, progress, turnId: turnId ?? existing?.turnId ?? null }
      }
    })
  }

  function noteTurn(turnId: string, patch: Partial<TurnMeta>): void {
    setTurnMeta((current) => ({
      ...current,
      [turnId]: { status: 'inProgress', ...current[turnId], ...patch }
    }))
  }

  // Tag a batch of items (from turn/started, turn/completed, or turn/start
  // responses) with the turn they belong to.
  function adoptTurnItems(turnId: string, turnItems: ThreadItem[]): void {
    setItemMeta((current) => {
      const next = { ...current }
      for (const item of turnItems) {
        next[item.id] = { ...next[item.id], turnId }
      }
      return next
    })
  }

  async function refreshThreads(): Promise<void> {
    try {
      const response = await window.api.codex.listThreads()
      setThreads(response.data)
    } catch {
      // A failed history refresh should not block the active conversation.
    }
  }

  function hydrateThread(thread: Thread): void {
    setActiveThreadId(thread.id)
    setActiveThreadTitle(threadTitle(thread))
    setActiveTurnId(thread.turns.find((turn) => turn.status === 'inProgress')?.id ?? null)

    const nextItems: ChatItem[] = []
    const nextItemMeta: Record<string, ItemMeta> = {}
    const nextTurnMeta: Record<string, TurnMeta> = {}

    for (const turn of thread.turns) {
      nextTurnMeta[turn.id] = {
        status: turn.status,
        startedAtMs: turn.startedAt ? turn.startedAt * 1000 : undefined,
        completedAtMs: turn.completedAt ? turn.completedAt * 1000 : undefined,
        durationMs: turn.durationMs ?? undefined,
        errorMessage: turn.error?.message
      }
      for (const item of turn.items) {
        nextItemMeta[item.id] = { turnId: turn.id }
        nextItems.push(item)
      }
    }

    setItems(nextItems)
    setItemMeta(nextItemMeta)
    setTurnMeta(nextTurnMeta)
  }

  function upsertItem(item: ThreadItem): void {
    setItems((current) => upsertMany(current, [item]))
  }

  function patchItemText(itemId: string, delta: string, fallbackType: 'agentMessage'): void {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === itemId)

      if (index === -1) {
        return [...current, { type: fallbackType, id: itemId, text: delta, phase: null, memoryCitation: null }]
      }

      return current.map((item) => {
        if (item.id !== itemId || item.type !== 'agentMessage') {
          return item
        }

        return { ...item, text: `${item.text}${delta}` }
      })
    })
  }

  function patchCommandOutput(itemId: string, delta: string): void {
    setItems((current) =>
      current.map((item) => {
        if (item.id !== itemId || item.type !== 'commandExecution') {
          return item
        }

        return {
          ...item,
          aggregatedOutput: `${item.aggregatedOutput ?? ''}${delta}`
        }
      })
    )
  }

  // Live diff stream: item/fileChange/patchUpdated replaces the item's full
  // change set on every update (the diff grows as Codex writes the file).
  function patchFileChanges(itemId: string, changes: FileUpdateChange[]): void {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === itemId)

      if (index === -1) {
        return [...current, { type: 'fileChange', id: itemId, changes, status: 'inProgress' }]
      }

      return current.map((item) =>
        item.id === itemId && item.type === 'fileChange' ? { ...item, changes } : item
      )
    })
  }

  function patchReasoningPart(itemId: string, field: 'summary' | 'content', partIndex: number, delta: string): void {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === itemId)

      if (index === -1) {
        const item: Extract<ThreadItem, { type: 'reasoning' }> = {
          type: 'reasoning',
          id: itemId,
          summary: [],
          content: []
        }
        const target = field === 'summary' ? item.summary : item.content
        while (target.length <= partIndex) {
          target.push('')
        }
        target[partIndex] = delta
        return [...current, item]
      }

      return current.map((item) => {
        if (item.id !== itemId || item.type !== 'reasoning') {
          return item
        }

        const target = field === 'summary' ? [...item.summary] : [...item.content]
        while (target.length <= partIndex) {
          target.push('')
        }
        target[partIndex] = `${target[partIndex]}${delta}`

        return field === 'summary' ? { ...item, summary: target } : { ...item, content: target }
      })
    })
  }

  function patchPlan(itemId: string, delta: string): void {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === itemId)

      if (index === -1) {
        return [...current, { type: 'plan', id: itemId, text: delta }]
      }

      return current.map((item) => {
        if (item.id !== itemId || item.type !== 'plan') {
          return item
        }

        return { ...item, text: `${item.text}${delta}` }
      })
    })
  }

  // The structured turn plan renders as a live checklist card that updates in
  // place as steps complete.
  function upsertTurnPlan(
    turnId: string,
    explanation: string | null,
    plan: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>
  ): void {
    if (!plan.length && !explanation) {
      return
    }

    const id = `turn-plan-${turnId}`
    const item: TurnPlanItem = { type: 'turnPlan', id, explanation, steps: plan }
    noteItem(id, turnId)
    setItems((current) => upsertMany(current, [item]))
  }

  function addSystemItem(text: string, level: SystemItem['level'] = 'info'): void {
    setItems((current) => [...current, { type: 'system', id: crypto.randomUUID(), level, text }])
  }

  return (
    <div ref={appRef} className="app-shell">
      <TitleBar />
      <main className="workspace" style={{ gridTemplateColumns: `${split}% ${dividerWidth}px 1fr` }}>
        <ChatPane
          items={items}
          itemMeta={itemMeta}
          turnMeta={turnMeta}
          title={activeThreadTitle}
          status={codexStatus}
          threads={threads}
          activeThreadId={activeThreadId}
          activeTurnId={activeTurnId}
          isThreadMenuOpen={isThreadMenuOpen}
          hasThreadContent={hasThreadContent}
          isBusy={isSending || Boolean(activeTurnId)}
          workspace={workspace}
          onSend={handleSend}
          onStop={handleStop}
          onNewThread={handleNewThread}
          onToggleThreadMenu={() => setIsThreadMenuOpen((open) => !open)}
          onResumeThread={handleResumeThread}
          onPickWorkspace={handlePickWorkspace}
        />
        <div className="split-divider" onPointerDown={handleDividerPointerDown} />
        <BrowserPane
          state={browserState}
          activeTab={activeTab}
          viewHostRef={viewHostRef}
          viewBounds={viewBounds}
        />
      </main>
    </div>
  )
}

function TitleBar(): JSX.Element {
  return (
    <header className="titlebar">
      <div className="titlebar-title">Chat</div>
      <div className="window-controls">
        <button type="button" aria-label="Minimize" onClick={() => void window.api.window.minimize()}>
          -
        </button>
        <button type="button" aria-label="Maximize" onClick={() => void window.api.window.toggleMaximize()}>
          □
        </button>
        <button type="button" aria-label="Close" onClick={() => void window.api.window.close()}>
          ×
        </button>
      </div>
    </header>
  )
}

function ChatPane({
  items,
  itemMeta,
  turnMeta,
  title,
  status,
  threads,
  activeThreadId,
  activeTurnId,
  isThreadMenuOpen,
  hasThreadContent,
  isBusy,
  workspace,
  onSend,
  onStop,
  onNewThread,
  onToggleThreadMenu,
  onResumeThread,
  onPickWorkspace
}: {
  items: ChatItem[]
  itemMeta: Record<string, ItemMeta>
  turnMeta: Record<string, TurnMeta>
  title: string
  status: string
  threads: Thread[]
  activeThreadId: string | null
  activeTurnId: string | null
  isThreadMenuOpen: boolean
  hasThreadContent: boolean
  isBusy: boolean
  workspace: string | null
  onSend: (text: string) => Promise<void>
  onStop: () => Promise<void>
  onNewThread: () => void
  onToggleThreadMenu: () => void
  onResumeThread: (threadId: string) => Promise<void>
  onPickWorkspace: () => Promise<void>
}): JSX.Element {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const { rows, turnWork } = useMemo(
    () => buildRows(items, itemMeta, activeTurnId),
    [items, itemMeta, activeTurnId]
  )

  // True while the live turn's newest item is an assistant message still
  // receiving deltas — drives the "Writing" tail label and message caret.
  const streamingMessageId = useMemo(() => {
    if (!activeTurnId) {
      return null
    }
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]
      if (item.type === 'system' || itemMeta[item.id]?.turnId !== activeTurnId) {
        continue
      }
      return item.type === 'agentMessage' && !itemMeta[item.id]?.completedAtMs ? item.id : null
    }
    return null
  }, [items, itemMeta, activeTurnId])

  return (
    <section className={`chat-pane ${hasThreadContent ? 'is-thread' : 'is-empty'}`}>
      <div className="chat-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label="Open settings"
          title="Settings"
          onClick={() => setIsSettingsOpen(true)}
        >
          <SettingsIcon />
        </button>
        <ThreadMenu
          title={title}
          threads={threads}
          activeThreadId={activeThreadId}
          isOpen={isThreadMenuOpen}
          onToggle={onToggleThreadMenu}
          onNewThread={onNewThread}
          onResumeThread={onResumeThread}
        />
      </div>

      <ThreadScroll dependencies={[items, itemMeta, activeTurnId]}>
        {rows.map((row) => {
          if (row.kind === 'work') {
            return (
              <WorkGroup
                key={row.id}
                items={row.items}
                itemMeta={itemMeta}
                live={Boolean(activeTurnId) && row.turnId === activeTurnId}
                workspace={workspace}
              />
            )
          }
          if (row.kind === 'tail') {
            return (
              <TurnTail
                key={row.id}
                live={row.turnId === activeTurnId}
                items={turnWork.get(row.turnId) ?? []}
                itemMeta={itemMeta}
                meta={turnMeta[row.turnId]}
                streamingMessage={Boolean(streamingMessageId) && row.turnId === activeTurnId}
              />
            )
          }
          return (
            <ChatItemView
              key={row.item.id}
              item={row.item}
              streaming={row.item.id === streamingMessageId}
            />
          )
        })}
      </ThreadScroll>

      <div className={`composer-dock ${hasThreadContent ? 'is-docked' : 'is-centered'}`}>
        <div className="composer-context">
          <WorkspacePill workspace={workspace} onPickWorkspace={onPickWorkspace} />
        </div>
        <Composer
          docked={hasThreadContent}
          isBusy={isBusy}
          status={status}
          onSend={onSend}
          onStop={onStop}
        />
      </div>

      {isSettingsOpen ? (
        <SettingsModal
          onClose={() => setIsSettingsOpen(false)}
        />
      ) : null}
    </section>
  )
}

// The thread selector: a centered trigger that opens a premium popover with a
// search field, a "New chat" action, and the recent-thread list grouped by
// recency. Supports type-to-filter and full keyboard navigation. Closes on
// outside-click / Escape.
function ThreadMenu({
  title,
  threads,
  activeThreadId,
  isOpen,
  onToggle,
  onNewThread,
  onResumeThread
}: {
  title: string
  threads: Thread[]
  activeThreadId: string | null
  isOpen: boolean
  onToggle: () => void
  onNewThread: () => void
  onResumeThread: (threadId: string) => Promise<void>
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  // Highlighted row for keyboard/hover navigation. `null` = nothing highlighted
  // (the resting state on open — no row shows a pre-selection). `-1` = the New
  // chat action; `0..n` index into the flat, filtered thread list.
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  // Filter by title/preview, then bucket into recency groups. `nowSeconds` is
  // sampled once per open so relative labels ("2h", "Yesterday") stay stable.
  const { groups, flatIds } = useMemo(
    () => groupThreadsForMenu(threads, query),
    [threads, query]
  )

  // Reset transient state whenever the menu opens; focus the search field so the
  // user can immediately type to filter (Cursor-style).
  useEffect(() => {
    if (!isOpen) {
      return
    }
    setQuery('')
    setActiveIndex(null)
    const id = window.requestAnimationFrame(() => searchRef.current?.focus())
    return () => window.cancelAnimationFrame(id)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        onToggle()
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
    }
  }, [isOpen, onToggle])

  const resume = (threadId: string): void => {
    onToggle()
    void onResumeThread(threadId)
  }

  const openNewThread = (): void => {
    onToggle()
    onNewThread()
  }

  const handleKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onToggle()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      // First press moves off the resting state onto New chat, then into the list.
      setActiveIndex((index) => (index === null ? -1 : Math.min(index + 1, flatIds.length - 1)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (index === null ? -1 : Math.max(index - 1, -1)))
      return
    }
    if (event.key === 'Enter') {
      // With nothing highlighted, let Enter fall through (no-op here).
      if (activeIndex === null) {
        return
      }
      event.preventDefault()
      if (activeIndex === -1) {
        openNewThread()
      } else if (flatIds[activeIndex]) {
        resume(flatIds[activeIndex])
      }
    }
  }

  return (
    <div ref={wrapRef} className="thread-select-wrap">
      <button
        type="button"
        className={`thread-select ${isOpen ? 'is-open' : ''}`}
        aria-label="Open thread menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className="thread-title">{title}</span>
        <span className="chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="m6 9 6 6 6-6"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {isOpen ? (
        <div className="thread-menu" role="menu" onKeyDown={handleKeyDown}>
          <div className="thread-menu-search">
            <SearchIcon />
            <input
              ref={searchRef}
              type="text"
              className="thread-menu-search-input"
              placeholder="Search chats…"
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(-1)
              }}
            />
          </div>

          <div className="thread-menu-scroll">
            <button
              type="button"
              className={`thread-menu-new ${activeIndex === -1 ? 'is-highlighted' : ''}`}
              role="menuitem"
              onMouseEnter={() => setActiveIndex(-1)}
              onClick={openNewThread}
            >
              <span className="thread-menu-new-icon" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 5v14M5 12h14"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              New chat
            </button>

            {flatIds.length ? (
              groups.map((group) => (
                <div className="thread-menu-group" key={group.label}>
                  <div className="thread-menu-label">{group.label}</div>
                  {group.threads.map((thread) => {
                    const index = flatIds.indexOf(thread.id)
                    return (
                      <button
                        type="button"
                        key={thread.id}
                        role="menuitem"
                        className={`thread-menu-item ${
                          thread.id === activeThreadId ? 'is-active' : ''
                        } ${index === activeIndex ? 'is-highlighted' : ''}`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => resume(thread.id)}
                      >
                        <span className="thread-menu-item-icon" aria-hidden="true">
                          <ChatBubbleIcon />
                        </span>
                        <span className="thread-menu-item-title">{threadTitle(thread)}</span>
                        <time className="thread-menu-item-time">
                          {relativeThreadTime(thread.recencyAt ?? thread.updatedAt)}
                        </time>
                      </button>
                    )
                  })}
                </div>
              ))
            ) : (
              <div className="thread-menu-empty">
                {query ? `No chats matching “${query.trim()}”` : 'No chats yet'}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

type ThreadGroup = { label: string; threads: Thread[] }

// Filters threads by the search query, sorts by recency, and buckets them into
// human recency bands (Today / Yesterday / Previous 7 days / Older). Returns the
// grouped view plus a flat id list in display order for keyboard navigation.
function groupThreadsForMenu(
  threads: Thread[],
  query: string
): { groups: ThreadGroup[]; flatIds: string[] } {
  const needle = query.trim().toLowerCase()
  const matched = needle
    ? threads.filter((thread) => threadTitle(thread).toLowerCase().includes(needle))
    : threads

  const sorted = [...matched].sort(
    (a, b) => (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt)
  )

  const now = Date.now()
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const dayMs = 86_400_000
  const todayStart = startOfToday.getTime()
  const yesterdayStart = todayStart - dayMs
  const weekStart = todayStart - 7 * dayMs

  const buckets: ThreadGroup[] = [
    { label: 'Today', threads: [] },
    { label: 'Yesterday', threads: [] },
    { label: 'Previous 7 days', threads: [] },
    { label: 'Older', threads: [] }
  ]

  for (const thread of sorted) {
    const ms = (thread.recencyAt ?? thread.updatedAt) * 1000
    if (ms >= todayStart) {
      buckets[0].threads.push(thread)
    } else if (ms >= yesterdayStart) {
      buckets[1].threads.push(thread)
    } else if (ms >= weekStart) {
      buckets[2].threads.push(thread)
    } else {
      buckets[3].threads.push(thread)
    }
  }

  const groups = buckets.filter((bucket) => bucket.threads.length > 0)
  const flatIds = groups.flatMap((group) => group.threads.map((thread) => thread.id))
  return { groups, flatIds }
}

function SearchIcon(): JSX.Element {
  return (
    <svg
      className="thread-menu-search-icon"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function ChatBubbleIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v8A1.5 1.5 0 0 1 18.5 15H9l-4 3.5V15H5.5A1.5 1.5 0 0 1 4 13.5v-8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FolderIcon(): JSX.Element {
  return (
    <svg className="workspace-pill-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2a1.5 1.5 0 0 1 1.06.44l1.06 1.06A1.5 1.5 0 0 0 11.88 7H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SettingsIcon(): JSX.Element {
  return (
    <svg className="icon-settings" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function SettingsModal({
  onClose
}: {
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  // The browser is a native view above the DOM, so hide it while this modal is
  // open — otherwise it renders on top of the modal. Restored on unmount.
  useEffect(() => {
    void window.api.browser.setOverlayOpen(true)
    return () => {
      void window.api.browser.setOverlayOpen(false)
    }
  }, [])

  return (
    <div className="settings-overlay" onPointerDown={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <h2 className="settings-title">Settings</h2>
          <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </header>
      </div>
    </div>
  )
}

// Keeps the transcript pinned to the bottom as content streams in, but yields to
// the user the moment they scroll up to read back — re-pinning only when they
// return to the bottom themselves.
function ThreadScroll({
  children,
  dependencies
}: {
  children: React.ReactNode
  dependencies: unknown[]
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = ref.current
    if (!el) {
      return
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distanceFromBottom < 48
  }, [])

  useEffect(() => {
    const el = ref.current
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies)

  return (
    <div ref={ref} className="thread-scroll" onScroll={handleScroll}>
      {children}
    </div>
  )
}

function ChatItemView({ item, streaming }: { item: ChatItem; streaming: boolean }): JSX.Element | null {
  if (item.type === 'system') {
    return <article className={`message message-system message-system-${item.level}`}>{item.text}</article>
  }

  if (item.type === 'userMessage') {
    return (
      <article className="message message-user">
        <p>{item.content.map((content) => (content.type === 'text' ? content.text : `[${content.type}]`)).join('\n')}</p>
      </article>
    )
  }

  if (item.type === 'agentMessage') {
    // Messages stream into the transcript live, Cursor-style — commentary
    // (in-task narration) renders slightly muted; the final answer full-weight.
    return (
      <AssistantMessage text={item.text} streaming={streaming} commentary={item.phase === 'commentary'} />
    )
  }

  if (item.type === 'contextCompaction') {
    return <article className="message message-system message-system-info">Context compacted</article>
  }

  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    return (
      <article className="message message-system message-system-info">
        {item.type === 'enteredReviewMode' ? 'Entered review mode' : 'Exited review mode'}
      </article>
    )
  }

  // Anything else (hookPrompt and future item types) stays quiet but visible.
  return (
    <article className="message message-tool">
      <strong>{item.type}</strong>
    </article>
  )
}

function AssistantMessage({
  text,
  streaming,
  commentary
}: {
  text: string
  streaming: boolean
  commentary: boolean
}): JSX.Element {
  return (
    <article
      className={`message message-assistant ${commentary ? 'message-commentary' : ''} ${
        streaming ? 'is-streaming' : ''
      }`}
    >
      <ReactMarkdown>{text || ' '}</ReactMarkdown>
    </article>
  )
}

function WorkspacePill({
  workspace,
  onPickWorkspace
}: {
  workspace: string | null
  onPickWorkspace: () => Promise<void>
}): JSX.Element {
  return (
    <button
      type="button"
      className="workspace-pill"
      title={workspace ?? 'No workspace selected — new chats start in your home folder'}
      onClick={() => void onPickWorkspace()}
    >
      <FolderIcon />
      <span className="workspace-pill-name">{workspace ? workspaceName(workspace) : 'Choose workspace'}</span>
      <span className="workspace-pill-caret">⌄</span>
    </button>
  )
}

function Composer({
  docked,
  isBusy,
  status,
  onSend,
  onStop
}: {
  docked: boolean
  isBusy: boolean
  status: string
  onSend: (text: string) => Promise<void>
  onStop: () => Promise<void>
}): JSX.Element {
  const [value, setValue] = useState('')

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    if (isBusy) {
      void onStop()
      return
    }

    const text = value
    setValue('')
    void onSend(text)
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        value={value}
        rows={3}
        placeholder={docked ? 'Reply...' : 'Plan, Build, / for commands, @ for context'}
        disabled={isBusy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <div className="composer-footer">
        <span className="composer-status">{status}</span>
        <button type="submit" className="send-button" aria-label={isBusy ? 'Stop turn' : 'Send message'} disabled={!isBusy && !value.trim()}>
          {isBusy ? '■' : '↑'}
        </button>
      </div>
    </form>
  )
}

function BrowserPane({
  state,
  activeTab,
  viewHostRef,
  viewBounds
}: {
  state: BrowserState
  activeTab: BrowserTabState | null
  viewHostRef: React.RefObject<HTMLDivElement | null>
  viewBounds: BrowserBounds | null
}): JSX.Element {
  return (
    <section className="browser-pane">
      <TabStrip state={state} />
      <BrowserToolbar activeTab={activeTab} />
      <div className="browser-frame">
        <div ref={viewHostRef} className="browser-view-host" data-ready={viewBounds ? 'true' : 'false'} />
      </div>
    </section>
  )
}

function TabStrip({ state }: { state: BrowserState }): JSX.Element {
  return (
    <div className="tab-strip">
      {state.tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          className={`tab ${tab.id === state.activeTabId ? 'is-active' : ''}`}
          onClick={() => void window.api.browser.activateTab(tab.id)}
        >
          <span className="tab-dot">●</span>
          <span className="tab-title">{tab.title || 'New Tab'}</span>
          <span
            role="button"
            tabIndex={0}
            className="tab-close"
            aria-label={`Close ${tab.title || 'tab'}`}
            onClick={(event) => {
              event.stopPropagation()
              void window.api.browser.closeTab(tab.id)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation()
                void window.api.browser.closeTab(tab.id)
              }
            }}
          >
            ×
          </span>
        </button>
      ))}
      <button type="button" className="new-tab-button" aria-label="New tab" onClick={() => void window.api.browser.newTab()}>
        +
      </button>
    </div>
  )
}

function BrowserToolbar({ activeTab }: { activeTab: BrowserTabState | null }): JSX.Element {
  const [input, setInput] = useState('')

  useEffect(() => {
    setInput(activeTab?.url ?? '')
  }, [activeTab?.url])

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    if (activeTab) {
      void window.api.browser.navigate(activeTab.id, input)
    }
  }

  return (
    <form className="browser-toolbar" onSubmit={handleSubmit}>
      <button
        type="button"
        className="browser-nav-button"
        aria-label="Back"
        disabled={!activeTab?.canGoBack}
        onClick={() => activeTab && void window.api.browser.back(activeTab.id)}
      >
        ‹
      </button>
      <button
        type="button"
        className="browser-nav-button"
        aria-label="Forward"
        disabled={!activeTab?.canGoForward}
        onClick={() => activeTab && void window.api.browser.forward(activeTab.id)}
      >
        ›
      </button>
      <button
        type="button"
        className="browser-nav-button"
        aria-label="Reload"
        disabled={!activeTab}
        onClick={() => activeTab && void window.api.browser.reload(activeTab.id)}
      >
        ↻
      </button>
      <input
        className="omnibox"
        value={input}
        spellCheck={false}
        aria-label="Address"
        onChange={(event) => setInput(event.target.value)}
      />
      <button type="button" className="browser-nav-button close-ghost" aria-label="Clear address" onClick={() => setInput('')}>
        ×
      </button>
    </form>
  )
}

function upsertMany(current: ChatItem[], nextItems: ChatItem[]): ChatItem[] {
  const next = [...current]

  for (const item of nextItems) {
    const index = next.findIndex((currentItem) => currentItem.id === item.id)

    if (index === -1) {
      next.push(item)
    } else {
      next[index] = item
    }
  }

  return next
}

function isRelevantThread(incomingThreadId: string, activeThreadId: string | null): boolean {
  return !activeThreadId || incomingThreadId === activeThreadId
}

function threadTitle(thread: Thread): string {
  return thread.name || thread.preview || 'New Chat'
}

function workspaceName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

// Compact recency label for a thread row: "now", "5m", "3h" within a day, then
// "Yesterday", a weekday within the week, and a short date beyond that. Keeps
// rows scannable instead of repeating a full "Jul 9, 3:14 PM" on every line.
function relativeThreadTime(seconds: number): string {
  const then = seconds * 1000
  const diff = Date.now() - then
  if (diff < 45_000) {
    return 'now'
  }
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.round(diff / 3_600_000)
  if (hours < 24) {
    return `${hours}h`
  }

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const dayMs = 86_400_000
  if (then >= startOfToday.getTime() - dayMs) {
    return 'Yesterday'
  }
  if (then >= startOfToday.getTime() - 6 * dayMs) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(then)
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(then)
}

