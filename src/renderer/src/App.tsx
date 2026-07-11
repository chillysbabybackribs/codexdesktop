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
import { AgentColumn, AgentTabStrip, SendArrowIcon } from './AgentDock'
import { ModelPill } from './ModelPill'
import type { AgentLiteMessage, AgentSession } from './AgentDock'
import type {
  BrowserBounds,
  BrowserState,
  BrowserTabState,
  CodexEvent,
  MemoryPersistParams,
  OmniboxAnchor,
  OmniboxSuggestion
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
import type { ThreadTokenUsage } from '../../shared/codex-protocol/v2/ThreadTokenUsage'
import type { Turn } from '../../shared/codex-protocol/v2/Turn'
import type { UserInput } from '../../shared/codex-protocol/v2/UserInput'
import { summarizeTurnDiff } from './diff'
import { TraceModal, formatTokens } from './TraceModal'
import { buildTurnTrace, isTurnTrace, type TurnTrace } from './trace'
import {
  modelCallAttributionForItem,
  reduceTurnTelemetry,
  type ModelCallAttribution
} from './turn-telemetry'
import {
  AutoFollow,
  CdpScreenshotPreview,
  TurnTail,
  WorkGroup,
  cdpScreenshotArtifacts,
  type ItemMeta,
  type TurnMeta,
  type TurnPlanItem,
  type WorkItem
} from './TaskActivity'
import { selectCompletedWork } from './memory-work'
import { AttachmentButton, AttachmentStrip, attachmentsFromUserInput, saveBrowserFiles } from './Attachments'
import type { ChatAttachment } from '../../shared/ipc'
import {
  buildRows,
  isWorkItem,
  upsertMany,
  type ActivityItem,
  type ChatItem,
  type SystemItem
} from './transcript-model'

function modelAcceptsImages(models: Model[], model: string | null): boolean {
  const selected = models.find((candidate) => candidate.model === model || candidate.id === model)
  return !selected || selected.inputModalities.includes('image')
}


const minChatWidth = 280
const minBrowserWidth = 420
const dividerWidth = 8
const lastThreadStorageKey = 'codexdesktop.lastThreadId'
const agentDockStorageKey = 'codexdesktop.agentDock.v1'
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
  // Latest thread-level usage snapshot; `last` sizes the current context.
  const [contextUsage, setContextUsage] = useState<ThreadTokenUsage | null>(null)
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([])
  const [openAgentKeys, setOpenAgentKeys] = useState<string[]>([])
  const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(null)
  const [isCompacting, setIsCompacting] = useState(false)
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
  // The contextCompaction item currently running, with the context size it
  // started from, so the compaction turn's token update can record the shrink.
  const activeCompactionRef = useRef<{ itemId: string; turnId: string; beforeTokens: number | null } | null>(null)
  const contextUsageRef = useRef<ThreadTokenUsage | null>(null)
  // Background agent sessions. The ref mirrors state synchronously (via
  // updateAgentSessions) because the codex event handler routes on it.
  const agentSessionsRef = useRef<AgentSession[]>([])
  // Buffered agent-message deltas keyed by session key → itemId → accumulated
  // text, flushed into agent-session state on a 32ms timer. Without this, each
  // streamed token was one root-App re-render (the main chat already batches
  // this way via enqueueItemMutation).
  const agentDeltaBufferRef = useRef<Map<string, Map<string, string>>>(new Map())
  const agentDeltaTimerRef = useRef<number | null>(null)
  // Keys of agent sessions whose thread/start is in flight, so the
  // thread/started notification binds to the session instead of hijacking the
  // main view.
  const agentStartQueueRef = useRef<string[]>([])
  // Stable "Agent N" numbering (main chat is implicitly 1) that survives
  // closes and restarts.
  const agentCounterRef = useRef(2)
  // Persistence only starts writing after restore has run, so a fresh mount
  // can't wipe the stored dock.
  const agentDockRestoredRef = useRef(false)
  // Per-session overload recovery, keyed by session key — the dock equivalent
  // of autoRecoveryRef (which only ever tracks the focused thread).
  const agentRecoveryRef = useRef<Map<string, Omit<AutoRecoveryState, 'threadId'>>>(new Map())

  useEffect(() => {
    return window.api.browser.onState(setBrowserState)
  }, [])

  useEffect(() => () => {
    if (itemMutationTimerRef.current !== null) {
      window.clearTimeout(itemMutationTimerRef.current)
    }
    if (agentDeltaTimerRef.current !== null) {
      window.clearTimeout(agentDeltaTimerRef.current)
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
        // Main thread first — it warms up the codex child, so the dock's
        // resume calls don't race a cold start. The dock restore then skips
        // any thread the main view already owns.
        const restorePromise = (async () => {
          if (lastThreadId) await resumeThreadById(lastThreadId, { silent: true })
          await restoreAgentDock()
        })()

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

  const handleSend = async (text: string, attachments: ChatAttachment[] = []): Promise<boolean> => {
    const trimmed = text.trim()

    if ((!trimmed && !attachments.length) || isSending || activeTurnId) {
      return false
    }
    if (attachments.some((attachment) => attachment.kind === 'image') && !modelAcceptsImages(models, selectedModel)) {
      addSystemItem('The selected model does not accept image inputs. Choose an image-capable model or remove the image.', 'warning')
      return false
    }

    // The user is driving again — drop any pending overload recovery.
    cancelAutoRecovery()
    setIsSending(true)
    userTurnRequestPendingRef.current = true
    watchThreadIdRef.current = activeThreadId

    try {
      const response = await window.api.codex.sendMessage({
        threadId: activeThreadId,
        text: trimmed,
        attachments,
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
    cancelAutoRecovery()
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

  const handleCompactThread = async (): Promise<void> => {
    const threadId = activeThreadIdRef.current
    if (!threadId || activeTurnIdRef.current) {
      return
    }

    try {
      // No optimistic message: the server's contextCompaction item arrives
      // within ~100ms and renders the live progress row itself.
      await window.api.codex.compactThread(threadId)
    } catch (error) {
      addSystemItem(`Compaction failed: ${(error as Error).message}`, 'error')
    }
  }

  const handleNewThread = (): void => {
    const previousThreadId = activeThreadIdRef.current

    cancelAutoRecovery()
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
    setContextUsage(null)
    contextUsageRef.current = null
    setIsCompacting(false)
    activeCompactionRef.current = null
    precedingModelInputByTurnRef.current.clear()
    pendingCompactionByTurnRef.current.clear()

    if (previousThreadId && !backgroundSessionForThread(previousThreadId)) {
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

    // If the target thread lives in the agent dock, the focused view absorbs
    // it — one owner per thread.
    updateAgentSessions((sessions) => sessions.filter((session) => session.threadId !== threadId))

    if (previousThreadId !== threadId) {
      cancelAutoRecovery()
    }
    setActiveGoal(null)
    activeGoalRef.current = null
    setActiveReasoningEffort(null)
    activeReasoningEffortRef.current = null

    if (
      previousThreadId &&
      previousThreadId !== threadId &&
      !backgroundSessionForThread(previousThreadId)
    ) {
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

  // ---- Background agent sessions -------------------------------------------

  // State and ref must stay in sync within the same tick: the codex event
  // handler routes on the ref, and promote/demote swaps subscribe state
  // immediately after mutating the list.
  function updateAgentSessions(updater: (sessions: AgentSession[]) => AgentSession[]): void {
    agentSessionsRef.current = updater(agentSessionsRef.current)
    setAgentSessions(agentSessionsRef.current)
  }

  function backgroundSessionForThread(threadId: string): AgentSession | null {
    return agentSessionsRef.current.find((session) => session.threadId === threadId) ?? null
  }

  function patchAgentSession(key: string, patch: (session: AgentSession) => AgentSession): void {
    updateAgentSessions((sessions) =>
      sessions.map((session) => (session.key === key ? patch(session) : session))
    )
  }

  function appendAgentMessage(key: string, message: AgentLiteMessage): void {
    patchAgentSession(key, (session) => ({ ...session, messages: [...session.messages, message] }))
  }

  // Apply every buffered agent delta in one state update per frame. Mirrors the
  // main chat's flushPendingItemMutations so a burst of tokens across all open
  // agents collapses into a single agent-session render.
  function flushAgentDeltas(): void {
    if (agentDeltaTimerRef.current !== null) {
      window.clearTimeout(agentDeltaTimerRef.current)
      agentDeltaTimerRef.current = null
    }

    const buffer = agentDeltaBufferRef.current
    if (buffer.size === 0) return
    agentDeltaBufferRef.current = new Map()

    updateAgentSessions((sessions) =>
      sessions.map((session) => {
        const perItem = buffer.get(session.key)
        if (!perItem || perItem.size === 0) return session

        let messages = session.messages
        for (const [itemId, delta] of perItem) {
          const existing = messages.find((message) => message.id === itemId)
          messages = existing
            ? messages.map((message) =>
                message.id === itemId ? { ...message, text: `${message.text}${delta}` } : message
              )
            : [...messages, { id: itemId, role: 'assistant' as const, text: delta }]
        }
        return { ...session, messages }
      })
    )
  }

  function enqueueAgentDelta(key: string, itemId: string, delta: string): void {
    let perItem = agentDeltaBufferRef.current.get(key)
    if (!perItem) {
      perItem = new Map()
      agentDeltaBufferRef.current.set(key, perItem)
    }
    perItem.set(itemId, `${perItem.get(itemId) ?? ''}${delta}`)

    if (agentDeltaTimerRef.current === null) {
      agentDeltaTimerRef.current = window.setTimeout(flushAgentDeltas, 32)
    }
  }

  // Append unless a message with this id already exists — the `error`
  // notification and the failed `turn/completed` carry the same turn error.
  function appendAgentMessageOnce(key: string, message: AgentLiteMessage): void {
    patchAgentSession(key, (session) =>
      session.messages.some((existing) => existing.id === message.id)
        ? session
        : { ...session, messages: [...session.messages, message] }
    )
  }

  // Lite reducer for threads living in the dock: track turn status and plain
  // chat text only. The full activity pipeline stays exclusive to the focused
  // thread.
  function handleAgentNotification(session: AgentSession, notification: ServerNotification): void {
    // Land any buffered deltas before an event that reads/mutates messages, so
    // a completed item or terminal message never lands ahead of its own tokens.
    if (notification.method !== 'item/agentMessage/delta' && agentDeltaBufferRef.current.size > 0) {
      flushAgentDeltas()
    }
    switch (notification.method) {
      case 'turn/started':
        patchAgentSession(session.key, (current) => ({
          ...current,
          status: 'working',
          turnId: notification.params.turn.id
        }))
        return
      case 'turn/completed': {
        const turn = notification.params.turn
        patchAgentSession(session.key, (current) => ({
          ...current,
          status: 'done',
          turnId: null,
          isCompacting: false
        }))
        void window.api.notifications.backgroundTurn({
          threadId: notification.params.threadId,
          title: session.title || 'Background agent',
          status: turn.status === 'failed' ? 'failed' : 'completed',
          message: turn.error?.message ?? null
        })
        if (turn.error?.message) {
          appendAgentMessageOnce(session.key, {
            id: `error-${turn.id}`,
            role: 'assistant',
            text: `⚠ ${turn.error.message}`
          })
        }
        if (turn.status === 'failed') {
          maybeScheduleAgentRecovery(session.key, turn.id, turn.error)
        } else {
          // Healthy terminal turn (completed or user-interrupted) ends any
          // recovery chain, mirroring the main chat.
          cancelAgentRecovery(session.key)
        }
        return
      }
      case 'item/agentMessage/delta': {
        const { itemId, delta } = notification.params
        enqueueAgentDelta(session.key, itemId, delta)
        return
      }
      case 'item/completed': {
        const item = notification.params.item
        if (item.type === 'contextCompaction') {
          patchAgentSession(session.key, (current) => ({ ...current, isCompacting: false }))
          return
        }
        if (item.type !== 'agentMessage') return
        patchAgentSession(session.key, (current) => {
          const existing = current.messages.find((message) => message.id === item.id)
          const messages = existing
            ? current.messages.map((message) =>
                message.id === item.id ? { ...message, text: item.text } : message
              )
            : [...current.messages, { id: item.id, role: 'assistant' as const, text: item.text }]
          return { ...current, messages }
        })
        return
      }
      case 'item/started':
        if (notification.params.item.type === 'contextCompaction') {
          patchAgentSession(session.key, (current) => ({ ...current, isCompacting: true }))
        }
        return
      case 'thread/tokenUsage/updated':
        patchAgentSession(session.key, (current) => ({
          ...current,
          contextUsage: notification.params.tokenUsage
        }))
        return
      case 'error': {
        const { turnId, error, willRetry } = notification.params
        if (willRetry) return
        appendAgentMessageOnce(session.key, {
          id: `error-${turnId}`,
          role: 'assistant',
          text: `⚠ ${error.message}`
        })
        patchAgentSession(session.key, (current) =>
          current.turnId === turnId ? { ...current, status: 'done', turnId: null } : current
        )
        maybeScheduleAgentRecovery(session.key, turnId, error)
        return
      }
      default:
        return
    }
  }

  function liteMessagesFromItems(source: ChatItem[]): AgentLiteMessage[] {
    const messages: AgentLiteMessage[] = []
    for (const item of source) {
      if (item.type === 'userMessage') {
        const text = item.content
          .filter((content) => content.type === 'text')
          .map((content) => content.text)
          .join('\n')
        const attachments = attachmentsFromUserInput(item.content)
        if (text || attachments.length) messages.push({ id: item.id, role: 'user', text, attachments })
      } else if (item.type === 'agentMessage') {
        if (item.text) messages.push({ id: item.id, role: 'assistant', text: item.text })
      }
    }
    return messages
  }

  function handleNewAgent(): void {
    const key = crypto.randomUUID()
    updateAgentSessions((sessions) => [
      ...sessions,
      {
        key,
        threadId: null,
        title: `Agent ${agentCounterRef.current++}`,
        status: 'idle',
        turnId: null,
        messages: [],
        watchesMain: false,
        model: null,
        contextUsage: null,
        isCompacting: false
      }
    ])
    setOpenAgentKeys((current) => [...current, key])
    setSelectedAgentKey(key)
  }

  // Tab click focuses: opens the window if closed. Scrolling/flashing to it is
  // handled where the DOM lives (ChatPane).
  function handleOpenAgent(key: string): void {
    setOpenAgentKeys((current) => (current.includes(key) ? current : [...current, key]))
  }

  function handleMinimizeAgent(key: string): void {
    setOpenAgentKeys((current) => current.filter((candidate) => candidate !== key))
  }

  function handleToggleWatchAgent(key: string): void {
    patchAgentSession(key, (session) => ({ ...session, watchesMain: !session.watchesMain }))
  }

  function handleSetAgentModel(key: string, model: string): void {
    patchAgentSession(key, (session) => ({ ...session, model }))
  }

  // Dock persistence, mirroring the main chat's lastThreadId restore: session
  // metadata lives in localStorage; transcripts rehydrate from the server.
  useEffect(() => {
    if (!agentDockRestoredRef.current) return
    // Blank agents (no message sent yet, so no thread) persist too — they
    // restore as blank windows.
    const sessions = agentSessions.map((session) => ({
      threadId: session.threadId,
      title: session.title,
      watchesMain: session.watchesMain,
      model: session.model,
      open: openAgentKeys.includes(session.key),
      selected: session.key === selectedAgentKey
    }))
    window.localStorage.setItem(
      agentDockStorageKey,
      JSON.stringify({ counter: agentCounterRef.current, sessions })
    )
  }, [agentSessions, openAgentKeys, selectedAgentKey])

  // Strip the helper-mode context preamble from persisted user messages so
  // rehydrated transcripts show what the user actually typed.
  function stripMainChatContext(text: string): string {
    if (!text.startsWith('<main-chat-context>')) return text
    const end = text.indexOf('</main-chat-context>')
    return end === -1 ? text : text.slice(end + '</main-chat-context>'.length).trimStart()
  }

  async function restoreAgentDock(): Promise<void> {
    try {
      const raw = window.localStorage.getItem(agentDockStorageKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as {
        counter?: number
        sessions?: Array<{
          threadId?: string | null
          title?: string
          watchesMain?: boolean
          model?: string | null
          open?: boolean
          selected?: boolean
        }>
      }
      if (typeof parsed.counter === 'number' && parsed.counter > agentCounterRef.current) {
        agentCounterRef.current = parsed.counter
      }
      const entries = (parsed.sessions ?? []).filter(
        (entry) =>
          // The main view owns its restored thread; don't double-own it.
          !entry.threadId || entry.threadId !== activeThreadIdRef.current
      )
      if (!entries.length) return

      const restored: AgentSession[] = entries.map((entry) => ({
        key: crypto.randomUUID(),
        threadId: typeof entry.threadId === 'string' && entry.threadId ? entry.threadId : null,
        title: entry.title || `Agent ${agentCounterRef.current++}`,
        status: 'idle',
        turnId: null,
        messages: [],
        watchesMain: Boolean(entry.watchesMain),
        model: entry.model ?? null,
        contextUsage: null,
        isCompacting: false
      }))

      // Register before resuming so incoming events route to the dock and the
      // main view's unsubscribe guards see these threads as dock-owned.
      updateAgentSessions((current) => [...current, ...restored])
      // Windows relaunch as they were left; if no open flags survived (legacy
      // or corrupted storage), open everything rather than restoring a dock
      // of invisible tabs.
      const anyOpenFlag = entries.some((entry) => entry.open)
      const openKeys = anyOpenFlag
        ? restored.filter((_, index) => entries[index].open).map((s) => s.key)
        : restored.map((s) => s.key)
      if (openKeys.length) setOpenAgentKeys((current) => [...current, ...openKeys])
      const selectedIndex = entries.findIndex((entry) => entry.selected)
      if (selectedIndex >= 0) setSelectedAgentKey(restored[selectedIndex].key)

      await Promise.all(
        restored.map(async (session) => {
          if (!session.threadId) return
          try {
            const resumed = await window.api.codex.resumeThread(session.threadId)
            let turns =
              resumed.thread.turns.length > 0
                ? resumed.thread.turns
                : resumed.initialTurnsPage?.data ?? []
            if (!turns.length) {
              const read = await window.api.codex.readThread(session.threadId!)
              turns = read.thread.turns
            }
            const messages: AgentLiteMessage[] = []
            for (const turn of turns) {
              for (const item of turn.items) {
                if (item.type === 'userMessage') {
                  const text = item.content
                    .flatMap((content: UserInput) => content.type === 'text' ? [content.text] : [])
                    .join('\n')
                  const attachments = attachmentsFromUserInput(item.content)
                  if (text || attachments.length) {
                    messages.push({ id: item.id, role: 'user', text: stripMainChatContext(text), attachments })
                  }
                } else if (item.type === 'agentMessage' && item.text) {
                  messages.push({ id: item.id, role: 'assistant', text: item.text })
                }
              }
            }
            patchAgentSession(session.key, (current) => ({
              ...current,
              messages: messages.slice(-60)
            }))
          } catch (error) {
            // Keep the session — a resume failure here is more often a
            // cold-start hiccup than a deleted thread, and dropping it loses
            // the user's dock. The window shows a note instead.
            console.warn('Agent thread rehydration failed', session.threadId, error)
            appendAgentMessage(session.key, {
              id: `restore-${session.key}`,
              role: 'assistant',
              text: '⚠ Could not restore this conversation’s history. Sending a message will retry the thread; close this agent if it no longer exists.'
            })
          }
        })
      )
    } catch (error) {
      console.warn('Agent dock restore failed', error)
    } finally {
      agentDockRestoredRef.current = true
    }
  }

  // Compact digest of the focused conversation, prepended to helper-agent
  // sends. Built from renderer state — no extra IPC or token-heavy replay.
  function buildMainChatContext(): string {
    const recent = liteMessagesFromItems(items).slice(-8)
    const lines = recent.map((message) => {
      const text = message.text.length > 600 ? `${message.text.slice(0, 600)}…` : message.text
      return `${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`
    })
    return [
      '<main-chat-context>',
      "You are an optional helper agent running beside the user's main conversation.",
      'Recent main-chat messages follow. Use them as context for the message after the closing tag.',
      'Do not modify workspace files or take actions unless the user explicitly asks you to.',
      '',
      ...lines,
      '',
      `Main chat status: ${activeTurnIdRef.current ? 'a turn is currently running' : 'idle'}.`,
      '</main-chat-context>'
    ].join('\n')
  }

  // Agent tabs keep their stable "Agent N" names — server thread names never
  // overwrite them.
  function bindAgentThread(key: string, threadId: string): void {
    patchAgentSession(key, (session) => ({
      ...session,
      threadId: session.threadId ?? threadId
    }))
  }

  async function handleAgentSend(key: string, text: string, attachments: ChatAttachment[] = []): Promise<boolean> {
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key)
    if (!session) return false

    // The user is driving this agent again — drop any pending recovery.
    cancelAgentRecovery(key)

    try {
      const agentModel = session.model ?? selectedModelRef.current
      if (attachments.some((attachment) => attachment.kind === 'image') && !modelAcceptsImages(models, agentModel)) {
        appendAgentMessage(key, {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: '⚠ The selected model does not accept image inputs. Choose an image-capable model or remove the image.'
        })
        return false
      }
      let threadId = session.threadId
      if (!threadId) {
        agentStartQueueRef.current.push(key)
        const started = await window.api.codex.startThread({
          cwd: workspaceRef.current,
          model: agentModel
        })
        threadId = started.thread.id
        agentStartQueueRef.current = agentStartQueueRef.current.filter((queued) => queued !== key)
        if (!threadId) throw new Error('Thread start returned no thread id')
        bindAgentThread(key, threadId)
      }

      appendAgentMessage(key, { id: crypto.randomUUID(), role: 'user', text, attachments })
      const outgoingText = session.watchesMain ? `${buildMainChatContext()}\n\n${text}` : text
      const response = await window.api.codex.sendMessage({
        threadId,
        text: outgoingText,
        attachments,
        cwd: workspaceRef.current,
        model: agentModel
      })
      patchAgentSession(key, (current) => ({
        ...current,
        status: 'working',
        turnId: response.turn.id
      }))
      return true
    } catch (error) {
      appendAgentMessage(key, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `⚠ Agent turn failed to start: ${(error as Error).message}`
      })
      return false
    }
  }

  async function handleAgentStop(key: string): Promise<void> {
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key)
    if (!session?.threadId || !session.turnId) return
    try {
      await window.api.codex.interruptTurn({ threadId: session.threadId, turnId: session.turnId })
    } catch {
      // The turn may have already finished; the lite state settles via events.
    }
  }

  async function handleAgentCompact(key: string): Promise<void> {
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key)
    if (!session?.threadId || session.turnId || session.isCompacting) return

    try {
      await window.api.codex.compactThread(session.threadId)
    } catch (error) {
      appendAgentMessage(key, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `⚠ Compaction failed: ${(error as Error).message}`
      })
    }
  }

  // Mid-turn guidance for a dock agent, same turn/steer verb as the main
  // composer. The steered text is appended locally because the lite reducer
  // ignores userMessage items.
  async function handleAgentSteer(key: string, text: string): Promise<boolean> {
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key)
    const trimmed = text.trim()
    if (!trimmed || !session?.threadId || !session.turnId) return false
    try {
      await window.api.codex.steerTurn({
        threadId: session.threadId,
        turnId: session.turnId,
        text: trimmed
      })
      appendAgentMessage(key, { id: crypto.randomUUID(), role: 'user', text: trimmed })
      return true
    } catch (error) {
      appendAgentMessage(key, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `⚠ Could not add guidance to the running turn: ${(error as Error).message}`
      })
      return false
    }
  }

  function cancelAgentRecovery(key: string): void {
    const state = agentRecoveryRef.current.get(key)
    if (state?.timer !== null && state?.timer !== undefined) {
      window.clearTimeout(state.timer)
    }
    agentRecoveryRef.current.delete(key)
  }

  // Dock mirror of maybeScheduleAutoRecovery: same attempt budget, delay, and
  // model-fallback walk, but scoped to one session and reported through its
  // lite transcript instead of system items.
  function maybeScheduleAgentRecovery(key: string, turnId: string, error: TurnError | null): void {
    if (!error || !isRecoverableTurnError(error.codexErrorInfo)) return

    const existing = agentRecoveryRef.current.get(key)
    if (existing?.handledTurnIds.has(turnId)) return

    const state = existing ?? { attempts: 0, handledTurnIds: new Set<string>(), timer: null }
    state.handledTurnIds.add(turnId)
    agentRecoveryRef.current.set(key, state)

    if (state.attempts >= maxAutoRecoveryAttempts) {
      appendAgentMessageOnce(key, {
        id: `recovery-stopped-${turnId}`,
        role: 'assistant',
        text: `⚠ Auto-recovery stopped after ${maxAutoRecoveryAttempts} attempts. Send a message to continue the task.`
      })
      return
    }

    state.attempts += 1
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key)
    const currentModel = session?.model ?? selectedModelRef.current
    const nextModel = state.attempts === 1 ? currentModel : pickFallbackModel(currentModel)
    const switching = nextModel !== null && nextModel !== currentModel
    const delaySeconds = Math.round(autoRecoveryDelayMs / 1000)
    appendAgentMessageOnce(key, {
      id: `recovery-${turnId}`,
      role: 'assistant',
      text: switching
        ? `${currentModel ?? 'The model'} is under heavy load — continuing on ${nextModel} in ${delaySeconds}s (attempt ${state.attempts}/${maxAutoRecoveryAttempts}).`
        : `The model is under heavy load — retrying in ${delaySeconds}s (attempt ${state.attempts}/${maxAutoRecoveryAttempts}).`
    })
    state.timer = window.setTimeout(() => {
      state.timer = null
      void runAgentRecovery(key, nextModel)
    }, autoRecoveryDelayMs)
  }

  async function runAgentRecovery(key: string, model: string | null): Promise<void> {
    // Bail silently if the recovery was cancelled or the session moved on
    // (closed, promoted, or the user started another turn) while waiting.
    if (!agentRecoveryRef.current.has(key)) return
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key)
    if (!session?.threadId || session.turnId) return

    // Surface the fallback in the window's model pill so the pill reflects
    // what the thread is actually running on.
    if (model && model !== session.model) {
      patchAgentSession(key, (current) => ({ ...current, model }))
    }

    try {
      const response = await window.api.codex.sendMessage({
        threadId: session.threadId,
        text: autoRecoveryPrompt,
        cwd: workspaceRef.current,
        model: model ?? session.model ?? selectedModelRef.current
      })
      patchAgentSession(key, (current) => ({
        ...current,
        status: 'working',
        turnId: response.turn.id
      }))
    } catch (error) {
      appendAgentMessage(key, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `⚠ Auto-recovery could not restart the turn: ${(error as Error).message}`
      })
      cancelAgentRecovery(key)
    }
  }

  function handleCloseAgentSession(key: string): void {
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key)
    cancelAgentRecovery(key)
    updateAgentSessions((sessions) => sessions.filter((candidate) => candidate.key !== key))
    setOpenAgentKeys((current) => current.filter((candidate) => candidate !== key))
    setSelectedAgentKey((current) => (current === key ? null : current))
    if (session?.threadId && session.threadId !== activeThreadIdRef.current) {
      // Stop the turn before unsubscribing: nobody is watching a closed agent,
      // so a running turn would keep burning tokens (and editing the workspace)
      // invisibly. Interrupt first, then drop the subscription.
      if (session.turnId) {
        void window.api.codex.interruptTurn({ threadId: session.threadId, turnId: session.turnId }).catch(() => {})
      }
      void window.api.codex.unsubscribeThread(session.threadId).catch(() => {})
    }
  }

  // Promote: the agent's conversation takes over the main view and its window
  // closes. The previous main chat is not demoted into the dock — it lands in
  // thread history, exactly like switching threads from the history menu. If a
  // turn was running there it keeps working server-side; results show when the
  // thread is reopened.
  async function handlePromoteAgent(key: string): Promise<void> {
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key)
    if (!session) return

    // The focused view's own recovery machinery owns this thread from here.
    cancelAgentRecovery(key)

    if (session.model && session.model !== selectedModelRef.current) {
      selectedModelRef.current = session.model
      handleSelectModel(session.model)
    }

    updateAgentSessions((sessions) => sessions.filter((candidate) => candidate.key !== key))
    setOpenAgentKeys((current) => current.filter((candidate) => candidate !== key))
    setSelectedAgentKey((current) => (current === key ? null : current))

    if (!session.threadId) {
      // Blank agent (no message sent yet, so no thread): promoting it is just
      // a fresh main chat on its model.
      handleNewThread()
      return
    }

    // hydrateThread (inside resumeThreadById) sets activeTurnId from the thread's
    // actual inProgress turn. Do NOT re-assert the session's captured turnId: if
    // the agent's turn completed while resume was in flight, re-marking it active
    // soft-locks the main composer (handleSend refuses, Stop errors on a dead turn).
    setActiveTurnId(null)
    activeTurnIdRef.current = null
    await resumeThreadById(session.threadId)
  }

  // ---- End background agent sessions ---------------------------------------

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

    // Threads owned by background agent sessions route to the lite reducer and
    // never touch the focused view's state.
    const incomingThreadId = (notification.params as { threadId?: string } | undefined)?.threadId
    if (incomingThreadId && !isRelevantThread(incomingThreadId)) {
      const backgroundSession = backgroundSessionForThread(incomingThreadId)
      if (backgroundSession) {
        if (notification.method === 'thread/name/updated') {
          // Dock titles stay "Agent N"; only the history list refreshes.
          void refreshThreads()
          return
        }
        handleAgentNotification(backgroundSession, notification)
        return
      }
    }

    switch (notification.method) {
      case 'thread/started': {
        // A thread started for a dock agent binds to its session instead of
        // taking over the main view. Two orderings are possible: if the
        // startThread IPC response resolved first, the thread is already bound
        // (check by id); if this notification arrived first, the pending queue
        // holds the session key.
        const startedThreadId = notification.params.thread.id
        if (startedThreadId && backgroundSessionForThread(startedThreadId)) {
          return
        }
        const pendingAgentKey = agentStartQueueRef.current.shift()
        if (pendingAgentKey) {
          bindAgentThread(pendingAgentKey, startedThreadId)
          return
        }
        watchThreadIdRef.current = notification.params.thread.id
        persistLastThreadId(notification.params.thread.id)
        setActiveThreadId(notification.params.thread.id)
        setActiveThreadTitle(threadTitle(notification.params.thread))
        return
      }
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
          const startPatch: Partial<ItemMeta> = { startedAtMs: notification.params.startedAtMs }
          if (notification.params.item.type === 'contextCompaction') {
            const beforeTokens = contextUsageRef.current?.last.totalTokens ?? null
            activeCompactionRef.current = {
              itemId: notification.params.item.id,
              turnId: notification.params.turnId,
              beforeTokens
            }
            startPatch.compaction = { beforeTokens, afterTokens: null }
            setIsCompacting(true)
          }
          noteItem(notification.params.item.id, notification.params.turnId, startPatch)
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
          if (notification.params.item.type === 'contextCompaction') {
            if (activeCompactionRef.current?.itemId === notification.params.item.id) {
              activeCompactionRef.current = null
            }
            setIsCompacting(false)
          }
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
          contextUsageRef.current = notification.params.tokenUsage
          setContextUsage(notification.params.tokenUsage)
          const activeCompaction = activeCompactionRef.current
          if (activeCompaction && activeCompaction.turnId === notification.params.turnId) {
            // The compaction turn reports the shrunken context before its
            // item completes; pin both sizes on the item for the transcript.
            noteItem(activeCompaction.itemId, activeCompaction.turnId, {
              compaction: {
                beforeTokens: activeCompaction.beforeTokens,
                afterTokens: notification.params.tokenUsage.last.totalTokens
              }
            })
          }
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
            maybeScheduleAutoRecovery(
              notification.params.threadId,
              notification.params.turnId,
              notification.params.error
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
        // Ref, not state: refreshThreads is invoked from the mount-only codex
        // event handler (e.g. agent turn/completed), whose closure captured the
        // launch-time `workspace`. Using the ref refetches the current workspace.
        cwd: workspaceRef.current,
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
    // No usage snapshot until the resumed thread's next model call reports in.
    setContextUsage(null)
    contextUsageRef.current = null
    setIsCompacting(false)
    activeCompactionRef.current = null

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
          contextUsage={contextUsage}
          isCompacting={isCompacting}
          onCompactThread={handleCompactThread}
          agentSessions={agentSessions}
          openAgentKeys={openAgentKeys}
          selectedAgentKey={selectedAgentKey}
          onSelectAgent={setSelectedAgentKey}
          onOpenAgent={handleOpenAgent}
          onMinimizeAgent={handleMinimizeAgent}
          onToggleWatchAgent={handleToggleWatchAgent}
          onSetAgentModel={handleSetAgentModel}
          onNewAgent={handleNewAgent}
          onPromoteAgent={(key) => void handlePromoteAgent(key)}
          onCloseAgentSession={handleCloseAgentSession}
          onAgentSend={handleAgentSend}
          onAgentSteer={handleAgentSteer}
          onAgentStop={handleAgentStop}
          onAgentCompact={handleAgentCompact}
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
  const isVerificationInstance = window.api.runtime.instanceRole === 'verification'

  return (
    <header className={`titlebar ${isVerificationInstance ? 'is-verification' : ''}`}>
      <div className="titlebar-title">
        {isVerificationInstance ? 'Chat — Verification Instance' : 'Chat'}
      </div>
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
  onClearGoal,
  contextUsage,
  isCompacting,
  onCompactThread,
  agentSessions,
  openAgentKeys,
  selectedAgentKey,
  onSelectAgent,
  onOpenAgent,
  onMinimizeAgent,
  onToggleWatchAgent,
  onSetAgentModel,
  onNewAgent,
  onPromoteAgent,
  onCloseAgentSession,
  onAgentSend,
  onAgentSteer,
  onAgentStop,
  onAgentCompact
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
  onSend: (text: string, attachments?: ChatAttachment[]) => Promise<boolean>
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
  contextUsage: ThreadTokenUsage | null
  isCompacting: boolean
  onCompactThread: () => Promise<void>
  agentSessions: AgentSession[]
  openAgentKeys: string[]
  selectedAgentKey: string | null
  onSelectAgent: (key: string) => void
  onOpenAgent: (key: string) => void
  onMinimizeAgent: (key: string) => void
  onToggleWatchAgent: (key: string) => void
  onSetAgentModel: (key: string, model: string) => void
  onNewAgent: () => void
  onPromoteAgent: (key: string) => void
  onCloseAgentSession: (key: string) => void
  onAgentSend: (key: string, text: string, attachments?: ChatAttachment[]) => Promise<boolean>
  onAgentSteer: (key: string, text: string) => Promise<boolean>
  onAgentStop: (key: string) => Promise<void>
  onAgentCompact: (key: string) => Promise<void>
}): React.JSX.Element {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  // Which region the user is working in: the main chat (default) or the agent
  // column. Drives the dim/unfocus treatment on agent windows via CSS.
  const [isMainFocused, setIsMainFocused] = useState(true)
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

  const openAgentSessions = agentSessions.filter((session) => openAgentKeys.includes(session.key))

  // Pointer-downs and focus moves decide the active region: anything inside
  // the agent column or tab strip counts as agent territory, everything else
  // is the main chat.
  const updateFocusRegion = (target: EventTarget | null): void => {
    const inAgents =
      target instanceof HTMLElement && Boolean(target.closest('.agent-column-shell, .agent-tabs'))
    setIsMainFocused(!inAgents)
  }

  const focusAgent = (key: string): void => {
    const wasOpen = openAgentKeys.includes(key)
    onSelectAgent(key)
    onOpenAgent(key)
    // Alignment is an absolute, idempotent scrollTo — never a relative
    // scrollBy, which compounds when fired mid-animation. Settle runs on the
    // browser's scrollend event, not a guessed timeout, so it measures a
    // finished layout. A freshly opened window aligns instantly (the column is
    // reflowing anyway); an already-open one scrolls smoothly.
    const alignOnce = (behavior: ScrollBehavior): 'missing' | 'aligned' | 'scrolling' => {
      const node = document.querySelector(`[data-agent-key="${key}"]`)
      const scroller = node instanceof HTMLElement ? node.parentElement : null
      if (!(node instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return 'missing'
      const raw =
        scroller.scrollTop +
        node.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top
      const target = Math.max(0, Math.min(raw, scroller.scrollHeight - scroller.clientHeight))
      if (Math.abs(target - scroller.scrollTop) <= 4) return 'aligned'
      scroller.scrollTo({ top: target, behavior })
      return 'scrolling'
    }
    let attempts = 0
    const run = (): void => {
      const state = alignOnce(wasOpen ? 'smooth' : 'auto')
      if (state === 'missing') {
        if (attempts++ < 12) requestAnimationFrame(run)
        return
      }
      const node = document.querySelector(`[data-agent-key="${key}"]`)
      if (node instanceof HTMLElement) {
        node.classList.add('is-flash')
        window.setTimeout(() => node.classList.remove('is-flash'), 750)
      }
      if (state === 'scrolling') {
        const scroller = node instanceof HTMLElement ? node.parentElement : null
        if (scroller instanceof HTMLElement) {
          const settle = (): void => {
            alignOnce('auto')
          }
          scroller.addEventListener('scrollend', settle, { once: true })
          // Fallback in case scrollend never fires; alignOnce is idempotent,
          // so a double settle is a no-op.
          window.setTimeout(() => {
            scroller.removeEventListener('scrollend', settle)
            alignOnce('auto')
          }, 900)
        }
      }
    }
    requestAnimationFrame(run)
  }

  return (
    <section
      className={`chat-pane ${hasThreadContent ? 'is-thread' : 'is-empty'} ${isRestoring ? 'is-hydrating' : ''} ${
        openAgentSessions.length ? 'has-agents' : ''
      } ${isMainFocused ? 'is-main-focused' : ''}`}
      aria-busy={isRestoring}
      onPointerDownCapture={(event) => updateFocusRegion(event.target)}
      onFocusCapture={(event) => updateFocusRegion(event.target)}
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
              meta={itemMeta[row.item.id]}
              streaming={row.item.id === streamingMessageId}
            />
          )
        })}
      </ThreadScroll>

      <div
        className={`composer-dock ${hasThreadContent ? 'is-docked' : 'is-centered'} ${
          openAgentSessions.length ? 'has-agents' : ''
        }`}
      >
        {openAgentSessions.length ? (
          <AgentColumn
            sessions={openAgentSessions}
            selectedKey={selectedAgentKey}
            models={models}
            mainModel={selectedModel}
            onSetModel={onSetAgentModel}
            onSelect={onSelectAgent}
            onMinimize={onMinimizeAgent}
            onCloseSession={onCloseAgentSession}
            onPromote={onPromoteAgent}
            onToggleWatch={onToggleWatchAgent}
            onSend={onAgentSend}
            onSteer={onAgentSteer}
            onStop={onAgentStop}
            onCompact={onAgentCompact}
          />
        ) : null}
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
          <AgentTabStrip
            sessions={agentSessions}
            openKeys={openAgentKeys}
            onFocus={focusAgent}
            onNewAgent={onNewAgent}
          />
        </div>
        <Composer
          docked={hasThreadContent}
          isLoading={isRestoring || isBusy && !activeTurnId}
          isTurnActive={Boolean(activeTurnId)}
          status={isRestoring ? 'Restoring conversation' : activeTurnId ? 'Working' : status}
          onSend={onSend}
          onSteer={onSteer}
          onStop={onStop}
          footerExtras={
            <div className="composer-thread-controls">
              <ContextPill
                usage={contextUsage}
                disabled={Boolean(activeTurnId)}
                compacting={isCompacting}
                onCompact={onCompactThread}
              />
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
          }
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
  const screenshotArtifacts = cdpScreenshotArtifacts(items.filter(isWorkItem))
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
    <>
      <section className="task-activity-card" aria-label="In-task activity" aria-live={live ? 'polite' : 'off'}>
        <AutoFollow className="task-activity-card-scroll">
          <div className="task-activity-card-content">{content}</div>
        </AutoFollow>
      </section>
      {screenshotArtifacts.length ? (
        <div className="cdp-screenshot-attachments" aria-label="Browser screenshots">
          {screenshotArtifacts.map((artifact) => (
            <CdpScreenshotPreview key={artifact.artifactPath} artifact={artifact} />
          ))}
        </div>
      ) : null}
    </>
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

const ChatItemView = memo(function ChatItemView({
  item,
  meta,
  streaming
}: {
  item: ChatItem
  meta?: ItemMeta
  streaming: boolean
}): React.JSX.Element | null {
  if (item.type === 'system') {
    return <article className={`message message-system message-system-${item.level}`}>{item.text}</article>
  }

  if (item.type === 'userMessage') {
    const text = item.content
      .filter((content) => content.type === 'text')
      .map((content) => stripAutomaticSkillMarker(stripInjectedMemory(content.text)))
      .join('\n')
    const attachments = attachmentsFromUserInput(item.content)

    return (
      <article className="message message-user">
        {text ? <p>{text}</p> : null}
        <AttachmentStrip attachments={attachments} />
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
    const inProgress = Boolean(meta?.startedAtMs) && !meta?.completedAtMs
    const before = meta?.compaction?.beforeTokens ?? null
    const after = meta?.compaction?.afterTokens ?? null

    if (inProgress) {
      return (
        <article className="message message-compaction">
          <span className="shimmer-text">
            {before
              ? `Compacting context — summarizing ${formatTokens(before)} tokens…`
              : 'Compacting context…'}
          </span>
        </article>
      )
    }

    // Compactions restored from history carry no token metadata; only live
    // ones can show the real shrink.
    const shrank = before !== null && after !== null && after < before
    return (
      <article className="message message-compaction">
        {shrank
          ? `Context compacted — ${formatTokens(before)} → ${formatTokens(after)} tokens (${Math.round((1 - after / before) * 100)}% smaller)`
          : 'Context compacted'}
      </article>
    )
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

// Composer pill showing how full the thread's model context is (the last
// model call's tokens against the model window). Clicking it asks the
// app-server to compact the thread; auto-compaction also runs at 80% from the
// main process, so this is the "clean up now" affordance.
function ContextPill({
  usage,
  disabled,
  compacting,
  onCompact
}: {
  usage: ThreadTokenUsage | null
  disabled: boolean
  compacting: boolean
  onCompact: () => Promise<void>
}): React.JSX.Element | null {
  const window = usage?.modelContextWindow
  const contextTokens = usage?.last.totalTokens ?? 0

  if (!usage || !window || contextTokens <= 0) {
    return null
  }

  const percent = Math.min(100, Math.round((contextTokens / window) * 100))
  const level = percent >= 80 ? 'is-high' : percent >= 60 ? 'is-warm' : ''

  return (
    <button
      type="button"
      className={`context-pill ${level} ${compacting ? 'is-compacting' : ''}`}
      disabled={disabled}
      title={compacting
        ? 'Compacting the conversation…'
        : `Context ${percent}% full (${contextTokens.toLocaleString()} of ${window.toLocaleString()} tokens). Click to compact the conversation.`}
      onClick={() => void onCompact()}
    >
      <span className="context-pill-track" aria-hidden="true">
        <span className="context-pill-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="context-pill-label">{compacting ? '…' : `${percent}%`}</span>
    </button>
  )
}

// Composer pill that shows the model turns run on and opens an upward popover
// listing the full `model/list` catalog. Picks persist across restarts and are
// sent as a per-turn override; before the first pick, turns follow the
// CLI-configured default (the entry Codex marks `isDefault`).
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


function Composer({
  docked,
  isLoading,
  isTurnActive,
  status,
  onSend,
  onSteer,
  onStop,
  footerExtras
}: {
  docked: boolean
  isLoading: boolean
  isTurnActive: boolean
  status: string
  onSend: (text: string, attachments?: ChatAttachment[]) => Promise<boolean>
  onSteer: (text: string) => Promise<boolean>
  onStop: () => Promise<void>
  footerExtras?: React.ReactNode
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
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
    if ((!text && !attachments.length) || isLoading) {
      return
    }

    setValue('')
    const submittedAttachments = attachments
    if (!isTurnActive) setAttachments([])
    const accepted = isTurnActive ? await onSteer(text) : await onSend(text, submittedAttachments)
    if (!accepted) {
      setValue((current) => current ? `${text}\n${current}` : text)
      if (!isTurnActive) setAttachments(submittedAttachments)
    }
  }

  return (
    <form
      className="composer"
      onSubmit={handleSubmit}
      onDragOver={(event) => { if (!isTurnActive && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDrop={(event) => {
        if (isTurnActive) return
        const files = Array.from(event.dataTransfer.files)
        if (!files.length) return
        event.preventDefault()
        setAttachmentError(null)
        void saveBrowserFiles(files).then((items) => setAttachments((current) => [...current, ...items])).catch((error: unknown) => setAttachmentError(error instanceof Error ? error.message : String(error)))
      }}
    >
      <AttachmentStrip attachments={attachments} removable onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))} />
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder={isTurnActive ? 'Add guidance while Codex works…' : docked ? 'Reply…' : 'Plan, build, or ask anything…'}
        disabled={isLoading}
        onChange={(event) => setValue(event.target.value)}
        onPaste={(event) => {
          if (isTurnActive) return
          const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
          if (!images.length) return
          const pastedText = event.clipboardData.getData('text/plain')
          const start = event.currentTarget.selectionStart
          const end = event.currentTarget.selectionEnd
          event.preventDefault()
          if (pastedText) setValue((current) => `${current.slice(0, start)}${pastedText}${current.slice(end)}`)
          setAttachmentError(null)
          void saveBrowserFiles(images).then((items) => setAttachments((current) => [...current, ...items])).catch((error: unknown) => setAttachmentError(error instanceof Error ? error.message : String(error)))
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
      />
      <div className="composer-footer">
        <span className={`composer-status ${isLoading || isTurnActive ? 'is-active' : ''}`}>{attachmentError ?? status}</span>
        <div className="composer-actions">
          <AttachmentButton disabled={isLoading || isTurnActive} onAdd={(items) => { setAttachmentError(null); setAttachments((current) => [...current, ...items]) }} onError={setAttachmentError} />
          {footerExtras}
          {isTurnActive ? (
            <button
              type="button"
              className="stop-square-button"
              aria-label="Stop turn"
              title="Stop"
              onClick={() => void onStop()}
            >
              <span className="stop-square" aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="submit"
            className="send-button"
            aria-label={isTurnActive ? 'Add guidance to turn' : 'Send message'}
            disabled={isLoading || (!value.trim() && !attachments.length)}
          >
            <SendArrowIcon />
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
  const [isEditing, setIsEditing] = useState(false)
  const [suggestions, setSuggestions] = useState<OmniboxSuggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [findResult, setFindResult] = useState({ activeMatchOrdinal: 0, matches: 0 })
  const findInputRef = useRef<HTMLInputElement>(null)
  const omniboxRef = useRef<HTMLInputElement>(null)
  // The user's typed text, kept while arrow keys preview suggestions so
  // stepping back to "no selection" restores it.
  const typedTextRef = useRef('')
  const justFocusedRef = useRef(false)
  const querySeqRef = useRef(0)
  // Selection range for an inline autocomplete, applied after React commits
  // the completed value to the controlled input.
  const pendingInlineRef = useRef<{ start: number; end: number } | null>(null)

  // Mirror the page URL into the bar ONLY while the user isn't editing —
  // redirects and pushState-heavy sites must not clobber typing mid-edit.
  useEffect(() => {
    if (!isEditing) {
      setInput(activeTab?.url ?? '')
    }
  }, [activeTab?.url, isEditing])

  useLayoutEffect(() => {
    const range = pendingInlineRef.current
    if (range && omniboxRef.current) {
      omniboxRef.current.setSelectionRange(range.start, range.end)
    }
    pendingInlineRef.current = null
  }, [input])

  // Switching tabs always ends the edit in the old tab's context.
  useEffect(() => {
    setIsEditing(false)
    closePopup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id])

  useEffect(() => window.api.browser.onFindRequested(() => setFindOpen(true)), [])
  useEffect(
    () =>
      window.api.browser.onFocusOmnibox(() => {
        omniboxRef.current?.focus()
      }),
    []
  )
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setFindOpen(true)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        omniboxRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  // The dropdown is a native view anchored to a fixed rect; close it rather
  // than let it drift when the window (and toolbar) geometry changes.
  useEffect(() => {
    const onResize = (): void => {
      if (document.activeElement === omniboxRef.current) {
        omniboxRef.current?.blur()
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    if (findOpen) requestAnimationFrame(() => findInputRef.current?.focus())
  }, [findOpen])

  const measureAnchor = (): OmniboxAnchor | null => {
    const rect = omniboxRef.current?.getBoundingClientRect()
    return rect ? { x: rect.left - 2, y: rect.bottom + 4, width: rect.width + 4 } : null
  }

  const runQuery = (text: string, allowInline = false): void => {
    const anchor = measureAnchor()
    if (!anchor) return
    const seq = ++querySeqRef.current
    void window.api.browser.omniboxQuery(text, anchor).then((result) => {
      if (seq !== querySeqRef.current) return
      setSuggestions(result.suggestions)
      setSelectedIndex(-1)

      // Inline autocomplete: extend the input with the best history match and
      // select the appended remainder so the next keystroke replaces it.
      // Guarded to forward typing only — completing while the user deletes
      // would fight the deletion.
      if (
        allowInline &&
        result.inline &&
        text === typedTextRef.current &&
        result.inline.length > text.length &&
        result.inline.toLowerCase().startsWith(text.toLowerCase())
      ) {
        pendingInlineRef.current = { start: text.length, end: result.inline.length }
        setInput(result.inline)
      }
    })
  }

  const closePopup = (): void => {
    querySeqRef.current += 1
    setSuggestions([])
    setSelectedIndex(-1)
    void window.api.browser.omniboxClose()
  }

  const moveSelection = (delta: 1 | -1): void => {
    if (!suggestions.length) return
    let next = selectedIndex + delta
    if (next >= suggestions.length) next = -1
    if (next < -1) next = suggestions.length - 1
    setSelectedIndex(next)
    void window.api.browser.omniboxSelect(next)
    if (next === -1) {
      setInput(typedTextRef.current)
    } else {
      const suggestion = suggestions[next]
      setInput(suggestion.kind === 'search' ? suggestion.text : suggestion.url)
    }
  }

  const handleOmniboxKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (suggestions.length) {
        // First Escape: dismiss the dropdown, keep the typed text.
        closePopup()
        setInput(typedTextRef.current)
      } else {
        // Second Escape: revert to the page URL and leave the bar.
        setInput(activeTab?.url ?? '')
        omniboxRef.current?.blur()
      }
    }
  }

  const runFind = async (forward: boolean): Promise<void> => {
    if (!activeTab || !findText) return
    setFindResult(await window.api.browser.find(activeTab.id, findText, forward))
  }

  const closeFind = (): void => {
    if (activeTab) void window.api.browser.stopFind(activeTab.id, 'clearSelection')
    setFindOpen(false)
    setFindResult({ activeMatchOrdinal: 0, matches: 0 })
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()

    const selected = selectedIndex >= 0 ? suggestions[selectedIndex] : null
    const target = selected ? selected.url : input

    if (activeTab && target.trim()) {
      void window.api.browser.navigate(activeTab.id, target)
    }

    closePopup()
    omniboxRef.current?.blur()
  }

  return (
    <form className={`browser-toolbar ${findOpen ? 'has-find' : ''}`} onSubmit={handleSubmit}>
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
        ref={omniboxRef}
        className="omnibox"
        value={input}
        spellCheck={false}
        autoComplete="off"
        aria-label="Address"
        onFocus={(event) => {
          setIsEditing(true)
          typedTextRef.current = event.target.value
          justFocusedRef.current = true
          event.target.select()
          runQuery('')
        }}
        onMouseUp={(event) => {
          // Keep the select-all from the focus click; without this the mouseup
          // collapses the selection to a caret.
          if (justFocusedRef.current) {
            event.preventDefault()
            justFocusedRef.current = false
          }
        }}
        onBlur={() => {
          setIsEditing(false)
          closePopup()
        }}
        onChange={(event) => {
          const text = event.target.value
          setInput(text)
          typedTextRef.current = text
          // Inline-complete only while typing forward; completing right after
          // a deletion would restore the text the user just removed.
          const inputType = (event.nativeEvent as InputEvent).inputType ?? ''
          runQuery(text, inputType.startsWith('insert'))
        }}
        onKeyDown={handleOmniboxKeyDown}
      />
      <button type="button" className="browser-nav-button" aria-label="Find in page" title="Find in page" onClick={() => setFindOpen(true)}>
        ⌕
      </button>
      <button
        type="button"
        className={`browser-nav-button ${activeTab?.isMuted ? 'is-active' : ''}`}
        aria-label={activeTab?.isMuted ? 'Unmute tab' : 'Mute tab'}
        title={activeTab?.isMuted ? 'Unmute tab' : 'Mute tab'}
        disabled={!activeTab || (!activeTab.isAudible && !activeTab.isMuted)}
        onClick={() => activeTab && void window.api.browser.toggleMute(activeTab.id)}
      >
        {activeTab?.isMuted ? '⊘' : '♪'}
      </button>
      <div className="browser-zoom" aria-label="Page zoom">
        <button type="button" aria-label="Zoom out" onClick={() => activeTab && void window.api.browser.zoom(activeTab.id, 'out')}>−</button>
        <button type="button" className="zoom-value" aria-label="Reset zoom" onClick={() => activeTab && void window.api.browser.zoom(activeTab.id, 'reset')}>{activeTab?.zoomPercent ?? 100}%</button>
        <button type="button" aria-label="Zoom in" onClick={() => activeTab && void window.api.browser.zoom(activeTab.id, 'in')}>+</button>
      </div>
      {findOpen ? (
        <div className="browser-find" role="search">
          <input
            ref={findInputRef}
            value={findText}
            placeholder="Find in page"
            aria-label="Find in page"
            onChange={(event) => {
              setFindText(event.target.value)
              if (event.target.value && activeTab) {
                void window.api.browser.find(activeTab.id, event.target.value, true).then(setFindResult)
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeFind()
              if (event.key === 'Enter') {
                // Stop the toolbar form from also submitting (which navigates).
                event.preventDefault()
                void runFind(!event.shiftKey)
              }
            }}
          />
          <span aria-live="polite">{findText ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : '0/0'}</span>
          <button type="button" aria-label="Previous match" onClick={() => void runFind(false)}>↑</button>
          <button type="button" aria-label="Next match" onClick={() => void runFind(true)}>↓</button>
          <button type="button" aria-label="Close find" onClick={closeFind}>×</button>
        </div>
      ) : null}
    </form>
  )
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
