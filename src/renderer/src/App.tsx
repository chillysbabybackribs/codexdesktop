import {
  Children,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  BrowserBounds,
  BrowserState,
  BrowserTabState,
  CodexEvent,
  MemoryPersistParams
} from '../../shared/ipc'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort'
import type { CodexErrorInfo } from '../../shared/codex-protocol/v2/CodexErrorInfo'
import type { TurnError } from '../../shared/codex-protocol/v2/TurnError'
import type { FileUpdateChange } from '../../shared/codex-protocol/v2/FileUpdateChange'
import type { Model } from '../../shared/codex-protocol/v2/Model'
import type { Thread } from '../../shared/codex-protocol/v2/Thread'
import type { ThreadGoal } from '../../shared/codex-protocol/v2/ThreadGoal'
import type { ThreadGoalStatus } from '../../shared/codex-protocol/v2/ThreadGoalStatus'
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem'
import type { Turn } from '../../shared/codex-protocol/v2/Turn'
import { summarizeTurnDiff } from './diff'
import { TraceModal } from './TraceModal'
import { buildTurnTrace, isTurnTrace, type TurnTrace } from './trace'
import {
  modelCallAttributionForItem,
  reduceTurnTelemetry,
  type ModelCallAttribution
} from './turn-telemetry'
import {
  AutoFollow,
  TurnTail,
  WorkGroup,
  workItemTypes,
  type ItemMeta,
  type TurnMeta,
  type TurnPlanItem,
  type WorkItem
} from './TaskActivity'
import { selectCompletedWork } from './memory-work'

type SystemItem = {
  type: 'system'
  id: string
  level: 'info' | 'warning' | 'error'
  text: string
}

type ChatItem = ThreadItem | SystemItem | TurnPlanItem
type AgentMessageItem = Extract<ThreadItem, { type: 'agentMessage' }>
type ActivityItem = WorkItem | AgentMessageItem

// Item types that represent Codex "working" — streamed thinking, tool calls,
// file edits, and searches. They stay in a compact per-turn activity feed;
// user and completed assistant messages render in the main conversation.
const workTypes = new Set<string>(workItemTypes)

function isWorkItem(item: ChatItem): item is WorkItem {
  return workTypes.has(item.type)
}

function isActivityItem(
  item: ChatItem,
  turnId: string | null,
  lastAgentMessageIdByTurn: ReadonlyMap<string, string>
): item is ActivityItem {
  if (isWorkItem(item)) {
    return true
  }

  if (item.type !== 'agentMessage') {
    return false
  }

  // Some providers leave `phase` null. Keep every non-final unknown chunk in
  // the activity feed and reserve the last agent message for the completed
  // response, preserving the desired layout on older/resumed threads too.
  return item.phase === 'commentary' || (item.phase === null && turnId !== null && item.id !== lastAgentMessageIdByTurn.get(turnId))
}

// The transcript has two deliberately separate surfaces per turn: a bounded
// activity feed for tool work and in-task commentary, then a final answer that
// remains in the main flow while its text streams.
type RenderRow =
  | { kind: 'chat'; item: ChatItem; turnId: string | null }
  | { kind: 'activity'; id: string; turnId: string | null; items: ActivityItem[] }
  | { kind: 'tail'; id: string; turnId: string }

function buildRows(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  activeTurnId: string | null
): { rows: RenderRow[]; turnWork: Map<string, WorkItem[]> } {
  const rows: RenderRow[] = []
  const turnWork = new Map<string, WorkItem[]>()
  const activityByTurn = new Map<string, ActivityItem[]>()
  const lastAgentMessageIdByTurn = new Map<string, string>()

  for (const item of items) {
    const turnId = item.type === 'system' ? null : (itemMeta[item.id]?.turnId ?? null)
    if (item.type === 'agentMessage' && turnId) {
      lastAgentMessageIdByTurn.set(turnId, item.id)
    }
  }

  for (const item of items) {
    const turnId = item.type === 'system' ? null : (itemMeta[item.id]?.turnId ?? null)

    if (isActivityItem(item, turnId, lastAgentMessageIdByTurn) && turnId) {
      const activity = activityByTurn.get(turnId) ?? []
      activity.push(item)
      activityByTurn.set(turnId, activity)
    }

    if (isWorkItem(item) && turnId) {
      const work = turnWork.get(turnId) ?? []
      work.push(item)
      turnWork.set(turnId, work)
    }
  }

  const emittedActivityTurns = new Set<string>()
  const lastRowIndex = new Map<string, number>()

  for (const item of items) {
    const turnId = item.type === 'system' ? null : (itemMeta[item.id]?.turnId ?? null)

    if (isActivityItem(item, turnId, lastAgentMessageIdByTurn)) {
      if (turnId && !emittedActivityTurns.has(turnId)) {
        rows.push({
          kind: 'activity',
          id: `activity-${turnId}`,
          turnId,
          items: activityByTurn.get(turnId) ?? [item]
        })
        emittedActivityTurns.add(turnId)
        lastRowIndex.set(turnId, rows.length - 1)
      } else if (!turnId) {
        rows.push({ kind: 'activity', id: `activity-${item.id}`, turnId: null, items: [item] })
      }
      continue
    }

    rows.push({ kind: 'chat', item, turnId })
    if (turnId) {
      lastRowIndex.set(turnId, rows.length - 1)
    }
  }

  // Close completed work after its answer, not between the work feed and the
  // answer. The live turn retains a single status row at the transcript tail.
  const inserts: Array<{ index: number; row: RenderRow }> = []
  for (const turnId of turnWork.keys()) {
    if (turnId !== activeTurnId) {
      const index = lastRowIndex.get(turnId)
      if (index !== undefined) {
        inserts.push({ index, row: { kind: 'tail', id: `tail-${turnId}`, turnId } })
      }
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
const lastThreadStorageKey = 'codexdesktop.lastThreadId'
const modelStorageKey = 'codexdesktop.model'

function isTerminalTurnStatus(status: TurnMeta['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted'
}

// Turn failures the app can recover from by retrying/continuing on the same
// thread: capacity problems on the provider side, not problems with the
// request itself (auth, context window, budget, policy).
const maxAutoRecoveryAttempts = 3
const autoRecoveryDelayMs = 10_000
const autoRecoveryPrompt =
  'The previous turn was cut short by a model availability error. Continue the task from where you left off.'

function isRecoverableTurnError(info: CodexErrorInfo | null): boolean {
  if (!info) return false
  if (info === 'serverOverloaded' || info === 'internalServerError') return true
  return typeof info === 'object' && 'responseTooManyFailedAttempts' in info
}

type AutoRecoveryState = {
  threadId: string
  attempts: number
  // Turn ids already handled, so the `error` notification and the
  // `turn/completed` failure for the same turn schedule only one recovery.
  handledTurnIds: Set<string>
  timer: number | null
}

function cloneGoal(goal: ThreadGoal | null): ThreadGoal | null {
  return goal ? { ...goal } : null
}

export default function App(): React.JSX.Element {
  const [split, setSplit] = useState(() => {
    const stored = Number(window.localStorage.getItem('codexdesktop.split'))
    return Number.isFinite(stored) && stored > 20 && stored < 70 ? stored : 37
  })
  const [items, setItems] = useState<ChatItem[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [activeThreadTitle, setActiveThreadTitle] = useState('New Chat')
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [activeGoal, setActiveGoal] = useState<ThreadGoal | null>(null)
  const [isGoalUpdating, setIsGoalUpdating] = useState(false)
  const [activeReasoningEffort, setActiveReasoningEffort] = useState<ReasoningEffort | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isRestoring, setIsRestoring] = useState(true)
  const [codexStatus, setCodexStatus] = useState('idle')
  const [threads, setThreads] = useState<Thread[]>([])
  const [threadsNextCursor, setThreadsNextCursor] = useState<string | null>(null)
  const [threadsLoading, setThreadsLoading] = useState(false)
  const [threadsError, setThreadsError] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(
    () => window.localStorage.getItem('codexdesktop.workspace')
  )
  const [isThreadMenuOpen, setIsThreadMenuOpen] = useState(false)
  const [models, setModels] = useState<Model[]>([])
  // Model slug sent with every turn. `null` = no explicit pick yet, so turns
  // omit the override and run on the CLI-configured default.
  const [selectedModel, setSelectedModel] = useState<string | null>(
    () => window.localStorage.getItem(modelStorageKey)
  )
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
  const activeGoalRef = useRef<ThreadGoal | null>(activeGoal)
  const activeReasoningEffortRef = useRef<ReasoningEffort | null>(activeReasoningEffort)
  const userTurnRequestPendingRef = useRef(false)
  const userRequestedTurnIdRef = useRef<string | null>(null)
  const selectedModelRef = useRef<string | null>(selectedModel)
  const modelsRef = useRef<Model[]>(models)
  const workspaceRef = useRef<string | null>(workspace)
  // Pending overload recovery for the watched thread; single slot because the
  // notification handler only reacts to one relevant thread at a time.
  const autoRecoveryRef = useRef<AutoRecoveryState | null>(null)
  const watchThreadIdRef = useRef<string | null>(null)
  const resumeGenerationRef = useRef(0)
  const hasAutoRestoredRef = useRef(false)
  const initializationPromiseRef = useRef<Promise<void> | null>(null)
  // All streaming patches (agent text, command output, reasoning, plan, file
  // changes) accumulate here and apply in a single batched setItems per frame.
  // Batching every delta kind — not just agent text — is what keeps a long
  // turn's reasoning/command streams from re-rendering the transcript per token.
  const pendingItemMutationsRef = useRef<Array<(items: ChatItem[]) => ChatItem[]>>([])
  const itemMutationTimerRef = useRef<number | null>(null)
  const threadsNextCursorRef = useRef<string | null>(null)
  const persistedTraceFingerprintsRef = useRef<Map<string, string>>(new Map())
  const persistedMemoryFingerprintsRef = useRef<Map<string, string>>(new Map())
  const precedingModelInputByTurnRef = useRef<Map<string, ModelCallAttribution>>(new Map())
  const pendingCompactionByTurnRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    return window.api.browser.onState(setBrowserState)
  }, [])

  useEffect(() => () => {
    if (itemMutationTimerRef.current !== null) {
      window.clearTimeout(itemMutationTimerRef.current)
    }
  }, [])

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId
  }, [activeThreadId])

  useEffect(() => {
    activeTurnIdRef.current = activeTurnId
  }, [activeTurnId])

  useEffect(() => {
    activeGoalRef.current = activeGoal
  }, [activeGoal])

  useEffect(() => {
    activeReasoningEffortRef.current = activeReasoningEffort
  }, [activeReasoningEffort])

  useEffect(() => {
    selectedModelRef.current = selectedModel
  }, [selectedModel])

  useEffect(() => {
    modelsRef.current = models
  }, [models])

  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

  useEffect(() => {
    splitRef.current = split
  }, [split])

  useEffect(() => {
    threadsNextCursorRef.current = threadsNextCursor
  }, [threadsNextCursor])

  useEffect(() => {
    if (workspace) {
      window.localStorage.setItem('codexdesktop.workspace', workspace)
    } else {
      window.localStorage.removeItem('codexdesktop.workspace')
    }
  }, [workspace])

  useEffect(() => {
    if (!hasAutoRestoredRef.current) {
      return
    }

    void refreshThreads()
  }, [workspace])

  useEffect(() => {
    if (!activeThreadId) return

    for (const [turnId, meta] of Object.entries(turnMeta)) {
      if (meta.origin !== 'live' || !isTerminalTurnStatus(meta.status)) continue

      const trace = buildTurnTrace({
        threadId: activeThreadId,
        threadTitle: activeThreadTitle,
        turnId,
        model: selectedModel,
        workspace,
        items,
        itemMeta,
        meta
      })
      const content = `${JSON.stringify(trace, null, 2)}\n`
      const fingerprint = JSON.stringify({ ...trace, exportedAt: '' })
      const key = `${activeThreadId}/${turnId}`

      if (persistedTraceFingerprintsRef.current.get(key) === fingerprint) continue
      persistedTraceFingerprintsRef.current.set(key, fingerprint)

      void window.api.trace.persist({ threadId: activeThreadId, turnId, content }).catch((error) => {
        if (persistedTraceFingerprintsRef.current.get(key) === fingerprint) {
          persistedTraceFingerprintsRef.current.delete(key)
        }
        console.warn('Failed to persist completed turn trace', error)
      })
    }
  }, [activeThreadId, activeThreadTitle, selectedModel, workspace, items, itemMeta, turnMeta])

  useEffect(() => {
    if (!activeThreadId || activeTurnId) return
    if (!Object.values(turnMeta).some((meta) => meta.origin === 'live' && isTerminalTurnStatus(meta.status))) return

    const turns = completedMemoryTurns(items, itemMeta, turnMeta)
    if (!turns.length) return

    const completionTimes = Object.values(turnMeta)
      .map((meta) => meta.completedAtMs)
      .filter((value): value is number => typeof value === 'number')
    const completedAtMs = completionTimes.length ? Math.max(...completionTimes) : Date.now()
    const params: MemoryPersistParams = {
      threadId: activeThreadId,
      title: activeThreadTitle,
      workspace,
      updatedAt: new Date(completedAtMs).toISOString(),
      turns
    }
    const fingerprint = JSON.stringify(params)

    if (persistedMemoryFingerprintsRef.current.get(activeThreadId) === fingerprint) return
    persistedMemoryFingerprintsRef.current.set(activeThreadId, fingerprint)

    void window.api.memory.persist(params).catch((error) => {
      if (persistedMemoryFingerprintsRef.current.get(activeThreadId) === fingerprint) {
        persistedMemoryFingerprintsRef.current.delete(activeThreadId)
      }
      console.warn('Failed to persist chat memory', error)
    })
  }, [activeThreadId, activeThreadTitle, activeTurnId, workspace, items, itemMeta, turnMeta])

  // The model catalog comes from `model/list` on the app-server, so it is the
  // same list (and default) the CLI's own /model picker shows. Loaded once the
  // server is ready; if it fails, sends simply omit the override.
  useEffect(() => {
    if (codexStatus !== 'ready' || models.length) {
      return
    }

    let cancelled = false

    window.api.codex.listModels().then(
      (list: Model[]) => {
        if (cancelled || !list.length) {
          return
        }
        setModels(list)
        // Drop a persisted pick the CLI no longer offers.
        setSelectedModel((current) =>
          current && list.some((model) => model.model === current) ? current : null
        )
      },
      (error: Error) => console.warn('Failed to load Codex model list', error)
    )

    return () => {
      cancelled = true
    }
  }, [codexStatus, models.length])

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

    if (!initializationPromiseRef.current) {
      const lastThreadId = window.localStorage.getItem(lastThreadStorageKey)
      initializationPromiseRef.current = (async () => {
        const authPromise = window.api.codex.getAuthStatus().catch((error) => {
          addSystemItem(`Codex auth check failed: ${(error as Error).message}`, 'error')
        })
        const threadsPromise = refreshThreads()
        const restorePromise = lastThreadId
          ? resumeThreadById(lastThreadId, { silent: true })
          : Promise.resolve()

        await Promise.all([authPromise, threadsPromise, restorePromise])
        hasAutoRestoredRef.current = true
        setIsRestoring(false)
      })()
    }

    void initializationPromiseRef.current

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

  const handleSend = async (text: string): Promise<boolean> => {
    const trimmed = text.trim()

    if (!trimmed || isSending || activeTurnId) {
      return false
    }

    setIsSending(true)
    userTurnRequestPendingRef.current = true
    watchThreadIdRef.current = activeThreadId

    try {
      const response = await window.api.codex.sendMessage({
        threadId: activeThreadId,
        text: trimmed,
        cwd: workspace,
        model: selectedModel
      })
      watchThreadIdRef.current = response.threadId
      setActiveThreadId(response.threadId)
      persistLastThreadId(response.threadId)
      const turnAlreadyObserved = activeTurnIdRef.current === response.turn.id
      if (!turnAlreadyObserved) userRequestedTurnIdRef.current = response.turn.id
      setActiveTurnId(response.turn.id)
      activeTurnIdRef.current = response.turn.id
      setActiveReasoningEffort(response.reasoningEffort)
      activeReasoningEffortRef.current = response.reasoningEffort
      const goalSnapshot = cloneGoal(activeGoalRef.current)
      noteTurn(response.turn.id, {
        status: 'inProgress',
        origin: 'live',
        requestedModel: selectedModel,
        model: response.model,
        reasoningEffort: response.reasoningEffort,
        workspace,
        goalAtStart: goalSnapshot,
        goalAtEnd: goalSnapshot,
        goalContinuation: false,
        goalContinuationInferred: false,
        startedAtMs: response.turn.startedAt ? response.turn.startedAt * 1000 : Date.now()
      })
      adoptTurnItems(response.turn.id, response.turn.items)
      mergeItems(response.turn.items)
      return true
    } catch (error) {
      addSystemItem(`Codex turn failed to start: ${(error as Error).message}`, 'error')
      return false
    } finally {
      userTurnRequestPendingRef.current = false
      setIsSending(false)
    }
  }

  const handleSteer = async (text: string): Promise<boolean> => {
    const trimmed = text.trim()
    const threadId = activeThreadIdRef.current
    const turnId = activeTurnIdRef.current

    if (!trimmed || !threadId || !turnId) {
      return false
    }

    try {
      await window.api.codex.steerTurn({ threadId, turnId, text: trimmed })
      return true
    } catch (error) {
      addSystemItem(`Could not add guidance to the active turn: ${(error as Error).message}`, 'error')
      return false
    }
  }

  const handleSelectModel = (model: string): void => {
    setSelectedModel(model)
    window.localStorage.setItem(modelStorageKey, model)
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
    const previousThreadId = activeThreadIdRef.current

    setIsThreadMenuOpen(false)
    resumeGenerationRef.current += 1
    watchThreadIdRef.current = null
    persistLastThreadId(null)
    setActiveThreadId(null)
    setActiveThreadTitle('New Chat')
    setActiveTurnId(null)
    activeTurnIdRef.current = null
    userRequestedTurnIdRef.current = null
    setActiveGoal(null)
    activeGoalRef.current = null
    setActiveReasoningEffort(null)
    activeReasoningEffortRef.current = null
    setItems([])
    setItemMeta({})
    setTurnMeta({})
    precedingModelInputByTurnRef.current.clear()
    pendingCompactionByTurnRef.current.clear()

    if (previousThreadId) {
      void window.api.codex.unsubscribeThread(previousThreadId).catch(() => {})
    }
  }

  const handleResumeThread = async (threadId: string): Promise<void> => {
    setIsThreadMenuOpen(false)
    await resumeThreadById(threadId)
  }

  async function resumeThreadById(
    threadId: string,
    options: { silent?: boolean } = {}
  ): Promise<void> {
    const generation = ++resumeGenerationRef.current
    const previousThreadId = activeThreadIdRef.current

    setActiveGoal(null)
    activeGoalRef.current = null
    setActiveReasoningEffort(null)
    activeReasoningEffortRef.current = null

    if (previousThreadId && previousThreadId !== threadId) {
      void window.api.codex.unsubscribeThread(previousThreadId).catch(() => {})
    }

    watchThreadIdRef.current = threadId

    try {
      const resumed = await window.api.codex.resumeThread(threadId)

      if (generation !== resumeGenerationRef.current) {
        return
      }

      const environment = {
        model: resumed.model,
        workspace: resumed.cwd,
        reasoningEffort: resumed.reasoningEffort
      }
      setActiveReasoningEffort(resumed.reasoningEffort)
      activeReasoningEffortRef.current = resumed.reasoningEffort
      hydrateThread(resumed.thread, resumed.initialTurnsPage?.data, environment)

      if (resumed.thread.turns.length === 0 && !resumed.initialTurnsPage?.data?.length) {
        const read = await window.api.codex.readThread(threadId)

        if (generation !== resumeGenerationRef.current) {
          return
        }

        hydrateThread(read.thread, undefined, environment)
      }

      try {
        const goal = await window.api.codex.getGoal(threadId)
        if (generation !== resumeGenerationRef.current) return
        setActiveGoal(goal)
        activeGoalRef.current = goal
      } catch (error) {
        console.warn('Failed to restore thread goal', error)
      }

      persistLastThreadId(threadId)
    } catch (error) {
      if (generation !== resumeGenerationRef.current) {
        return
      }

      watchThreadIdRef.current = activeThreadIdRef.current

      if (!options.silent) {
        addSystemItem(`Thread resume failed: ${(error as Error).message}`, 'error')
      } else {
        persistLastThreadId(null)
      }
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

  async function ensureThreadForGoal(): Promise<string> {
    const existingThreadId = activeThreadIdRef.current
    if (existingThreadId) return existingThreadId

    const started = await window.api.codex.startThread({
      cwd: workspaceRef.current,
      model: selectedModelRef.current
    })
    const threadId = started.thread.id
    watchThreadIdRef.current = threadId
    setActiveThreadId(threadId)
    setActiveThreadTitle(threadTitle(started.thread))
    setActiveReasoningEffort(started.reasoningEffort)
    activeReasoningEffortRef.current = started.reasoningEffort
    persistLastThreadId(threadId)
    return threadId
  }

  async function handleSaveGoal(objective: string, tokenBudget: number | null): Promise<boolean> {
    const trimmed = objective.trim()
    if (!trimmed || activeTurnIdRef.current || isGoalUpdating) return false

    setIsGoalUpdating(true)
    try {
      const threadId = await ensureThreadForGoal()
      const goal = await window.api.codex.setGoal({
        threadId,
        objective: trimmed,
        status: 'active',
        tokenBudget
      })
      setActiveGoal(goal)
      activeGoalRef.current = goal
      return true
    } catch (error) {
      addSystemItem(`Goal update failed: ${(error as Error).message}`, 'error')
      return false
    } finally {
      setIsGoalUpdating(false)
    }
  }

  async function handleSetGoalStatus(status: Extract<ThreadGoalStatus, 'active' | 'paused'>): Promise<void> {
    const threadId = activeThreadIdRef.current
    if (!threadId || !activeGoalRef.current || activeTurnIdRef.current || isGoalUpdating) return

    setIsGoalUpdating(true)
    try {
      const goal = await window.api.codex.setGoal({ threadId, status })
      setActiveGoal(goal)
      activeGoalRef.current = goal
    } catch (error) {
      addSystemItem(`Goal status update failed: ${(error as Error).message}`, 'error')
    } finally {
      setIsGoalUpdating(false)
    }
  }

  async function handleClearGoal(): Promise<void> {
    const threadId = activeThreadIdRef.current
    if (!threadId || !activeGoalRef.current || activeTurnIdRef.current || isGoalUpdating) return

    setIsGoalUpdating(true)
    try {
      await window.api.codex.clearGoal(threadId)
      setActiveGoal(null)
      activeGoalRef.current = null
    } catch (error) {
      addSystemItem(`Goal clear failed: ${(error as Error).message}`, 'error')
    } finally {
      setIsGoalUpdating(false)
    }
  }

  const hasThreadContent = items.length > 0

  function isRelevantThread(incomingThreadId: string): boolean {
    const watched = watchThreadIdRef.current ?? activeThreadIdRef.current
    return watched !== null && incomingThreadId === watched
  }

  function cancelAutoRecovery(): void {
    const state = autoRecoveryRef.current
    if (state?.timer !== null && state?.timer !== undefined) {
      window.clearTimeout(state.timer)
    }
    autoRecoveryRef.current = null
  }

  function currentModelSlug(): string | null {
    return (
      selectedModelRef.current ??
      modelsRef.current.find((model) => model.isDefault)?.model ??
      null
    )
  }

  // Next visible catalog entry after the current model, wrapping around. Falls
  // back to the current model when the catalog has nothing else to offer.
  function pickFallbackModel(currentModel: string | null): string | null {
    const catalog = modelsRef.current.filter((model) => !model.hidden)
    if (!catalog.length) return currentModel
    const index = catalog.findIndex((model) => model.model === currentModel)
    const next = catalog[(index + 1) % catalog.length]
    return next.model === currentModel ? currentModel : next.model
  }

  function maybeScheduleAutoRecovery(threadId: string, turnId: string, error: TurnError | null): void {
    if (!error || !isRecoverableTurnError(error.codexErrorInfo)) return

    const existing = autoRecoveryRef.current?.threadId === threadId ? autoRecoveryRef.current : null
    if (existing?.handledTurnIds.has(turnId)) return

    const state: AutoRecoveryState = existing ?? {
      threadId,
      attempts: 0,
      handledTurnIds: new Set<string>(),
      timer: null
    }
    state.handledTurnIds.add(turnId)
    autoRecoveryRef.current = state

    if (state.attempts >= maxAutoRecoveryAttempts) {
      // Keep the state so the duplicate failure event for this turn stays
      // deduped; a user send or a completed turn resets it.
      addSystemItem(
        `Auto-recovery stopped after ${maxAutoRecoveryAttempts} attempts. Send a message to continue the task.`,
        'error'
      )
      return
    }

    state.attempts += 1
    const currentModel = currentModelSlug()
    // First retry stays on the picked model (overload is often transient);
    // later attempts walk the catalog.
    const nextModel = state.attempts === 1 ? currentModel : pickFallbackModel(currentModel)
    const switching = nextModel !== null && nextModel !== currentModel
    const delaySeconds = Math.round(autoRecoveryDelayMs / 1000)
    addSystemItem(
      switching
        ? `${currentModel ?? 'The model'} is under heavy load — continuing on ${nextModel} in ${delaySeconds}s (attempt ${state.attempts}/${maxAutoRecoveryAttempts}).`
        : `The model is under heavy load — retrying in ${delaySeconds}s (attempt ${state.attempts}/${maxAutoRecoveryAttempts}).`,
      'warning'
    )
    state.timer = window.setTimeout(() => {
      state.timer = null
      void runAutoRecovery(threadId, nextModel)
    }, autoRecoveryDelayMs)
  }

  async function runAutoRecovery(threadId: string, model: string | null): Promise<void> {
    // Bail silently if the recovery was cancelled or the user took over
    // (sent a message, started a turn, or switched threads) while waiting.
    if (autoRecoveryRef.current?.threadId !== threadId) return
    if (activeTurnIdRef.current || userTurnRequestPendingRef.current) return
    if (activeThreadIdRef.current !== threadId) return

    if (model && model !== selectedModelRef.current) {
      selectedModelRef.current = model
      setSelectedModel(model)
      window.localStorage.setItem(modelStorageKey, model)
    }

    try {
      // Turn bookkeeping (active turn id, telemetry, items) happens in the
      // `turn/started` notification handler, same as goal-continuation turns.
      await window.api.codex.sendMessage({
        threadId,
        text: autoRecoveryPrompt,
        cwd: workspaceRef.current,
        model
      })
    } catch (error) {
      addSystemItem(`Auto-recovery could not restart the turn: ${(error as Error).message}`, 'error')
      cancelAutoRecovery()
    }
  }

  function handleCodexNotification(notification: ServerNotification): void {
    const currentThreadId = activeThreadIdRef.current

    switch (notification.method) {
      case 'thread/started':
        watchThreadIdRef.current = notification.params.thread.id
        persistLastThreadId(notification.params.thread.id)
        setActiveThreadId(notification.params.thread.id)
        setActiveThreadTitle(threadTitle(notification.params.thread))
        return
      case 'thread/goal/updated':
        if (isRelevantThread(notification.params.threadId)) {
          const goal = cloneGoal(notification.params.goal)
          setActiveGoal(goal)
          activeGoalRef.current = goal
          if (notification.params.turnId) {
            noteTurn(notification.params.turnId, { goalAtEnd: goal })
          }
        }
        return
      case 'thread/goal/cleared':
        if (isRelevantThread(notification.params.threadId)) {
          setActiveGoal(null)
          activeGoalRef.current = null
          const turnId = activeTurnIdRef.current
          if (turnId) noteTurn(turnId, { goalAtEnd: null })
        }
        return
      case 'thread/name/updated':
        if (notification.params.threadId === currentThreadId) {
          setActiveThreadTitle(notification.params.threadName || 'New Chat')
        }
        void refreshThreads()
        return
      case 'thread/archived':
      case 'thread/deleted':
      case 'thread/closed':
        removeThreadFromList(notification.params.threadId)
        return
      case 'turn/started':
        if (!watchThreadIdRef.current && !activeThreadIdRef.current) {
          watchThreadIdRef.current = notification.params.threadId
          persistLastThreadId(notification.params.threadId)
        }

        if (isRelevantThread(notification.params.threadId)) {
          const turn = notification.params.turn
          const goalSnapshot = cloneGoal(activeGoalRef.current)
          const userInitiated = userTurnRequestPendingRef.current || userRequestedTurnIdRef.current === turn.id
          if (userRequestedTurnIdRef.current === turn.id) userRequestedTurnIdRef.current = null
          const goalContinuation = goalSnapshot?.status === 'active' && !userInitiated
          setActiveThreadId(notification.params.threadId)
          setActiveTurnId(turn.id)
          activeTurnIdRef.current = turn.id
          noteTurn(turn.id, {
            status: 'inProgress',
            origin: 'live',
            requestedModel: selectedModelRef.current,
            model: selectedModelRef.current,
            reasoningEffort: activeReasoningEffortRef.current,
            workspace: workspaceRef.current,
            goalAtStart: goalSnapshot,
            goalAtEnd: goalSnapshot,
            goalContinuation,
            goalContinuationInferred: goalContinuation,
            startedAtMs: turn.startedAt ? turn.startedAt * 1000 : Date.now()
          })
          for (const item of turn.items) rememberModelCallInput(turn.id, item)
          adoptTurnItems(turn.id, turn.items)
          mergeItems(turn.items)
        }
        return
      case 'turn/completed':
        if (isRelevantThread(notification.params.threadId)) {
          const turn = notification.params.turn
          adoptTurnItems(turn.id, turn.items)
          mergeItems(turn.items)
          noteTurn(turn.id, {
            status: turn.status === 'inProgress' ? 'completed' : turn.status,
            completedAtMs: turn.completedAt ? turn.completedAt * 1000 : Date.now(),
            durationMs: turn.durationMs ?? undefined,
            errorMessage: turn.error?.message,
            goalAtEnd: cloneGoal(activeGoalRef.current)
          })
          if (activeTurnIdRef.current === turn.id) activeTurnIdRef.current = null
          setActiveTurnId((current) => (current === turn.id ? null : current))
          if (turn.status === 'failed') {
            maybeScheduleAutoRecovery(notification.params.threadId, turn.id, turn.error)
          } else {
            // The thread produced a healthy terminal turn (completed, or the
            // user interrupted), so any recovery chain is over.
            cancelAutoRecovery()
          }
        }
        void refreshThreads()
        return
      case 'item/started':
        if (isRelevantThread(notification.params.threadId)) {
          rememberModelCallInput(notification.params.turnId, notification.params.item)
          noteItem(notification.params.item.id, notification.params.turnId, {
            startedAtMs: notification.params.startedAtMs
          })
          upsertItem(notification.params.item)
        }
        return
      case 'item/completed':
        if (isRelevantThread(notification.params.threadId)) {
          rememberModelCallInput(notification.params.turnId, notification.params.item)
          noteItem(notification.params.item.id, notification.params.turnId, {
            completedAtMs: notification.params.completedAtMs
          })
          upsertItem(notification.params.item)
        }
        return
      case 'item/agentMessage/delta':
        if (isRelevantThread(notification.params.threadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchItemText(notification.params.itemId, notification.params.delta, 'agentMessage')
        }
        return
      case 'item/commandExecution/outputDelta':
        if (isRelevantThread(notification.params.threadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchCommandOutput(notification.params.itemId, notification.params.delta)
        }
        return
      case 'item/fileChange/patchUpdated':
        if (isRelevantThread(notification.params.threadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchFileChanges(notification.params.itemId, notification.params.changes)
        }
        return
      case 'item/mcpToolCall/progress':
        if (isRelevantThread(notification.params.threadId)) {
          noteItemProgress(
            notification.params.itemId,
            notification.params.turnId,
            notification.params.message
          )
        }
        return
      case 'thread/tokenUsage/updated':
        if (isRelevantThread(notification.params.threadId)) {
          setTurnMeta((current) => {
            const existing = current[notification.params.turnId]?.tokens
            const isNewCall = existing
              ? notification.params.tokenUsage.total.totalTokens > existing.threadTotalAtEnd.totalTokens
              : notification.params.tokenUsage.last.totalTokens > 0
            const compactedBeforeCall = isNewCall
              ? pendingCompactionByTurnRef.current.delete(notification.params.turnId)
              : false

            return reduceTurnTelemetry(current, {
              type: 'tokenUsage',
              turnId: notification.params.turnId,
              tokenUsage: notification.params.tokenUsage,
              atMs: Date.now(),
              precedingItem: precedingModelInputByTurnRef.current.get(notification.params.turnId) ?? null,
              compactedBeforeCall
            })
          })
        }
        return
      case 'model/rerouted':
        if (isRelevantThread(notification.params.threadId)) {
          setTurnMeta((current) => reduceTurnTelemetry(current, {
            type: 'modelRerouted',
            turnId: notification.params.turnId,
            atMs: Date.now(),
            fromModel: notification.params.fromModel,
            toModel: notification.params.toModel,
            reason: notification.params.reason
          }))
        }
        return
      case 'turn/diff/updated':
        if (isRelevantThread(notification.params.threadId)) {
          noteTurn(notification.params.turnId, {
            diffSummary: summarizeTurnDiff(notification.params.diff)
          })
        }
        return
      case 'item/reasoning/summaryTextDelta':
        if (isRelevantThread(notification.params.threadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchReasoningPart(notification.params.itemId, 'summary', notification.params.summaryIndex, notification.params.delta)
        }
        return
      case 'item/reasoning/summaryPartAdded':
        if (isRelevantThread(notification.params.threadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchReasoningPart(notification.params.itemId, 'summary', notification.params.summaryIndex, '')
        }
        return
      case 'item/reasoning/textDelta':
        if (isRelevantThread(notification.params.threadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchReasoningPart(notification.params.itemId, 'content', notification.params.contentIndex, notification.params.delta)
        }
        return
      case 'item/plan/delta':
        if (isRelevantThread(notification.params.threadId)) {
          noteItem(notification.params.itemId, notification.params.turnId)
          patchPlan(notification.params.itemId, notification.params.delta)
        }
        return
      case 'turn/plan/updated':
        if (isRelevantThread(notification.params.threadId)) {
          upsertTurnPlan(notification.params.turnId, notification.params.explanation, notification.params.plan)
        }
        return
      case 'error':
        if (isRelevantThread(notification.params.threadId)) {
          setTurnMeta((current) => reduceTurnTelemetry(current, {
            type: 'error',
            turnId: notification.params.turnId,
            atMs: Date.now(),
            message: notification.params.error.message,
            willRetry: notification.params.willRetry
          }))

          if (!notification.params.willRetry) {
            addSystemItem(notification.params.error.message, 'error')
            if (activeTurnIdRef.current === notification.params.turnId) activeTurnIdRef.current = null
            setActiveTurnId((current) =>
              current === notification.params.turnId ? null : current
            )
          }
        }
        return
      case 'warning':
        if (!notification.params.threadId || isRelevantThread(notification.params.threadId)) {
          addSystemItem(notification.params.message, 'warning')
        }
        return
      default:
        return
    }
  }

  function mergeItems(nextItems: ThreadItem[]): void {
    flushPendingItemMutations()
    setItems((current) => upsertMany(current, nextItems))
  }

  // Record lifecycle metadata for an item. The incoming turnId wins when
  // present; existing fields survive partial updates.
  function noteItem(itemId: string, turnId: string | null, patch: Partial<ItemMeta> = {}): void {
    setItemMeta((current) => {
      const existing = current[itemId]
      const nextItem = {
        ...existing,
        ...patch,
        turnId: turnId ?? existing?.turnId ?? null
      }

      if (
        existing &&
        Object.keys(nextItem).every((key) =>
          Object.is(existing[key as keyof ItemMeta], nextItem[key as keyof ItemMeta])
        )
      ) {
        return current
      }

      return {
        ...current,
        [itemId]: nextItem
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
    setTurnMeta((current) => reduceTurnTelemetry(current, { type: 'patch', turnId, patch }))
  }

  function rememberModelCallInput(turnId: string, item: ThreadItem): void {
    if (item.type === 'contextCompaction') {
      pendingCompactionByTurnRef.current.add(turnId)
      return
    }

    const attribution = modelCallAttributionForItem(item)
    if (attribution) precedingModelInputByTurnRef.current.set(turnId, attribution)
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

  function removeThreadFromList(threadId: string): void {
    setThreads((current) => current.filter((thread) => thread.id !== threadId))

    if (window.localStorage.getItem(lastThreadStorageKey) === threadId) {
      persistLastThreadId(null)
    }
  }

  async function refreshThreads(options: { append?: boolean } = {}): Promise<void> {
    const cursor = options.append ? threadsNextCursorRef.current : null

    try {
      setThreadsLoading(true)

      if (!options.append) {
        setThreadsError(null)
      }

      const response = await window.api.codex.listThreads({
        cwd: workspace,
        cursor
      })

      setThreads((current) => (options.append ? [...current, ...response.data] : response.data))
      setThreadsNextCursor(response.nextCursor)
    } catch (error) {
      if (!options.append) {
        setThreadsError((error as Error).message)
      }
    } finally {
      setThreadsLoading(false)
    }
  }

  async function loadMoreThreads(): Promise<void> {
    if (!threadsNextCursorRef.current || threadsLoading) {
      return
    }

    await refreshThreads({ append: true })
  }

  function hydrateThread(
    thread: Thread,
    fallbackTurns?: Turn[],
    environment?: {
      model: string | null
      workspace: string | null
      reasoningEffort: ReasoningEffort | null
    }
  ): void {
    const turns = thread.turns.length > 0 ? thread.turns : (fallbackTurns ?? [])

    precedingModelInputByTurnRef.current.clear()
    pendingCompactionByTurnRef.current.clear()

    watchThreadIdRef.current = thread.id
    setActiveThreadId(thread.id)
    setActiveThreadTitle(threadTitle(thread))
    const inProgressTurnId = turns.find((turn) => turn.status === 'inProgress')?.id ?? null
    setActiveTurnId(inProgressTurnId)
    activeTurnIdRef.current = inProgressTurnId

    const nextItems: ChatItem[] = []
    const nextItemMeta: Record<string, ItemMeta> = {}
    const nextTurnMeta: Record<string, TurnMeta> = {}

    for (const turn of turns) {
      nextTurnMeta[turn.id] = {
        status: turn.status,
        origin: 'restored',
        model: environment?.model ?? null,
        reasoningEffort: environment?.reasoningEffort ?? null,
        workspace: environment?.workspace ?? thread.cwd,
        startedAtMs: turn.startedAt ? turn.startedAt * 1000 : undefined,
        completedAtMs: turn.completedAt ? turn.completedAt * 1000 : undefined,
        durationMs: turn.durationMs ?? undefined,
        errorMessage: turn.error?.message
      }
      for (const item of turn.items) {
        if (turn.status === 'inProgress') rememberModelCallInput(turn.id, item)
        nextItemMeta[item.id] = { turnId: turn.id }
        nextItems.push(item)
      }
    }

    setItems(nextItems)
    setItemMeta(nextItemMeta)
    setTurnMeta(nextTurnMeta)
  }

  function upsertItem(item: ThreadItem): void {
    flushPendingItemMutations()
    setItems((current) => upsertMany(current, [item]))
  }

  // Queue a streaming mutation and schedule a single batched apply. Every delta
  // kind funnels through here so a burst of reasoning/command/text tokens
  // collapses into one setItems (one buildRows + one render) per ~32ms frame
  // instead of one per token. A 32ms batch still reads as continuous.
  function enqueueItemMutation(mutate: (items: ChatItem[]) => ChatItem[]): void {
    pendingItemMutationsRef.current.push(mutate)

    if (itemMutationTimerRef.current !== null) {
      return
    }

    itemMutationTimerRef.current = window.setTimeout(() => {
      itemMutationTimerRef.current = null
      flushPendingItemMutations()
    }, 32)
  }

  // Apply every queued mutation in order in a single state update. Ordering is
  // preserved (mutations run in enqueue order), so this is safe to call ahead of
  // a full-item upsert to keep pending deltas from landing after their item.
  function flushPendingItemMutations(): void {
    const pending = pendingItemMutationsRef.current

    if (!pending.length) {
      return
    }

    if (itemMutationTimerRef.current !== null) {
      window.clearTimeout(itemMutationTimerRef.current)
      itemMutationTimerRef.current = null
    }

    pendingItemMutationsRef.current = []
    setItems((current) => {
      let next = current
      for (const mutate of pending) {
        next = mutate(next)
      }
      return next
    })
  }

  function patchItemText(itemId: string, delta: string, fallbackType: 'agentMessage'): void {
    enqueueItemMutation((current) => {
      const index = current.findIndex((item) => item.id === itemId)

      if (index === -1) {
        return [...current, { type: fallbackType, id: itemId, text: delta, phase: null, memoryCitation: null }]
      }

      return current.map((item) =>
        item.id === itemId && item.type === 'agentMessage'
          ? { ...item, text: `${item.text}${delta}` }
          : item
      )
    })
  }

  function patchCommandOutput(itemId: string, delta: string): void {
    enqueueItemMutation((current) =>
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
    enqueueItemMutation((current) => {
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
    enqueueItemMutation((current) => {
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
    enqueueItemMutation((current) => {
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
          isRestoring={isRestoring}
          threads={threads}
          activeThreadId={activeThreadId}
          activeTurnId={activeTurnId}
          activeGoal={activeGoal}
          isGoalUpdating={isGoalUpdating}
          isThreadMenuOpen={isThreadMenuOpen}
          threadsNextCursor={threadsNextCursor}
          threadsLoading={threadsLoading}
          threadsError={threadsError}
          hasThreadContent={hasThreadContent}
          isBusy={isRestoring || isSending || Boolean(activeTurnId)}
          workspace={workspace}
          models={models}
          selectedModel={selectedModel}
          onSelectModel={handleSelectModel}
          onSend={handleSend}
          onSteer={handleSteer}
          onStop={handleStop}
          onNewThread={handleNewThread}
          onToggleThreadMenu={() => setIsThreadMenuOpen((open) => !open)}
          onResumeThread={handleResumeThread}
          onLoadMoreThreads={loadMoreThreads}
          onPickWorkspace={handlePickWorkspace}
          onSaveGoal={handleSaveGoal}
          onSetGoalStatus={handleSetGoalStatus}
          onClearGoal={handleClearGoal}
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

function TitleBar(): React.JSX.Element {
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
  isRestoring,
  threads,
  activeThreadId,
  activeTurnId,
  activeGoal,
  isGoalUpdating,
  isThreadMenuOpen,
  threadsNextCursor,
  threadsLoading,
  threadsError,
  hasThreadContent,
  isBusy,
  workspace,
  models,
  selectedModel,
  onSelectModel,
  onSend,
  onSteer,
  onStop,
  onNewThread,
  onToggleThreadMenu,
  onResumeThread,
  onLoadMoreThreads,
  onPickWorkspace,
  onSaveGoal,
  onSetGoalStatus,
  onClearGoal
}: {
  items: ChatItem[]
  itemMeta: Record<string, ItemMeta>
  turnMeta: Record<string, TurnMeta>
  title: string
  status: string
  isRestoring: boolean
  threads: Thread[]
  activeThreadId: string | null
  activeTurnId: string | null
  activeGoal: ThreadGoal | null
  isGoalUpdating: boolean
  isThreadMenuOpen: boolean
  threadsNextCursor: string | null
  threadsLoading: boolean
  threadsError: string | null
  hasThreadContent: boolean
  isBusy: boolean
  workspace: string | null
  models: Model[]
  selectedModel: string | null
  onSelectModel: (model: string) => void
  onSend: (text: string) => Promise<boolean>
  onSteer: (text: string) => Promise<boolean>
  onStop: () => Promise<void>
  onNewThread: () => void
  onToggleThreadMenu: () => void
  onResumeThread: (threadId: string) => Promise<void>
  onLoadMoreThreads: () => Promise<void>
  onPickWorkspace: () => Promise<void>
  onSaveGoal: (objective: string, tokenBudget: number | null) => Promise<boolean>
  onSetGoalStatus: (status: Extract<ThreadGoalStatus, 'active' | 'paused'>) => Promise<void>
  onClearGoal: () => Promise<void>
}): React.JSX.Element {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [traceTurnId, setTraceTurnId] = useState<string | null>(null)
  const [storedTrace, setStoredTrace] = useState<TurnTrace | null>(null)
  const traceLoadGenerationRef = useRef(0)
  const { rows, turnWork } = useMemo(
    () => buildRows(items, itemMeta, activeTurnId),
    [items, itemMeta, activeTurnId]
  )
  const currentTrace = useMemo(
    () => traceTurnId
      ? buildTurnTrace({
          threadId: activeThreadId,
          threadTitle: title,
          turnId: traceTurnId,
          model: selectedModel,
          workspace,
          items,
          itemMeta,
          meta: turnMeta[traceTurnId]
        })
      : null,
    [traceTurnId, activeThreadId, title, selectedModel, workspace, items, itemMeta, turnMeta]
  )
  const trace = storedTrace?.turn.id === traceTurnId ? storedTrace : currentTrace

  function openTrace(turnId: string): void {
    const generation = ++traceLoadGenerationRef.current
    setTraceTurnId(turnId)
    setStoredTrace(null)

    if (!activeThreadId || turnMeta[turnId]?.origin !== 'restored') return

    void window.api.trace.load({ threadId: activeThreadId, turnId }).then((content) => {
      if (generation !== traceLoadGenerationRef.current || !content) return

      try {
        const parsed: unknown = JSON.parse(content)
        if (isTurnTrace(parsed) && parsed.turn.id === turnId) setStoredTrace(parsed)
      } catch (error) {
        console.warn('Failed to load persisted turn trace', error)
      }
    }, (error) => {
      console.warn('Failed to load persisted turn trace', error)
    })
  }

  useEffect(() => {
    traceLoadGenerationRef.current += 1
    setTraceTurnId(null)
    setStoredTrace(null)
  }, [activeThreadId])

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
      if (
        item.type === 'agentMessage' &&
        item.phase !== 'commentary' &&
        !itemMeta[item.id]?.completedAtMs
      ) {
        return item.id
      }
    }
    return null
  }, [items, itemMeta, activeTurnId])

  return (
    <section
      className={`chat-pane ${hasThreadContent ? 'is-thread' : 'is-empty'} ${isRestoring ? 'is-hydrating' : ''}`}
      aria-busy={isRestoring}
    >
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
      </div>

      <ThreadScroll
        resetKey={activeThreadId}
        dependencies={[items, itemMeta, activeTurnId]}
      >
        {isRestoring ? (
          <div className="chat-restore-status" role="status" aria-live="polite">
            <span className="shimmer-text">Restoring conversation…</span>
          </div>
        ) : null}
        {rows.map((row) => {
          if (row.kind === 'activity') {
            return (
              <TaskActivityCard
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
                onOpenTrace={() => openTrace(row.turnId)}
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
          {models.length ? (
            <ModelPill models={models} selectedModel={selectedModel} onSelectModel={onSelectModel} />
          ) : null}
          <GoalControl
            goal={activeGoal}
            disabled={Boolean(activeTurnId) || isGoalUpdating}
            onSave={onSaveGoal}
            onSetStatus={onSetGoalStatus}
            onClear={onClearGoal}
          />
          <div className="composer-thread-controls">
            <ThreadMenu
              placement="composer"
              title={title}
              threads={threads}
              activeThreadId={activeThreadId}
              isOpen={isThreadMenuOpen}
              threadsNextCursor={threadsNextCursor}
              threadsLoading={threadsLoading}
              threadsError={threadsError}
              onToggle={onToggleThreadMenu}
              onResumeThread={onResumeThread}
              onLoadMoreThreads={onLoadMoreThreads}
            />
            <button
              type="button"
              className="icon-button composer-new-chat"
              aria-label="New chat"
              title="New chat"
              onClick={onNewThread}
            >
              <NewChatIcon />
            </button>
          </div>
        </div>
        <Composer
          docked={hasThreadContent}
          isLoading={isRestoring || isBusy && !activeTurnId}
          isTurnActive={Boolean(activeTurnId)}
          status={isRestoring ? 'Restoring conversation' : activeTurnId ? 'Working' : status}
          onSend={onSend}
          onSteer={onSteer}
          onStop={onStop}
        />
      </div>

      {isSettingsOpen ? (
        <SettingsModal
          onClose={() => setIsSettingsOpen(false)}
        />
      ) : null}
      {trace ? <TraceModal trace={trace} onClose={() => {
        traceLoadGenerationRef.current += 1
        setTraceTurnId(null)
        setStoredTrace(null)
      }} /> : null}
    </section>
  )
}

function TaskActivityCard({
  items,
  itemMeta,
  live,
  workspace
}: {
  items: ActivityItem[]
  itemMeta: Record<string, ItemMeta>
  live: boolean
  workspace: string | null
}): React.JSX.Element {
  let newestWorkItemId: string | undefined
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (isWorkItem(items[i])) {
      newestWorkItemId = items[i].id
      break
    }
  }
  const newestActivityId = items[items.length - 1]?.id
  const content: React.JSX.Element[] = []
  let workRun: WorkItem[] = []

  const flushWork = (): void => {
    if (!workRun.length) {
      return
    }
    const first = workRun[0]
    content.push(
      <WorkGroup
        key={`work-${first.id}`}
        items={workRun}
        itemMeta={itemMeta}
        live={live}
        workspace={workspace}
        newestItemId={newestWorkItemId}
      />
    )
    workRun = []
  }

  for (const item of items) {
    if (isWorkItem(item)) {
      workRun.push(item)
      continue
    }

    flushWork()
    content.push(
      <div
        className={`task-activity-message ${live && item.id === newestActivityId && !itemMeta[item.id]?.completedAtMs ? 'is-streaming' : ''}`}
        key={item.id}
      >
        <MarkdownContent text={item.text || ' '} />
      </div>
    )
  }
  flushWork()

  return (
    <section className="task-activity-card" aria-label="In-task activity" aria-live={live ? 'polite' : 'off'}>
      <AutoFollow className="task-activity-card-scroll">
        <div className="task-activity-card-content">{content}</div>
      </AutoFollow>
    </section>
  )
}

// The thread selector opens a searchable recent-thread popover. In the chat
// composer it opens upward so history stays near the user's current workflow.
function ThreadMenu({
  placement = 'toolbar',
  title,
  threads,
  activeThreadId,
  isOpen,
  threadsNextCursor,
  threadsLoading,
  threadsError,
  onToggle,
  onResumeThread,
  onLoadMoreThreads
}: {
  placement?: 'toolbar' | 'composer'
  title: string
  threads: Thread[]
  activeThreadId: string | null
  isOpen: boolean
  threadsNextCursor: string | null
  threadsLoading: boolean
  threadsError: string | null
  onToggle: () => void
  onResumeThread: (threadId: string) => Promise<void>
  onLoadMoreThreads: () => Promise<void>
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  // Highlighted row for keyboard/hover navigation. `null` is the resting state;
  // `0..n` indexes the flat, filtered thread list.
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

  const handleKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onToggle()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => {
        if (!flatIds.length) return null
        return index === null ? 0 : Math.min(index + 1, flatIds.length - 1)
      })
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => {
        if (!flatIds.length) return null
        return index === null ? flatIds.length - 1 : Math.max(index - 1, 0)
      })
      return
    }
    if (event.key === 'Enter') {
      // With nothing highlighted, let Enter fall through (no-op here).
      if (activeIndex === null) {
        return
      }
      event.preventDefault()
      if (flatIds[activeIndex]) {
        resume(flatIds[activeIndex])
      }
    }
  }

  return (
    <div ref={wrapRef} className={`thread-select-wrap is-${placement}`}>
      <button
        type="button"
        className={`thread-select ${isOpen ? 'is-open' : ''}`}
        aria-label={placement === 'composer' ? 'Chat history' : 'Open thread menu'}
        title={placement === 'composer' ? 'Chat history' : undefined}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        {placement === 'composer' ? (
          <ChatBubbleIcon />
        ) : (
          <span className="thread-title">{stripSkillMarkerFromTitle(title)}</span>
        )}
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
                setActiveIndex(null)
              }}
            />
          </div>

          <div className="thread-menu-scroll">
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
                {query
                  ? `No chats matching “${query.trim()}”`
                  : threadsError
                    ? `Could not load chats: ${threadsError}`
                    : 'No chats yet'}
              </div>
            )}

            {threadsError && flatIds.length ? (
              <div className="thread-menu-status thread-menu-status-error">{threadsError}</div>
            ) : null}

            {threadsNextCursor && !query ? (
              <button
                type="button"
                className="thread-menu-load-more"
                disabled={threadsLoading}
                onClick={() => void onLoadMoreThreads()}
              >
                {threadsLoading ? 'Loading…' : 'Load more chats'}
              </button>
            ) : null}
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

function SearchIcon(): React.JSX.Element {
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

function ChatBubbleIcon(): React.JSX.Element {
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

function FolderIcon(): React.JSX.Element {
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

function SettingsIcon(): React.JSX.Element {
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

function NewChatIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4.5" y="4.5" width="15" height="15" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 8.5v7M8.5 12h7"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}

function SettingsModal({
  onClose
}: {
  onClose: () => void
}): React.JSX.Element {
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
  dependencies,
  resetKey
}: {
  children: React.ReactNode
  dependencies: unknown[]
  resetKey: string | null
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const frameRef = useRef<number | null>(null)
  const settleFrameRef = useRef<number | null>(null)

  const cancelScheduledFollow = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    if (settleFrameRef.current !== null) {
      window.cancelAnimationFrame(settleFrameRef.current)
      settleFrameRef.current = null
    }
  }, [])

  const followTail = useCallback(() => {
    if (!pinnedRef.current || ref.current === null || frameRef.current !== null) {
      return
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      const el = ref.current

      if (!el || !pinnedRef.current) {
        return
      }

      const target = Math.max(0, el.scrollHeight - el.clientHeight)
      if (Math.abs(el.scrollTop - target) > 1) {
        el.scrollTop = target
      }

      // Markdown code blocks, font metrics, and live diff rows can settle one
      // layout pass after React commits. A second frame catches that growth
      // without making every stream delta pay for a synchronous measurement.
      if (settleFrameRef.current === null) {
        settleFrameRef.current = window.requestAnimationFrame(() => {
          settleFrameRef.current = null
          const settled = ref.current
          if (settled && pinnedRef.current) {
            const settledTarget = Math.max(0, settled.scrollHeight - settled.clientHeight)
            if (Math.abs(settled.scrollTop - settledTarget) > 1) {
              settled.scrollTop = settledTarget
            }
          }
        })
      }
    })
  }, [])

  const handleScroll = useCallback(() => {
    const el = ref.current
    if (!el) {
      return
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distanceFromBottom <= 48

    // A queued frame from a prior delta must never pull a reader back down
    // after they have deliberately scrolled away from the live edge.
    if (!pinnedRef.current) {
      cancelScheduledFollow()
    }
  }, [cancelScheduledFollow])

  useLayoutEffect(() => {
    // A new thread is a new reading context. Start it at the latest content,
    // even if the previous thread had deliberately released auto-follow.
    cancelScheduledFollow()
    pinnedRef.current = true
    followTail()
  }, [cancelScheduledFollow, followTail, resetKey])

  useLayoutEffect(() => {
    followTail()
    // The caller supplies render-driving state rather than a single scalar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies)

  useEffect(() => {
    const el = ref.current
    const content = contentRef.current

    if (!el || !content) {
      return
    }

    let active = true
    // The `dependencies` layout effect already calls followTail on every React
    // commit (i.e. every batched streaming flush), which covers text growth.
    // The ResizeObserver catches the reflows React does NOT drive — code-block
    // wrapping, diff rows, and font metrics settling a frame after commit. A
    // subtree characterData MutationObserver would fire on every streamed
    // character for no gain over these two, so it is intentionally omitted.
    const resizeObserver = new ResizeObserver(followTail)
    resizeObserver.observe(el)
    resizeObserver.observe(content)

    // Web fonts can reflow existing markdown after the initial commit without
    // producing a React update. Catch that one late layout pass when supported.
    void document.fonts?.ready.then(() => {
      if (active) {
        followTail()
      }
    })

    return () => {
      active = false
      resizeObserver.disconnect()
      cancelScheduledFollow()
    }
  }, [cancelScheduledFollow, followTail])

  return (
    <div ref={ref} className="thread-scroll" onScroll={handleScroll}>
      <div ref={contentRef} className="thread-scroll-content">
        {children}
      </div>
    </div>
  )
}

function stripAutomaticSkillMarker(text: string): string {
  return text.replace(/^\$artifact-first-web-research[ \t]*\r?\n/, '')
}

function stripInjectedMemory(text: string): string {
  return text.replace(
    /^<codexdesktop-prior-chat-memory>[\s\S]*?<\/codexdesktop-prior-chat-memory>\s*Current user request:\s*/,
    ''
  )
}

function completedMemoryTurns(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  turnMeta: Record<string, TurnMeta>
): MemoryPersistParams['turns'] {
  const turns = new Map<string, { user: string; assistant: string; completedWork: string[] }>()

  for (const item of items) {
    if (item.type === 'system') continue
    const turnId = itemMeta[item.id]?.turnId
    if (!turnId || !isTerminalTurnStatus(turnMeta[turnId]?.status)) continue

    const turn = turns.get(turnId) ?? { user: '', assistant: '', completedWork: [] }

    if (item.type === 'userMessage') {
      turn.user = item.content
        .filter((content) => content.type === 'text')
        .map((content) => stripAutomaticSkillMarker(stripInjectedMemory(content.text)))
        .join('\n')
        .trim()
    } else if (item.type === 'agentMessage' && item.phase !== 'commentary') {
      turn.assistant = item.text.trim()
    } else {
      const completedWork = completedWorkSummary(item)
      if (completedWork && !turn.completedWork.includes(completedWork)) {
        turn.completedWork.push(completedWork)
      }
    }

    turns.set(turnId, turn)
  }

  return [...turns.values()]
    .filter((turn) => turn.user && turn.assistant)
    .map((turn) => ({ ...turn, completedWork: selectCompletedWork(turn.completedWork) }))
}

function completedWorkSummary(item: ChatItem): string | null {
  if (item.type === 'commandExecution' && item.status !== 'inProgress') {
    const outcome = item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null)
      ? commandTestOutcome(item.aggregatedOutput) ?? 'Command succeeded'
      : `Command ${item.status}${item.exitCode === null ? '' : ` with exit ${item.exitCode}`}`
    return `${outcome}: ${singleLineClip(item.command, 150)}`
  }

  if (item.type === 'fileChange' && item.status !== 'inProgress') {
    const paths = item.changes.map((change) => change.path).slice(0, 4)
    const omitted = item.changes.length - paths.length
    return `File changes ${item.status}: ${paths.join(', ')}${omitted > 0 ? ` and ${omitted} more` : ''}`
  }

  if (item.type === 'dynamicToolCall' && item.status !== 'inProgress') {
    return `Tool ${item.status}: ${item.tool}`
  }

  if (item.type === 'mcpToolCall' && item.status !== 'inProgress') {
    return `Tool ${item.status}: ${item.server}/${item.tool}`
  }

  return null
}

function commandTestOutcome(output: string | null): string | null {
  if (!output) return null
  const tests = output.match(/(?:^|\n)[^\n]*tests\s+(\d+)/i)?.[1]
  const passed = output.match(/(?:^|\n)[^\n]*pass\s+(\d+)/i)?.[1]
  const failed = output.match(/(?:^|\n)[^\n]*fail\s+(\d+)/i)?.[1]
  if (!tests || !passed || failed === undefined) return null
  return `${passed}/${tests} tests passed, ${failed} failed`
}

function singleLineClip(value: string, maxChars: number): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > maxChars ? `${line.slice(0, maxChars).trimEnd()}…` : line
}

const ChatItemView = memo(function ChatItemView({ item, streaming }: { item: ChatItem; streaming: boolean }): React.JSX.Element | null {
  if (item.type === 'system') {
    return <article className={`message message-system message-system-${item.level}`}>{item.text}</article>
  }

  if (item.type === 'userMessage') {
    const text = item.content
      .filter((content) => content.type === 'text')
      .map((content) => stripAutomaticSkillMarker(stripInjectedMemory(content.text)))
      .join('\n')

    return (
      <article className="message message-user">
        <p>{text}</p>
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
})

const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming,
  commentary
}: {
  text: string
  streaming: boolean
  commentary: boolean
}): React.JSX.Element {
  return (
    <article
      className={`message message-assistant ${commentary ? 'message-commentary' : ''} ${
        streaming ? 'is-streaming' : ''
      }`}
    >
      <MarkdownContent text={text || ' '} />
    </article>
  )
})

type ChartDatum = {
  label: string
  value: number
  color?: string
}

type ChartConfig = {
  type?: 'bar' | 'line' | 'horizontal-bar'
  title?: string
  description?: string
  unit?: string
  color?: string
  data?: ChartDatum[]
  labels?: string[]
  values?: number[]
}

const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="markdown-title">{children}</h1>,
  h2: ({ children }) => <h2 className="markdown-section-title">{children}</h2>,
  h3: ({ children }) => <h3 className="markdown-subtitle">{children}</h3>,
  table: ({ children }) => (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  blockquote: ({ children }) => <blockquote className="markdown-quote">{children}</blockquote>,
  hr: () => <hr className="markdown-rule" />,
  a: ({ children, href }) => (
    <a
      href={href}
      onClick={(event) => {
        if (!href || !/^https?:\/\//i.test(href)) return
        event.preventDefault()
        void window.api.browser.newTab(href)
      }}
    >
      {children}
    </a>
  ),
  pre: ({ children, ...props }) => {
    const child = Children.toArray(children)[0]
    if (isValidElement(child) && child.type === ChartBlock) {
      return child
    }
    return <pre {...props}>{children}</pre>
  },
  code: ({ children, className, ...props }) => {
    const language = className?.match(/language-([\w-]+)/)?.[1]
    const value = String(children).replace(/\n$/, '')

    if ((language === 'chart' || language === 'graph') && parseChartConfig(value)) {
      return <ChartBlock config={parseChartConfig(value)!} />
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  }
}

function parseChartConfig(value: string): ChartConfig | null {
  try {
    const parsed = JSON.parse(value) as ChartConfig
    const data = parsed.data ?? parsed.labels?.map((label, index) => ({
      label,
      value: parsed.values?.[index] ?? 0
    }))

    if (!data?.length || data.some((datum) => !datum.label || !Number.isFinite(datum.value))) {
      return null
    }

    return {
      ...parsed,
      type: parsed.type ?? 'bar',
      data
    }
  } catch {
    return null
  }
}

function ChartBlock({ config }: { config: ChartConfig }): React.JSX.Element {
  const data = config.data ?? []
  const max = Math.max(...data.map((datum) => Math.abs(datum.value)), 1)
  const min = Math.min(...data.map((datum) => datum.value), 0)
  const range = Math.max(max - min, 1)
  const chartType = config.type ?? 'bar'
  const formatValue = (value: number): string => `${value}${config.unit ?? ''}`

  if (chartType === 'line') {
    const points = data
      .map((datum, index) => {
        const x = data.length === 1 ? 50 : (index / (data.length - 1)) * 100
        const y = 100 - ((datum.value - min) / range) * 100
        return `${x},${Math.max(4, Math.min(96, y))}`
      })
      .join(' ')

    return (
      <figure className="markdown-chart" aria-label={config.title ?? 'Line chart'}>
        {config.title ? <figcaption className="markdown-chart-title">{config.title}</figcaption> : null}
        {config.description ? <p className="markdown-chart-description">{config.description}</p> : null}
        <div className="markdown-line-chart">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-hidden="true">
            <path className="markdown-chart-gridline" d="M0 25H100M0 50H100M0 75H100" />
            <polyline className="markdown-chart-line" points={points} />
          </svg>
          <div className="markdown-line-points">
            {data.map((datum, index) => (
              <div className="markdown-line-point" key={`${datum.label}-${index}`}>
                <strong>{formatValue(datum.value)}</strong>
                <span>{datum.label}</span>
              </div>
            ))}
          </div>
        </div>
      </figure>
    )
  }

  return (
    <figure className={`markdown-chart is-${chartType}`} aria-label={config.title ?? 'Bar chart'}>
      {config.title ? <figcaption className="markdown-chart-title">{config.title}</figcaption> : null}
      {config.description ? <p className="markdown-chart-description">{config.description}</p> : null}
      <div className="markdown-bar-chart">
        {data.map((datum, index) => {
          const size = chartType === 'horizontal-bar'
            ? (Math.abs(datum.value) / max) * 100
            : ((datum.value - min) / range) * 100
          return (
            <div className="markdown-bar-item" key={`${datum.label}-${index}`}>
              <div className="markdown-bar-track">
                <div
                  className="markdown-bar-fill"
                  style={{
                    [chartType === 'horizontal-bar' ? 'width' : 'height']: `${Math.max(size, 3)}%`,
                    background: datum.color ?? config.color
                  }}
                >
                  <span>{formatValue(datum.value)}</span>
                </div>
              </div>
              <span className="markdown-bar-label">{datum.label}</span>
            </div>
          )
        })}
      </div>
    </figure>
  )
}

function WorkspacePill({
  workspace,
  onPickWorkspace
}: {
  workspace: string | null
  onPickWorkspace: () => Promise<void>
}): React.JSX.Element {
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

// Composer pill that shows the model turns run on and opens an upward popover
// listing the full `model/list` catalog. Picks persist across restarts and are
// sent as a per-turn override; before the first pick, turns follow the
// CLI-configured default (the entry Codex marks `isDefault`).
function ModelPill({
  models,
  selectedModel,
  onSelectModel
}: {
  models: Model[]
  selectedModel: string | null
  onSelectModel: (model: string) => void
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  const active =
    models.find((model) => model.model === selectedModel) ??
    models.find((model) => model.isDefault) ??
    models[0]

  return (
    <div ref={wrapRef} className="model-pill-wrap">
      <button
        type="button"
        className="workspace-pill"
        title={active ? `${active.displayName} — ${active.description}` : 'Choose model'}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <ModelIcon />
        <span className="workspace-pill-name">{active?.displayName ?? 'Model'}</span>
        <span className="workspace-pill-caret">⌄</span>
      </button>
      {isOpen ? (
        <div className="model-menu" role="menu">
          {models.map((model) => {
            const isActive = model.model === active?.model
            return (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                className={`model-option ${isActive ? 'is-active' : ''}`}
                onClick={() => {
                  onSelectModel(model.model)
                  setIsOpen(false)
                }}
              >
                <span className="model-option-name">
                  {model.displayName}
                  {model.isDefault ? <span className="model-option-badge">CLI default</span> : null}
                </span>
                <span className="model-option-desc">{model.description}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function GoalControl({
  goal,
  disabled,
  onSave,
  onSetStatus,
  onClear
}: {
  goal: ThreadGoal | null
  disabled: boolean
  onSave: (objective: string, tokenBudget: number | null) => Promise<boolean>
  onSetStatus: (status: Extract<ThreadGoalStatus, 'active' | 'paused'>) => Promise<void>
  onClear: () => Promise<void>
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false)
  const [objective, setObjective] = useState(goal?.objective ?? '')
  const [tokenBudget, setTokenBudget] = useState(goal?.tokenBudget ? String(goal.tokenBudget) : '')
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setObjective(goal?.objective ?? '')
    setTokenBudget(goal?.tokenBudget ? String(goal.tokenBudget) : '')
  }, [goal?.objective, goal?.tokenBudget])

  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setIsOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsOpen(false)
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  const submitGoal = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const parsedBudget = tokenBudget.trim() ? Number(tokenBudget) : null
    if (parsedBudget !== null && (!Number.isFinite(parsedBudget) || parsedBudget <= 0)) return

    const saved = await onSave(
      objective,
      parsedBudget === null ? null : Math.floor(parsedBudget)
    )
    if (saved) setIsOpen(false)
  }

  return (
    <div ref={wrapRef} className={`goal-control ${goal ? 'has-goal' : ''}`}>
      <button
        type="button"
        className="workspace-pill goal-pill"
        title={goal?.objective ?? 'Set a thread goal'}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <GoalIcon />
        <span className="workspace-pill-name">{goal ? goalStatusLabel(goal.status) : 'Goal'}</span>
        {goal ? <span className={`goal-status-dot is-${goal.status}`} aria-hidden="true" /> : null}
      </button>
      {isOpen ? (
        <div className="goal-menu" role="dialog" aria-label="Thread goal">
          <form onSubmit={(event) => void submitGoal(event)}>
            <label htmlFor="goal-objective">Objective</label>
            <textarea
              id="goal-objective"
              value={objective}
              rows={4}
              maxLength={1_000}
              disabled={disabled}
              placeholder="What should this thread keep working toward?"
              onChange={(event) => setObjective(event.target.value)}
            />
            <label htmlFor="goal-token-budget">Token budget</label>
            <input
              id="goal-token-budget"
              type="number"
              min="1"
              step="1000"
              value={tokenBudget}
              disabled={disabled}
              placeholder="No limit"
              onChange={(event) => setTokenBudget(event.target.value)}
            />
            {goal ? (
              <p className="goal-usage">
                {goal.tokensUsed.toLocaleString()} tokens · {formatGoalTime(goal.timeUsedSeconds)}
              </p>
            ) : null}
            <div className="goal-actions">
              <button type="submit" disabled={disabled || !objective.trim()}>
                {goal ? 'Update' : 'Start goal'}
              </button>
              {goal?.status === 'active' ? (
                <button type="button" disabled={disabled} onClick={() => void onSetStatus('paused')}>Pause</button>
              ) : goal?.status === 'paused' ? (
                <button type="button" disabled={disabled} onClick={() => void onSetStatus('active')}>Resume</button>
              ) : null}
              {goal ? (
                <button type="button" className="goal-clear" disabled={disabled} onClick={() => void onClear()}>Clear</button>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}

function goalStatusLabel(status: ThreadGoalStatus): string {
  return {
    active: 'Goal active',
    paused: 'Goal paused',
    blocked: 'Goal blocked',
    usageLimited: 'Usage limited',
    budgetLimited: 'Budget reached',
    complete: 'Goal complete'
  }[status]
}

function formatGoalTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return seconds < 3_600 ? `${minutes}m ${Math.round(seconds % 60)}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function GoalIcon(): React.JSX.Element {
  return (
    <svg className="workspace-pill-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 4V2.5M20 12h1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function ModelIcon(): React.JSX.Element {
  return (
    <svg className="workspace-pill-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 3.5v2M14 3.5v2M10 18.5v2M14 18.5v2M3.5 10h2M3.5 14h2M18.5 10h2M18.5 14h2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Composer({
  docked,
  isLoading,
  isTurnActive,
  status,
  onSend,
  onSteer,
  onStop
}: {
  docked: boolean
  isLoading: boolean
  isTurnActive: boolean
  status: string
  onSend: (text: string) => Promise<boolean>
  onSteer: (text: string) => Promise<boolean>
  onStop: () => Promise<void>
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(190, Math.max(54, textarea.scrollHeight))}px`
  }, [value])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()

    const text = value.trim()
    if (!text || isLoading) {
      return
    }

    setValue('')
    const accepted = isTurnActive ? await onSteer(text) : await onSend(text)
    if (!accepted) {
      setValue((current) => current ? `${text}\n${current}` : text)
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder={isTurnActive ? 'Add guidance while Codex works…' : docked ? 'Reply…' : 'Plan, build, or ask anything…'}
        disabled={isLoading}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <div className="composer-footer">
        <span className={`composer-status ${isLoading || isTurnActive ? 'is-active' : ''}`}>{status}</span>
        <div className="composer-actions">
          {isTurnActive ? (
            <button type="button" className="stop-button" aria-label="Stop turn" onClick={() => void onStop()}>
              <span className="stop-button-icon" aria-hidden="true">■</span>
              <span>Stop</span>
            </button>
          ) : null}
          <button
            type="submit"
            className="send-button"
            aria-label={isTurnActive ? 'Add guidance to turn' : 'Send message'}
            disabled={isLoading || !value.trim()}
          >
            ↑
          </button>
        </div>
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
}): React.JSX.Element {
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

function TabStrip({ state }: { state: BrowserState }): React.JSX.Element {
  return (
    <div className="tab-strip">
      {state.tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          className={`tab ${tab.id === state.activeTabId ? 'is-active' : ''}`}
          onClick={() => void window.api.browser.activateTab(tab.id)}
        >
          <TabFavicon favicon={tab.favicon} isLoading={tab.isLoading} />
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

function TabFavicon({ favicon, isLoading }: { favicon: string | null; isLoading: boolean }): React.JSX.Element {
  // Reset the error flag whenever the favicon URL changes so a fresh icon gets
  // a chance to load after a previous one failed.
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [favicon])

  if (isLoading) {
    return <span className="tab-favicon tab-favicon-spinner" aria-hidden="true" />
  }

  if (favicon && !failed) {
    return (
      <img
        className="tab-favicon"
        src={favicon}
        alt=""
        aria-hidden="true"
        onError={() => setFailed(true)}
      />
    )
  }

  return <GlobeIcon />
}

function GlobeIcon(): React.JSX.Element {
  return (
    <svg className="tab-favicon tab-favicon-fallback" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8 1.75c1.9 0 3.25 2.8 3.25 6.25S9.9 14.25 8 14.25 4.75 11.45 4.75 8 6.1 1.75 8 1.75Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M2 8h12M2.6 5.5h10.8M2.6 10.5h10.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function BrowserToolbar({ activeTab }: { activeTab: BrowserTabState | null }): React.JSX.Element {
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
      next[index] = mergeChatItem(next[index], item)
    }
  }

  return next
}

// App-server snapshots and deltas can cross the IPC boundary in adjacent
// turns. Never let a shorter snapshot erase text that has already streamed
// into the renderer; lifecycle/status fields still come from the newest item.
function mergeChatItem(current: ChatItem, incoming: ChatItem): ChatItem {
  if (current.type !== incoming.type) {
    return incoming
  }

  switch (incoming.type) {
    case 'agentMessage': {
      const existing = current as Extract<ThreadItem, { type: 'agentMessage' }>
      return {
        ...existing,
        ...incoming,
        text: incoming.text.length >= existing.text.length ? incoming.text : existing.text
      }
    }
    case 'commandExecution': {
      const existing = current as Extract<ThreadItem, { type: 'commandExecution' }>
      const incomingOutput = incoming.aggregatedOutput ?? ''
      const existingOutput = existing.aggregatedOutput ?? ''
      return {
        ...existing,
        ...incoming,
        aggregatedOutput: incomingOutput.length >= existingOutput.length ? incomingOutput : existingOutput
      }
    }
    case 'reasoning': {
      const existing = current as Extract<ThreadItem, { type: 'reasoning' }>
      return {
        ...existing,
        ...incoming,
        summary: mergeTextParts(existing.summary, incoming.summary),
        content: mergeTextParts(existing.content, incoming.content)
      }
    }
    case 'plan': {
      const existing = current as Extract<ThreadItem, { type: 'plan' }>
      return {
        ...existing,
        ...incoming,
        text: incoming.text.length >= existing.text.length ? incoming.text : existing.text
      }
    }
    default:
      return incoming
  }
}

function mergeTextParts(current: string[], incoming: string[]): string[] {
  const length = Math.max(current.length, incoming.length)
  return Array.from({ length }, (_, index) => {
    const existing = current[index] ?? ''
    const next = incoming[index] ?? ''
    return next.length >= existing.length ? next : existing
  })
}

function persistLastThreadId(threadId: string | null): void {
  if (threadId) {
    window.localStorage.setItem(lastThreadStorageKey, threadId)
  } else {
    window.localStorage.removeItem(lastThreadStorageKey)
  }
}

function threadTitle(thread: Thread): string {
  return stripSkillMarkerFromTitle(thread.name || thread.preview || 'New Chat')
}

function stripSkillMarkerFromTitle(title: string): string {
  return title.replace(/^\$artifact-first-web-research\s*/i, '') || 'New Chat'
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
