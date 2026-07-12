import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { AgentConversationPanel, ConversationTabStrip, SendArrowIcon } from './AgentDock'
import { ConversationLayoutTree } from './ConversationLayout'
import type { ConversationTarget, LayoutNode } from './conversation-layout'
import { ModelPill } from './ModelPill'
import type { AgentLiteMessage, AgentSession } from './AgentDock'
import type {
  BrowserBounds,
  BrowserState,
  ClaudeEffort,
  CodexEvent,
  CodexPluginAppStatus,
  MemoryPersistParams,
  PlanningState
} from '../../shared/ipc'
import type { AgentEvent, AgentModel, AgentProvider } from '../../shared/agent'
import type { ServerNotification } from '../../shared/codex-protocol/ServerNotification'
import type { ReasoningEffort } from '../../shared/codex-protocol/ReasoningEffort'
import type { CodexErrorInfo } from '../../shared/codex-protocol/v2/CodexErrorInfo'
import type { TurnError } from '../../shared/codex-protocol/v2/TurnError'
import type { Model } from '../../shared/codex-protocol/v2/Model'
import type { Thread } from '../../shared/codex-protocol/v2/Thread'
import type { ThreadGoal } from '../../shared/codex-protocol/v2/ThreadGoal'
import type { ThreadGoalStatus } from '../../shared/codex-protocol/v2/ThreadGoalStatus'
import type { ThreadItem } from '../../shared/codex-protocol/v2/ThreadItem'
import type { ThreadTokenUsage } from '../../shared/codex-protocol/v2/ThreadTokenUsage'
import type { PluginMarketplaceEntry } from '../../shared/codex-protocol/v2/PluginMarketplaceEntry'
import type { PluginSummary } from '../../shared/codex-protocol/v2/PluginSummary'
import type { AppSummary } from '../../shared/codex-protocol/v2/AppSummary'
import type { PluginAuthPolicy } from '../../shared/codex-protocol/v2/PluginAuthPolicy'
import type { Turn } from '../../shared/codex-protocol/v2/Turn'
import { summarizeTurnDiff } from './diff'
import { TraceModal, formatTokens } from './TraceModal'
import { buildTurnTrace, isTurnTrace, type TurnTrace } from './trace'
import { resetAgentSession } from './agent-session-model'
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
  appendAgentMessageDelta,
  isWorkItem,
  upsertMany,
  type ActivityItem,
  type ChatItem,
  type SystemItem
} from './transcript-model'
import {
  isImmediateItemNotification,
  isItemNotification,
  reduceItemNotificationItems,
  reduceItemNotificationMeta,
  type ItemNotification
} from './item-notifications'
import { BrowserPane } from './BrowserPane'
import { MarkdownContent } from './MarkdownContent'
import { liteMessagesFromItems, restoreAgentDock as restorePersistedAgentDock } from './agent-dock-restore'
import { createAgentCommands } from './agent-commands'
import { createAgentLifecycle } from './agent-lifecycle'
import { useAgentSessions, parseStoredConversationLayout } from './useAgentSessions'
import {
  pluginInstallParams,
  pluginUninstallId,
  safePluginAuthUrl,
  unresolvedPluginApps
} from './plugin-lifecycle'
import {
  buildOptimisticUserMessage,
  hasAuthoritativeUserMessage,
  stripOptimisticUserMessage
} from './optimistic-user-message'

function modelAcceptsImages(models: Model[], model: string | null): boolean {
  const selected = models.find((candidate) => candidate.model === model || candidate.id === model)
  return !selected || selected.inputModalities.includes('image')
}


const minChatWidth = 280
const minBrowserWidth = 420
const dividerWidth = 8
const lastThreadStorageKey = 'codexdesktop.lastThreadId'
const claudeLastThreadStorageKey = 'codexdesktop.claude.lastThreadId'
const agentDockStorageKey = 'codexdesktop.agentDock.v1'
const modelStorageKey = 'codexdesktop.model'
const reasoningEffortStorageKey = 'codexdesktop.reasoningEffort'
const collaborationModeStorageKey = 'codexdesktop.collaborationMode'
const providerStorageKey = 'codexdesktop.provider'

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
  const [provider] = useState<AgentProvider>(() =>
    window.localStorage.getItem(providerStorageKey) === 'claude' ? 'claude' : 'codex'
  )
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
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort | null>(
    () => window.localStorage.getItem(reasoningEffortStorageKey)
  )
  const [collaborationMode, setCollaborationMode] = useState<'default' | 'plan'>(() =>
    window.localStorage.getItem(collaborationModeStorageKey) === 'plan' ? 'plan' : 'default'
  )
  const [planningState, setPlanningState] = useState<PlanningState | null>(null)
  const [browserState, setBrowserState] = useState<BrowserState>({ tabs: [], activeTabId: null })
  const [viewBounds, setViewBounds] = useState<BrowserBounds | null>(null)
  // Lifecycle data the item payloads don't carry: which turn an item belongs
  // to, start/completion timestamps, MCP progress. Keyed by item id.
  const [itemMeta, setItemMeta] = useState<Record<string, ItemMeta>>({})
  // Per-turn status, timing, token usage, and diff stats for the tail rows.
  const [turnMeta, setTurnMeta] = useState<Record<string, TurnMeta>>({})
  // Latest thread-level usage snapshot; `last` sizes the current context.
  const [contextUsage, setContextUsage] = useState<ThreadTokenUsage | null>(null)
  const {
    agentSessions,
    selectedAgentKey,
    setSelectedAgentKey,
    conversationLayout,
    setConversationLayout,
    focusedLeafId,
    setFocusedLeafId,
    focusedTarget,
    visibleTargets,
    handleSelectConversation,
    handleRemoveConversationTarget,
    restoreConversationLayout,
    agentSessionsRef,
    agentStartQueueRef,
    agentCounterRef,
    agentDockRestoredRef,
    updateAgentSessions,
    patchAgentSession,
    appendAgentMessage,
    appendAgentMessageOnce,
    backgroundSessionForThread,
    handleAgentNotification,
    handleNewAgent,
    handleToggleWatchAgent,
    handleSetAgentModel
  } = useAgentSessions(agentDockStorageKey, {
    schedule: maybeScheduleAgentRecovery,
    cancel: cancelAgentRecovery
  })
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
  const optimisticUserMessageIdRef = useRef<string | null>(null)
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
  const itemMutationFrameRef = useRef<number | null>(null)
  const threadsNextCursorRef = useRef<string | null>(null)
  const persistedTraceFingerprintsRef = useRef<Map<string, string>>(new Map())
  const persistedMemoryFingerprintsRef = useRef<Map<string, string>>(new Map())
  const precedingModelInputByTurnRef = useRef<Map<string, ModelCallAttribution>>(new Map())
  const pendingCompactionByTurnRef = useRef<Set<string>>(new Set())
  // The contextCompaction item currently running, with the context size it
  // started from, so the compaction turn's token update can record the shrink.
  const activeCompactionRef = useRef<{ itemId: string; turnId: string; beforeTokens: number | null } | null>(null)
  const contextUsageRef = useRef<ThreadTokenUsage | null>(null)
  // Per-session overload recovery, keyed by session key — the dock equivalent
  // of autoRecoveryRef (which only ever tracks the focused thread).
  const agentRecoveryRef = useRef<Map<string, Omit<AutoRecoveryState, 'threadId'>>>(new Map())

  useEffect(() => {
    return window.api.browser.onState(setBrowserState)
  }, [])

  useEffect(() => window.api.codex.onPlanningState((state) => {
    if (!activeThreadIdRef.current || state.threadId === activeThreadIdRef.current) {
      setPlanningState(state)
    }
  }), [])

  useEffect(() => {
    if (!activeThreadId) {
      setPlanningState(null)
      return
    }
    let active = true
    void window.api.codex.getPlanningState(activeThreadId).then((state) => {
      if (active) setPlanningState(state)
    })
    return () => { active = false }
  }, [activeThreadId])

  useEffect(() => () => {
    if (itemMutationFrameRef.current !== null) {
      window.cancelAnimationFrame(itemMutationFrameRef.current)
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
    if (provider !== 'codex' || codexStatus !== 'ready' || models.length) {
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
        const active = list.find((model) => model.model === selectedModel) ?? list.find((model) => model.isDefault) ?? list[0]
        setSelectedReasoningEffort((current) => {
          const supported = active.supportedReasoningEfforts.map((option) => option.reasoningEffort)
          const next = current && supported.includes(current) ? current : active.defaultReasoningEffort
          window.localStorage.setItem(reasoningEffortStorageKey, next)
          return next
        })
      },
      (error: Error) => console.warn('Failed to load Codex model list', error)
    )

    return () => {
      cancelled = true
    }
  }, [provider, codexStatus, models.length])

  useEffect(() => {
    if (provider === 'claude') {
      const dispose = window.api.claude.onEvent((event) => handleClaudeEvent(event))
      const lastThreadId = window.localStorage.getItem(threadStorageKey(provider))
      initializationPromiseRef.current = (async () => {
        try {
          const [catalog] = await Promise.all([
            window.api.claude.listModels(workspaceRef.current),
            window.api.claude.getAuthStatus(workspaceRef.current)
          ])
          const mapped = (catalog as AgentModel[]).map(claudeModelToUiModel)
          setModels(mapped)
          const active = mapped.find((model) => model.model === selectedModelRef.current) ?? mapped[0]
          if (active) {
            setSelectedModel(active.model)
            selectedModelRef.current = active.model
            setSelectedReasoningEffort(active.defaultReasoningEffort)
          }
          if (lastThreadId) {
            await window.api.claude.resumeThread(lastThreadId, workspaceRef.current)
            setActiveThreadId(lastThreadId)
            watchThreadIdRef.current = lastThreadId
          }
        } catch (error) {
          addSystemItem(`Claude initialization failed: ${(error as Error).message}`, 'error')
        } finally {
          setIsRestoring(false)
        }
      })()
      return dispose
    }

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
      const lastThreadId = window.localStorage.getItem(threadStorageKey(provider))
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
  }, [provider])

  const measureBrowserBounds = useCallback((): BrowserBounds | null => {
    const host = viewHostRef.current

    if (!host) {
      return null
    }

    const rect = host.getBoundingClientRect()
    const style = window.getComputedStyle(host)
    const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0
    const borderRight = Number.parseFloat(style.borderRightWidth) || 0
    const borderTop = Number.parseFloat(style.borderTopWidth) || 0
    const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0

    return {
      // WebContentsView is composited above the renderer. Target the host's
      // inner edge so the native page cannot paint over the visible frame.
      x: rect.left + borderLeft,
      y: rect.top + borderTop,
      width: Math.max(1, rect.width - borderLeft - borderRight),
      height: Math.max(1, rect.height - borderTop - borderBottom)
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

    let dragFinished = false
    const finishDrag = (): void => {
      if (dragFinished) return
      dragFinished = true
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
      window.localStorage.setItem('codexdesktop.split', String(splitRef.current))
      isDraggingDividerRef.current = false
      const latestBounds = measureBrowserBounds() ?? pendingBoundsRef.current

      if (latestBounds) {
        void window.api.browser.endDividerDrag(latestBounds)
      }
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finishDrag, { once: true })
    window.addEventListener('pointercancel', finishDrag, { once: true })
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
    const optimisticId = `optimistic-user-${crypto.randomUUID()}`
    optimisticUserMessageIdRef.current = optimisticId
    setItems((current) => [...current, buildOptimisticUserMessage(optimisticId, trimmed, attachments)])

    try {
      if (provider === 'claude') {
        const response = await window.api.claude.sendMessage({
          threadId: activeThreadId,
          text: trimmed,
          attachments,
          cwd: workspace,
          model: selectedModel,
          effort: asClaudeEffort(selectedReasoningEffort),
          collaborationMode
        })
        watchThreadIdRef.current = response.threadId
        setActiveThreadId(response.threadId)
        persistLastThreadId(response.threadId, provider)
        setActiveTurnId(response.turnId)
        activeTurnIdRef.current = response.turnId
        noteTurn(response.turnId, {
          status: 'inProgress',
          origin: 'live',
          requestedModel: selectedModel,
          model: response.model,
          reasoningEffort: response.effort,
          workspace,
          startedAtMs: Date.now()
        })
        return true
      }

      const response = await window.api.codex.sendMessage({
        threadId: activeThreadId,
        text: trimmed,
        attachments,
        cwd: workspace,
        model: selectedModel,
        effort: selectedReasoningEffort,
        collaborationMode
      })
      watchThreadIdRef.current = response.threadId
      setActiveThreadId(response.threadId)
      persistLastThreadId(response.threadId, provider)
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
      if (optimisticUserMessageIdRef.current === optimisticId) {
        optimisticUserMessageIdRef.current = null
        setItems((current) => current.filter((item) => item.id !== optimisticId))
      }
      addSystemItem(`${provider === 'claude' ? 'Claude' : 'Codex'} turn failed to start: ${(error as Error).message}`, 'error')
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
      if (provider === 'claude') {
        await window.api.claude.steerTurn({ threadId, turnId, text: trimmed })
      } else {
        await window.api.codex.steerTurn({ threadId, turnId, text: trimmed })
      }
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

    const selected = models.find((candidate) => candidate.model === model)
    if (!selected) return
    const supported = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort)
    const nextEffort = selectedReasoningEffort && supported.includes(selectedReasoningEffort)
      ? selectedReasoningEffort
      : selected.defaultReasoningEffort
    setSelectedReasoningEffort(nextEffort)
    window.localStorage.setItem(reasoningEffortStorageKey, nextEffort)
  }

  const handleSelectModelEffort = (model: string, effort: ReasoningEffort): void => {
    cancelAutoRecovery()
    setSelectedModel(model)
    setSelectedReasoningEffort(effort)
    window.localStorage.setItem(modelStorageKey, model)
    window.localStorage.setItem(reasoningEffortStorageKey, effort)
  }

  const handleSelectAgentModel = (key: string, model: string): void => {
    const selected = modelsRef.current.find((candidate) => candidate.model === model)
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key)
    if (!selected || !session) {
      handleSetAgentModel(key, model)
      return
    }
    const supported = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort)
    const nextEffort = session.reasoningEffort && supported.includes(session.reasoningEffort)
      ? session.reasoningEffort
      : selected.defaultReasoningEffort
    handleSetAgentModel(key, model, nextEffort)
  }

  const handleSelectAgentModelEffort = (
    key: string,
    model: string,
    effort: ReasoningEffort
  ): void => {
    handleSetAgentModel(key, model, effort)
  }

  const handleStop = async (): Promise<void> => {
    if (!activeThreadId || !activeTurnId) {
      return
    }

    try {
      if (provider === 'claude') {
        await window.api.claude.interruptTurn({ threadId: activeThreadId, turnId: activeTurnId })
      } else {
        await window.api.codex.interruptTurn({ threadId: activeThreadId, turnId: activeTurnId })
      }
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
      if (provider === 'claude') {
        addSystemItem('Claude manages context compaction automatically in this integration.', 'info')
        return
      }
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
    persistLastThreadId(null, provider)
    setActiveThreadId(null)
    setActiveThreadTitle('New Chat')
    setActiveTurnId(null)
    activeTurnIdRef.current = null
    userRequestedTurnIdRef.current = null
    optimisticUserMessageIdRef.current = null
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
    optimisticUserMessageIdRef.current = null

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

      persistLastThreadId(threadId, provider)
    } catch (error) {
      if (generation !== resumeGenerationRef.current) {
        return
      }

      watchThreadIdRef.current = activeThreadIdRef.current

      if (!options.silent) {
        addSystemItem(`Thread resume failed: ${(error as Error).message}`, 'error')
      } else {
        persistLastThreadId(null, provider)
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
    persistLastThreadId(threadId, provider)
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

  function restoreAgentDock(): Promise<void> {
    return restorePersistedAgentDock({
      storageKey: agentDockStorageKey,
      activeThreadId: activeThreadIdRef.current,
      store: {
        counterRef: agentCounterRef,
        restoredRef: agentDockRestoredRef,
        updateSessions: updateAgentSessions,
        setSelectedKey: setSelectedAgentKey,
        restoreLayout: (layout, nextFocusedLeafId, fallbackTarget) => {
          restoreConversationLayout(
            layout && typeof layout === 'object' ? parseStoredConversationLayout(layout) : null,
            nextFocusedLeafId,
            fallbackTarget
          )
        },
        patchSession: patchAgentSession,
        appendMessage: appendAgentMessage
      }
    })
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

  const {
    bindAgentThread,
    handleAgentSend,
    handleAgentStop,
    handleAgentCompact,
    handleAgentSteer
  } = createAgentCommands({
    store: {
      sessionsRef: agentSessionsRef,
      startQueueRef: agentStartQueueRef,
      patchSession: patchAgentSession,
      appendMessage: appendAgentMessage
    },
    getWorkspace: () => workspaceRef.current,
    getSelectedModel: () => selectedModelRef.current,
    getSelectedEffort: () => selectedReasoningEffort,
    acceptsImages: (model) => modelAcceptsImages(models, model),
    buildMainChatContext,
    cancelRecovery: cancelAgentRecovery
  })

  const agentLifecycle = createAgentLifecycle({
    store: {
      sessionsRef: agentSessionsRef,
      startQueueRef: agentStartQueueRef,
      recoveryRef: agentRecoveryRef,
      updateSessions: updateAgentSessions,
      patchSession: patchAgentSession,
      appendMessage: appendAgentMessage,
      appendMessageOnce: appendAgentMessageOnce,
      setSelectedKey: setSelectedAgentKey
    },
    maxRecoveryAttempts: maxAutoRecoveryAttempts,
    recoveryDelayMs: autoRecoveryDelayMs,
    recoveryPrompt: autoRecoveryPrompt,
    isRecoverable: (error) => Boolean(error && isRecoverableTurnError(error.codexErrorInfo)),
    getWorkspace: () => workspaceRef.current,
    getSelectedModel: () => selectedModelRef.current,
    getActiveThreadId: () => activeThreadIdRef.current,
    pickFallbackModel,
    selectMainModel: handleSelectModel,
    clearActiveTurn: () => {
      setActiveTurnId(null)
      activeTurnIdRef.current = null
    },
    createMainThread: handleNewThread,
    resumeMainThread: resumeThreadById
  })

  function cancelAgentRecovery(key: string): void {
    agentLifecycle.cancelRecovery(key)
  }

  function maybeScheduleAgentRecovery(key: string, turnId: string, error: TurnError | null): void {
    agentLifecycle.scheduleRecovery(key, turnId, error)
  }

  const { handleCloseAgentSession, handleResetAgentSession, handlePromoteAgent } = agentLifecycle

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

  function handleMainItemNotification(notification: ItemNotification): void {
    if (!isRelevantThread(notification.params.threadId)) return

    let compactionBeforeTokens: number | null | undefined
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      rememberModelCallInput(notification.params.turnId, notification.params.item)
    }

    if (notification.method === 'item/started' && notification.params.item.type === 'contextCompaction') {
      compactionBeforeTokens = contextUsageRef.current?.last.totalTokens ?? null
      activeCompactionRef.current = {
        itemId: notification.params.item.id,
        turnId: notification.params.turnId,
        beforeTokens: compactionBeforeTokens
      }
      setIsCompacting(true)
    }

    setItemMeta((current) => reduceItemNotificationMeta(current, notification, { compactionBeforeTokens }))

    if (isImmediateItemNotification(notification)) {
      // File-change notifications are full, growing snapshots rather than
      // tiny append-only token deltas. Applying each snapshot immediately
      // lets the live diff card visibly grow during long writes instead of
      // collapsing a burst of patches into one update on the next frame.
      flushPendingItemMutations()
      const incomingItems = notification.method === 'item/started' || notification.method === 'item/completed'
        ? [notification.params.item]
        : []
      const optimisticId = optimisticUserMessageIdRef.current
      if (optimisticId && hasAuthoritativeUserMessage(incomingItems)) {
        optimisticUserMessageIdRef.current = null
      }
      setItems((current) => reduceItemNotificationItems(
        stripOptimisticUserMessage(current, optimisticId, incomingItems),
        notification
      ))
    } else if (notification.method !== 'item/mcpToolCall/progress') {
      enqueueItemMutation((current) => reduceItemNotificationItems(current, notification))
    }

    if (notification.method === 'item/completed' && notification.params.item.type === 'contextCompaction') {
      if (activeCompactionRef.current?.itemId === notification.params.item.id) {
        activeCompactionRef.current = null
      }
      setIsCompacting(false)
    }
  }

  function handleClaudeEvent(event: AgentEvent): void {
    if (event.provider !== 'claude') return
    if (event.type === 'status') {
      setCodexStatus(event.status)
      if (event.status === 'error' || event.status === 'exited') {
        addSystemItem(event.message ?? 'Claude Agent SDK is not available.', event.status === 'error' ? 'error' : 'warning')
      }
      return
    }

    if (event.type === 'session.started') {
      watchThreadIdRef.current = event.sessionId
      setActiveThreadId(event.sessionId)
      setActiveThreadTitle('Claude session')
      persistLastThreadId(event.sessionId, provider)
      return
    }

    if (!isRelevantThread(event.sessionId)) return

    if (event.type === 'turn.started') {
      setActiveTurnId(event.turnId)
      activeTurnIdRef.current = event.turnId
      noteTurn(event.turnId, {
        status: 'inProgress',
        origin: 'live',
        model: selectedModelRef.current,
        reasoningEffort: activeReasoningEffortRef.current,
        workspace: workspaceRef.current,
        startedAtMs: Date.now()
      })
      return
    }

    if (event.type === 'message.delta') {
      const itemId = `claude-answer-${event.turnId}`
      noteItem(itemId, event.turnId)
      setItems((current) => appendAgentMessageDelta(current, itemId, event.text))
      return
    }

    if (event.type === 'message.completed') {
      const text = event.blocks
        .map(asRecord)
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('\n')
      if (text) {
        const itemId = `claude-answer-${event.turnId}`
        noteItem(itemId, event.turnId, { completedAtMs: Date.now() })
        setItems((current) => upsertMany(current, [{
          type: 'agentMessage',
          id: itemId,
          text,
          phase: null,
          memoryCitation: null
        }]))
      }
      return
    }

    if (event.type === 'tool.started') {
      const item: ThreadItem = {
        type: 'dynamicToolCall',
        id: event.callId,
        namespace: 'claude',
        tool: event.name,
        arguments: event.input as never,
        status: 'inProgress',
        contentItems: null,
        success: null,
        durationMs: null
      }
      noteItem(event.callId, event.turnId, { startedAtMs: Date.now() })
      setItems((current) => upsertMany(current, [item]))
      return
    }

    if (event.type === 'tool.completed') {
      noteItem(event.callId, event.turnId, { completedAtMs: Date.now() })
      setItems((existing) => {
        const current = existing.find((item) => item.id === event.callId && item.type === 'dynamicToolCall')
        const item: ThreadItem = {
          type: 'dynamicToolCall',
          id: event.callId,
          namespace: 'claude',
          tool: current?.type === 'dynamicToolCall' ? current.tool : 'tool',
          arguments: current?.type === 'dynamicToolCall' ? current.arguments : {},
          status: event.failed ? 'failed' : 'completed',
          contentItems: [{ type: 'inputText', text: stringifyUnknown(event.content) }],
          success: !event.failed,
          durationMs: null
        }
        return upsertMany(existing, [item])
      })
      return
    }

    if (event.type === 'tool.progress') {
      noteItem(event.callId, event.turnId, { progress: [`Running for ${Math.round(event.elapsedSeconds)}s`] })
      return
    }

    if (event.type === 'compaction.completed') {
      const itemId = `claude-compaction-${crypto.randomUUID()}`
      noteItem(itemId, activeTurnIdRef.current, {
        completedAtMs: Date.now(),
        compaction: { beforeTokens: event.beforeTokens, afterTokens: event.afterTokens }
      })
      setItems((current) => [...current, { type: 'contextCompaction', id: itemId }])
      return
    }

    if (event.type === 'turn.completed') {
      if (optimisticUserMessageIdRef.current) optimisticUserMessageIdRef.current = null
      noteTurn(event.turnId, {
        status: event.status,
        completedAtMs: Date.now(),
        errorMessage: event.error ?? undefined
      })
      if (event.error) addSystemItem(event.error, 'error')
      if (activeTurnIdRef.current === event.turnId) activeTurnIdRef.current = null
      setActiveTurnId((current) => current === event.turnId ? null : current)
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

    if (isItemNotification(notification)) {
      handleMainItemNotification(notification)
      return
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
        persistLastThreadId(notification.params.thread.id, provider)
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
          persistLastThreadId(notification.params.threadId, provider)
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
    const optimisticId = optimisticUserMessageIdRef.current
    if (optimisticId && hasAuthoritativeUserMessage(nextItems)) {
      optimisticUserMessageIdRef.current = null
    }
    setItems((current) => upsertMany(
      stripOptimisticUserMessage(current, optimisticId, nextItems),
      nextItems
    ))
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

    if (window.localStorage.getItem(threadStorageKey(provider)) === threadId) {
      persistLastThreadId(null, provider)
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

  // Queue a streaming mutation and schedule a single batched apply. Every delta
  // kind funnels through here so a burst of reasoning/command/text tokens
  // collapses into one setItems (one buildRows + one render) per display frame
  // instead of one per token. This keeps final-answer motion at the screen's
  // native cadence while still coalescing bursts from the transport.
  function enqueueItemMutation(mutate: (items: ChatItem[]) => ChatItem[]): void {
    pendingItemMutationsRef.current.push(mutate)

    if (itemMutationFrameRef.current !== null) {
      return
    }

    itemMutationFrameRef.current = window.requestAnimationFrame(() => {
      itemMutationFrameRef.current = null
      flushPendingItemMutations()
    })
  }

  // Apply every queued mutation in order in a single state update. Ordering is
  // preserved (mutations run in enqueue order), so this is safe to call ahead of
  // a full-item upsert to keep pending deltas from landing after their item.
  function flushPendingItemMutations(): void {
    const pending = pendingItemMutationsRef.current

    if (!pending.length) {
      return
    }

    if (itemMutationFrameRef.current !== null) {
      window.cancelAnimationFrame(itemMutationFrameRef.current)
      itemMutationFrameRef.current = null
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

  async function approvePlanningPlan(): Promise<void> {
    if (!activeThreadId || !planningState || planningState.phase !== 'awaitingApproval') return
    try {
      await window.api.codex.approvePlan({ threadId: activeThreadId, revision: planningState.revision })
      await handleSend('Implement the approved plan.')
    } catch (error) {
      addSystemItem(`Plan approval failed: ${(error as Error).message}`, 'error')
    }
  }

  async function requestPlanningChanges(): Promise<void> {
    if (!activeThreadId || !planningState || planningState.phase !== 'awaitingApproval') return
    try {
      await window.api.codex.requestPlanChanges({ threadId: activeThreadId, revision: planningState.revision })
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.main-conversation-panel textarea')?.focus())
    } catch (error) {
      addSystemItem(`Could not reopen the plan: ${(error as Error).message}`, 'error')
    }
  }

  return (
    <div ref={appRef} className="app-shell">
      <TitleBar />
      <main className="workspace" style={{ gridTemplateColumns: `${split}% ${dividerWidth}px 1fr` }}>
        <ChatPane
          provider={provider}
          onSetProvider={(nextProvider) => {
            if (nextProvider === provider) return
            window.localStorage.setItem(providerStorageKey, nextProvider)
            window.location.reload()
          }}
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
          selectedReasoningEffort={selectedReasoningEffort}
          collaborationMode={collaborationMode}
          planningState={planningState}
          onApprovePlan={() => void approvePlanningPlan()}
          onRequestPlanChanges={() => void requestPlanningChanges()}
          onSetCollaborationMode={(mode) => {
            setCollaborationMode(mode)
            window.localStorage.setItem(collaborationModeStorageKey, mode)
          }}
          onSelectModel={handleSelectModel}
          onSelectModelEffort={handleSelectModelEffort}
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
          focusedTarget={focusedTarget}
          visibleTargets={visibleTargets}
          conversationLayout={conversationLayout}
          onConversationLayoutChange={setConversationLayout}
          focusedLeafId={focusedLeafId}
          onFocusedLeafChange={setFocusedLeafId}
          onSelectConversation={handleSelectConversation}
          onRemoveConversationTarget={handleRemoveConversationTarget}
          onToggleWatchAgent={handleToggleWatchAgent}
          onSetAgentModel={handleSelectAgentModel}
          onSetAgentModelEffort={handleSelectAgentModelEffort}
          onNewAgent={handleNewAgent}
          onPromoteAgent={(key) => void handlePromoteAgent(key)}
          onCloseAgentSession={handleCloseAgentSession}
          onResetAgentSession={handleResetAgentSession}
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
  provider,
  onSetProvider,
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
  selectedReasoningEffort,
  collaborationMode,
  planningState,
  onApprovePlan,
  onRequestPlanChanges,
  onSetCollaborationMode,
  onSelectModel,
  onSelectModelEffort,
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
  focusedTarget,
  visibleTargets,
  conversationLayout,
  onConversationLayoutChange,
  focusedLeafId,
  onFocusedLeafChange,
  onSelectConversation,
  onRemoveConversationTarget,
  onToggleWatchAgent,
  onSetAgentModel,
  onSetAgentModelEffort,
  onNewAgent,
  onPromoteAgent,
  onCloseAgentSession,
  onResetAgentSession,
  onAgentSend,
  onAgentSteer,
  onAgentStop,
  onAgentCompact
}: {
  provider: AgentProvider
  onSetProvider: (provider: AgentProvider) => void
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
  selectedReasoningEffort: ReasoningEffort | null
  collaborationMode: 'default' | 'plan'
  planningState: PlanningState | null
  onApprovePlan: () => void
  onRequestPlanChanges: () => void
  onSetCollaborationMode: (mode: 'default' | 'plan') => void
  onSelectModel: (model: string) => void
  onSelectModelEffort: (model: string, effort: ReasoningEffort) => void
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
  focusedTarget: ConversationTarget
  visibleTargets: ConversationTarget[]
  conversationLayout: LayoutNode
  onConversationLayoutChange: (layout: LayoutNode) => void
  focusedLeafId: string
  onFocusedLeafChange: (leafId: string) => void
  onSelectConversation: (target: ConversationTarget) => void
  onRemoveConversationTarget: (target: ConversationTarget) => void
  onToggleWatchAgent: (key: string) => void
  onSetAgentModel: (key: string, model: string) => void
  onSetAgentModelEffort: (key: string, model: string, effort: ReasoningEffort) => void
  onNewAgent: () => void
  onPromoteAgent: (key: string) => void
  onCloseAgentSession: (key: string) => void
  onResetAgentSession: (key: string) => void
  onAgentSend: (key: string, text: string, attachments?: ChatAttachment[]) => Promise<boolean>
  onAgentSteer: (key: string, text: string) => Promise<boolean>
  onAgentStop: (key: string) => Promise<void>
  onAgentCompact: (key: string) => Promise<void>
}): React.JSX.Element {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isPluginBrowserOpen, setIsPluginBrowserOpen] = useState(false)
  const [installedPlugins, setInstalledPlugins] = useState<PluginSummary[]>([])
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

  const openPluginBrowser = (): void => {
    setIsSettingsOpen(false)
    setIsPluginBrowserOpen(true)
  }

  const closePluginBrowser = (): void => {
    setIsPluginBrowserOpen(false)
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.conversation-panel:not([hidden]) textarea, .agent-conversation-panel:not([hidden]) textarea')?.focus())
  }

  const closeAgent = (key: string): void => {
    onRemoveConversationTarget(key)
    onCloseAgentSession(key)
  }

  const promoteAgent = (key: string): void => {
    onSelectConversation('main')
    onPromoteAgent(key)
  }

  const isTiled = visibleTargets.length > 1

  return (
    <section
      className={`chat-pane ${isPluginBrowserOpen ? 'is-plugin-browser' : focusedTarget !== 'main' ? 'is-agent-view' : hasThreadContent ? 'is-thread' : 'is-empty'} ${isTiled ? 'is-tiled' : ''} ${isRestoring ? 'is-hydrating' : ''}`}
      aria-busy={isRestoring}
    >
      {isPluginBrowserOpen ? (
        <PluginBrowserView
          workspace={workspace}
          onClose={closePluginBrowser}
          onChanged={setInstalledPlugins}
        />
      ) : null}
      <div className={`chat-pane-content ${isPluginBrowserOpen ? 'is-hidden' : ''}`}>
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
        <ConversationTabStrip
          sessions={agentSessions}
          focusedTarget={focusedTarget}
          visibleTargets={visibleTargets}
          mainWorking={Boolean(activeTurnId)}
          onSelectMain={() => onSelectConversation('main')}
          onSelectAgent={onSelectConversation}
          onNewAgent={onNewAgent}
          onCloseAgent={closeAgent}
        />
      </div>

      <div className="conversation-panels">
        <ConversationLayoutTree
          layout={conversationLayout}
          focusedLeafId={focusedLeafId}
          onLayoutChange={onConversationLayoutChange}
          onFocusedLeafChange={onFocusedLeafChange}
          renderPane={(target, _leafId, focused) => {
            if (target === 'main') {
              return (
                <div
                  id="conversation-panel-main"
                  className="conversation-panel main-conversation-panel"
                  role="tabpanel"
                  aria-labelledby="conversation-tab-main"
                >
                  <ThreadScroll
                    resetKey={activeThreadId}
                    activeTurnId={activeTurnId}
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
                          turnId={row.turnId}
                          streaming={row.item.id === streamingMessageId}
                        />
                      )
                    })}
                  </ThreadScroll>

                  <div className={`composer-dock ${hasThreadContent ? 'is-docked' : 'is-centered'}`}>
                    <div className="composer-context">
                      <WorkspacePill workspace={workspace} onPickWorkspace={onPickWorkspace} />
                      {models.length ? (
                        <ModelPill
                          models={models}
                          selectedModel={selectedModel}
                          selectedEffort={selectedReasoningEffort}
                          onSelectModel={onSelectModel}
                          onSelectModelEffort={onSelectModelEffort}
                        />
                      ) : null}
                      <PlanModePill
                        active={collaborationMode === 'plan'}
                        disabled={isBusy}
                        onToggle={() => onSetCollaborationMode(collaborationMode === 'plan' ? 'default' : 'plan')}
                      />
                    </div>
                    <Composer
                      docked={hasThreadContent}
                      workspace={workspace}
                      installedPlugins={installedPlugins}
                      onInstalledPluginsChange={setInstalledPlugins}
                      onBrowsePlugins={openPluginBrowser}
                      isLoading={isRestoring || isBusy && !activeTurnId}
                      isTurnActive={Boolean(activeTurnId)}
                      status={isRestoring ? 'Restoring conversation' : activeTurnId ? 'Working' : status}
                      onSend={onSend}
                      onSteer={onSteer}
                      onStop={onStop}
                      onNewThread={onNewThread}
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
                        </div>
                      }
                    />
                  </div>
                </div>
              )
            }

            const session = agentSessions.find((entry) => entry.key === target)
            if (!session) {
              return (
                <div className="conversation-panel conversation-panel-empty">
                  <div className="agent-overlay-empty">This agent tab was closed.</div>
                </div>
              )
            }

            return (
              <AgentConversationPanel
                session={session}
                active={focused}
                models={models}
                mainModel={selectedModel}
                mainReasoningEffort={selectedReasoningEffort}
                onSetModel={onSetAgentModel}
                onSetModelEffort={onSetAgentModelEffort}
                onCloseSession={closeAgent}
                onResetSession={onResetAgentSession}
                onPromote={promoteAgent}
                onToggleWatch={onToggleWatchAgent}
                onSend={onAgentSend}
                onSteer={onAgentSteer}
                onStop={onAgentStop}
                onCompact={onAgentCompact}
              />
            )
          }}
        />
      </div>

      {isSettingsOpen ? (
        <SettingsModal
          provider={provider}
          onSetProvider={onSetProvider}
          goal={activeGoal}
          isGoalUpdating={Boolean(activeTurnId) || isGoalUpdating}
          onSaveGoal={onSaveGoal}
          onSetGoalStatus={onSetGoalStatus}
          onClearGoal={onClearGoal}
          onOpenPlugins={openPluginBrowser}
          onClose={() => setIsSettingsOpen(false)}
        />
      ) : null}
      {trace ? <TraceModal trace={trace} onClose={() => {
        traceLoadGenerationRef.current += 1
        setTraceTurnId(null)
        setStoredTrace(null)
      }} /> : null}
      </div>
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
      <section className={`task-activity-card ${live ? 'is-live' : ''}`} aria-label="In-task activity" aria-live={live ? 'polite' : 'off'}>
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
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function SettingsModal({
  provider,
  onSetProvider,
  goal,
  isGoalUpdating,
  onSaveGoal,
  onSetGoalStatus,
  onClearGoal,
  onOpenPlugins,
  onClose
}: {
  provider: AgentProvider
  onSetProvider: (provider: AgentProvider) => void
  goal: ThreadGoal | null
  isGoalUpdating: boolean
  onSaveGoal: (objective: string, tokenBudget: number | null) => Promise<boolean>
  onSetGoalStatus: (status: Extract<ThreadGoalStatus, 'active' | 'paused'>) => Promise<void>
  onClearGoal: () => Promise<void>
  onOpenPlugins: () => void
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
        <section className="settings-section">
          <h3 className="settings-section-title">Model provider</h3>
          <button
            type="button"
            className="settings-navigation-row"
            aria-pressed={provider === 'codex'}
            onClick={() => onSetProvider('codex')}
          >
            <span className="settings-row-text">
              <span className="settings-row-label">OpenAI Codex {provider === 'codex' ? '✓' : ''}</span>
              <span className="settings-row-hint">Codex app-server, Codex plugins, goals, and the shared browser harness.</span>
            </span>
          </button>
          <button
            type="button"
            className="settings-navigation-row"
            aria-pressed={provider === 'claude'}
            onClick={() => onSetProvider('claude')}
          >
            <span className="settings-row-text">
              <span className="settings-row-label">Anthropic Claude {provider === 'claude' ? '✓' : ''}</span>
              <span className="settings-row-hint">Claude Agent SDK with the same embedded browser and research tools.</span>
            </span>
          </button>
        </section>
        <section className="settings-section">
          <h3 className="settings-section-title">Thread goal</h3>
          {provider === 'codex' ? (
            <GoalSettings
              goal={goal}
              disabled={isGoalUpdating}
              onSave={onSaveGoal}
              onSetStatus={onSetGoalStatus}
              onClear={onClearGoal}
            />
          ) : <p className="settings-row-hint">Persistent thread goals are currently a Codex capability.</p>}
        </section>
        {provider === 'codex' ? <section className="settings-section">
          <h3 className="settings-section-title">Extensions</h3>
          <button type="button" className="settings-navigation-row" onClick={onOpenPlugins}>
            <span className="settings-row-text">
              <span className="settings-row-label">Plugin Settings</span>
              <span className="settings-row-hint">Browse, install, and remove plugins available through @ mentions.</span>
            </span>
            <span className="settings-navigation-arrow" aria-hidden="true">→</span>
          </button>
        </section> : null}
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
  resetKey,
  activeTurnId
}: {
  children: React.ReactNode
  dependencies: unknown[]
  resetKey: string | null
  activeTurnId: string | null
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const spacerRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const frameRef = useRef<number | null>(null)
  const settleFrameRef = useRef<number | null>(null)
  // The rAF scheduled on a live send to run anchorTop once the new user row has
  // committed. Tracked so the reset effect and unmount cleanup can cancel it
  // (like frameRef/settleFrameRef) — otherwise it can fire against a torn-down
  // or reset component.
  const anchorFrameRef = useRef<number | null>(null)
  // While non-null, this turn's user message is anchored to the top of the
  // viewport (the answer streams into the space below). This mode overrides
  // bottom-follow and releases the moment the reader scrolls.
  const anchorTurnRef = useRef<string | null>(null)
  const prevTurnRef = useRef<string | null>(null)
  // A fresh/restored thread may arrive with activeTurnId already set for an
  // in-progress turn; that must NOT yank it to the top — only a live send does.
  const justResetRef = useRef(false)
  // Programmatic scrollTop writes fire onScroll; without this guard the first
  // anchor write would immediately release the anchor (bottom-pin doesn't need
  // it because it re-pins to the same value).
  const suppressScrollRef = useRef(false)
  const [spacerOn, setSpacerOn] = useState(false)

  const cancelScheduledFollow = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    if (settleFrameRef.current !== null) {
      window.cancelAnimationFrame(settleFrameRef.current)
      settleFrameRef.current = null
    }
    if (anchorFrameRef.current !== null) {
      window.cancelAnimationFrame(anchorFrameRef.current)
      anchorFrameRef.current = null
    }
  }, [])

  // Scroll the anchored turn's user message to the top of the viewport, sizing
  // a trailing spacer so there is always room to scroll it that far even before
  // the answer fills in.
  const anchorTop = useCallback(() => {
    const el = ref.current
    const turnId = anchorTurnRef.current
    if (!el || !turnId) return

    const node = el.querySelector<HTMLElement>(
      `.message-user[data-turn-id="${CSS.escape(turnId)}"]`
    )
    if (!node) return

    // Small breathing room so the message sits just below the viewport top
    // rather than flush against (or clipped above) the edge.
    const topGap = 12

    // Size the trailing spacer to the exact shortfall of room below the user
    // message, so it can reach the top without leaving more than one viewport
    // of slack. Measured from the DOM, immune to offsetParent/padding quirks.
    const spacer = spacerRef.current
    if (spacer) {
      const priorSpacer = spacer.offsetHeight
      const elRect = el.getBoundingClientRect()
      const nodeRect = node.getBoundingClientRect()
      const nodeTopWithin = nodeRect.top - elRect.top + el.scrollTop
      const contentBelow = el.scrollHeight - priorSpacer - nodeTopWithin
      const needed = Math.max(0, el.clientHeight - contentBelow - topGap)
      const nextHeight = `${needed}px`
      if (spacer.style.height !== nextHeight) spacer.style.height = nextHeight
    }

    // Scroll by the measured delta between the message top and the viewport top
    // (minus the gap), rather than computing an absolute offsetTop target.
    const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - topGap
    if (Math.abs(delta) > 1) {
      suppressScrollRef.current = true
      el.scrollTop += delta
    }
  }, [])

  const followTail = useCallback(() => {
    // Top-anchor mode owns the scroll position while active.
    if (anchorTurnRef.current !== null) {
      anchorTop()
      return
    }
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
        suppressScrollRef.current = true
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
              suppressScrollRef.current = true
              settled.scrollTop = settledTarget
            }
          }
        })
      }
    })
  }, [anchorTop])

  const handleScroll = useCallback(() => {
    // Ignore the scroll events our own programmatic writes produce.
    if (suppressScrollRef.current) {
      suppressScrollRef.current = false
      return
    }

    const el = ref.current
    if (!el) {
      return
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distanceFromBottom <= 48

    // A deliberate scroll releases the top-anchor, exactly like it releases
    // bottom-follow — the reader is now driving.
    if (anchorTurnRef.current !== null) {
      anchorTurnRef.current = null
      setSpacerOn(false)
    }

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
    anchorTurnRef.current = null
    prevTurnRef.current = null
    justResetRef.current = true
    setSpacerOn(false)
    pinnedRef.current = true
    followTail()
  }, [cancelScheduledFollow, followTail, resetKey])

  useLayoutEffect(() => {
    followTail()
    // The caller supplies render-driving state rather than a single scalar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies)

  // A live send (activeTurnId transitions to a new non-null value) anchors that
  // turn's user message to the top. Skip the transition that coincides with a
  // thread switch/restore — that turn is being read, not just asked.
  useLayoutEffect(() => {
    if (
      activeTurnId !== null &&
      activeTurnId !== prevTurnRef.current &&
      !justResetRef.current
    ) {
      anchorTurnRef.current = activeTurnId
      pinnedRef.current = false
      cancelScheduledFollow()
      setSpacerOn(true)
      // The new user row + spacer land next commit; anchor once they exist.
      // Tracked so reset/unmount can cancel it before it fires.
      anchorFrameRef.current = window.requestAnimationFrame(() => {
        anchorFrameRef.current = null
        anchorTop()
      })
    } else if (activeTurnId === null && anchorTurnRef.current !== null) {
      // The turn finished. Stop actively re-anchoring, but FREEZE the current
      // scroll position so the message/answer don't snap back down. Removing the
      // spacer entirely would shrink scrollHeight below the current scrollTop and
      // the browser would clamp it (the snap). Instead, size the spacer to the
      // exact minimum that preserves scrollTop — 0 if the answer already fills
      // the viewport, otherwise just enough to hold position (no excess).
      anchorTurnRef.current = null
      const el = ref.current
      const spacer = spacerRef.current
      if (el && spacer) {
        const priorSpacer = spacer.offsetHeight
        const contentWithoutSpacer = el.scrollHeight - priorSpacer
        const needed = Math.max(0, el.scrollTop + el.clientHeight - contentWithoutSpacer)
        if (needed <= 0) {
          setSpacerOn(false)
        } else {
          spacer.style.height = `${needed}px`
        }
      } else {
        setSpacerOn(false)
      }
      // The reader is no longer following the live edge; leave bottom-follow off
      // until they scroll back down themselves.
      pinnedRef.current = false
    }
    prevTurnRef.current = activeTurnId
    justResetRef.current = false
  }, [activeTurnId, anchorTop, cancelScheduledFollow])

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
        {spacerOn ? (
          <div ref={spacerRef} className="thread-scroll-anchor-spacer" aria-hidden="true" />
        ) : null}
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function asClaudeEffort(value: ReasoningEffort | null): ClaudeEffort | null {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
    ? value
    : null
}

function claudeModelToUiModel(model: AgentModel, index: number): Model {
  const efforts = model.supportedEfforts.filter((effort) => effort !== 'max')
  const defaultEffort = efforts.includes('high') ? 'high' : efforts[0] ?? 'high'
  return {
    id: model.id,
    model: model.id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: model.displayName,
    description: model.description,
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} Claude effort`
    })),
    defaultReasoningEffort: defaultEffort,
    inputModalities: model.inputModalities,
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: model.isDefault || index === 0
  }
}

const ChatItemView = memo(function ChatItemView({
  item,
  meta,
  streaming,
  turnId
}: {
  item: ChatItem
  meta?: ItemMeta
  streaming: boolean
  turnId?: string | null
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
      <article className="message message-user" data-turn-id={turnId ?? undefined}>
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

function PlanModePill({
  active,
  disabled,
  onToggle
}: {
  active: boolean
  disabled: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`plan-mode-pill ${active ? 'is-active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      title={active
        ? 'Collaborative planning is on: research, challenge assumptions, agree on a plan, then implement and validate.'
        : 'Collaborate on an evidence-backed plan before implementation.'}
      onClick={onToggle}
    >
      <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M5.5 5.25h9M5.5 10h9M5.5 14.75h5.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="m2.75 5.25.85.85 1.45-1.7M2.75 10l.85.85 1.45-1.7M2.75 14.75l.85.85 1.45-1.7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>Plan</span>
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

// Thread-scoped goal controls live in settings so the composer remains focused
// on composing, while preserving the app-server goal lifecycle and usage data.
function GoalSettings({
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
  const [objective, setObjective] = useState(goal?.objective ?? '')
  const [tokenBudget, setTokenBudget] = useState(goal?.tokenBudget ? String(goal.tokenBudget) : '')

  useEffect(() => {
    setObjective(goal?.objective ?? '')
    setTokenBudget(goal?.tokenBudget ? String(goal.tokenBudget) : '')
  }, [goal?.objective, goal?.tokenBudget])

  const submitGoal = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const parsedBudget = tokenBudget.trim() ? Number(tokenBudget) : null
    if (parsedBudget !== null && (!Number.isFinite(parsedBudget) || parsedBudget <= 0)) return

    const saved = await onSave(
      objective,
      parsedBudget === null ? null : Math.floor(parsedBudget)
    )
    if (!saved) return
  }

  return (
    <div className="goal-settings">
      <div className="goal-settings-heading">
        <div>
          <p className="goal-settings-label">Keep this thread working toward a persistent objective.</p>
        </div>
        {goal ? (
          <span className="goal-settings-status">
            <span className={`goal-status-dot is-${goal.status}`} aria-hidden="true" />
            {goalStatusLabel(goal.status)}
          </span>
        ) : null}
      </div>
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
  workspace,
  installedPlugins,
  onInstalledPluginsChange,
  onBrowsePlugins,
  isLoading,
  isTurnActive,
  status,
  onSend,
  onSteer,
  onStop,
  onNewThread,
  footerExtras
}: {
  docked: boolean
  workspace: string | null
  installedPlugins: PluginSummary[]
  onInstalledPluginsChange: (plugins: PluginSummary[]) => void
  onBrowsePlugins: () => void
  isLoading: boolean
  isTurnActive: boolean
  status: string
  onSend: (text: string, attachments?: ChatAttachment[]) => Promise<boolean>
  onSteer: (text: string) => Promise<boolean>
  onStop: () => Promise<void>
  onNewThread: () => void
  footerExtras?: React.ReactNode
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [pluginMenuState, setPluginMenuState] = useState<'closed' | 'loading' | 'ready' | 'error'>('closed')
  const [pluginSelectionIndex, setPluginSelectionIndex] = useState(0)
  const pluginMention = value.match(/(?:^|\s)@([^\s@]*)$/)
  const pluginQuery = pluginMention?.[1].toLowerCase() ?? null
  const hasDraft = Boolean(value.trim() || attachments.length)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(190, Math.max(54, textarea.scrollHeight))}px`
  }, [value])

  useEffect(() => {
    if (pluginQuery === null || isLoading) {
      setPluginMenuState('closed')
      return
    }

    let cancelled = false
    setPluginMenuState('loading')
    void window.api.codex.listInstalledPlugins({ cwd: workspace }).then((result) => {
      if (cancelled) return
      onInstalledPluginsChange(flattenPlugins(result.marketplaces).filter((plugin) => plugin.installed))
      setPluginMenuState('ready')
    }, () => {
      if (!cancelled) setPluginMenuState('error')
    })
    return () => { cancelled = true }
  }, [pluginQuery !== null, workspace, isLoading, onInstalledPluginsChange])

  useEffect(() => setPluginSelectionIndex(0), [pluginQuery])

  const mentionPlugins = installedPlugins.filter((plugin) => {
    const name = plugin.interface?.displayName || plugin.name
    return !pluginQuery || name.toLowerCase().includes(pluginQuery) || plugin.keywords.some((keyword) => keyword.toLowerCase().includes(pluginQuery))
  })

  const choosePlugin = (plugin: PluginSummary): void => {
    const match = value.match(/(?:^|\s)@([^\s@]*)$/)
    if (!match || match.index === undefined) return
    const leadingSpace = match[0].startsWith(' ') ? ' ' : ''
    const name = plugin.interface?.displayName || plugin.name
    setValue(`${value.slice(0, match.index)}${leadingSpace}@${name} `)
    setPluginMenuState('closed')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

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
      {pluginMenuState !== 'closed' ? (
        <PluginMentionMenu
          state={pluginMenuState}
          plugins={mentionPlugins}
          selectedIndex={pluginSelectionIndex}
          onChoose={choosePlugin}
          onBrowse={() => { setPluginMenuState('closed'); onBrowsePlugins() }}
          onUninstalled={(pluginId) => onInstalledPluginsChange(installedPlugins.filter((plugin) => plugin.id !== pluginId))}
        />
      ) : null}
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
          if (event.key === 'Escape' && pluginMenuState !== 'closed') {
            event.preventDefault()
            setPluginMenuState('closed')
            return
          }
          if (pluginMenuState === 'ready' && mentionPlugins.length && event.key === 'ArrowDown') {
            event.preventDefault()
            setPluginSelectionIndex((current) => (current + 1) % mentionPlugins.length)
            return
          }
          if (pluginMenuState === 'ready' && mentionPlugins.length && event.key === 'ArrowUp') {
            event.preventDefault()
            setPluginSelectionIndex((current) => (current - 1 + mentionPlugins.length) % mentionPlugins.length)
            return
          }
          if (pluginMenuState === 'ready' && mentionPlugins.length && event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            choosePlugin(mentionPlugins[Math.min(pluginSelectionIndex, mentionPlugins.length - 1)])
            return
          }
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
          <div className="composer-primary-action">
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
            ) : hasDraft ? (
              <button
                type="submit"
                className="send-button"
                aria-label="Send message"
                disabled={isLoading}
              >
                <SendArrowIcon />
              </button>
            ) : (
              <button
                type="button"
                className="send-button composer-new-chat"
                aria-label="New chat"
                title="New chat"
                disabled={isLoading}
                onClick={onNewThread}
              >
                <NewChatIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  )
}

function flattenPlugins(marketplaces: PluginMarketplaceEntry[]): PluginSummary[] {
  return [...new Map(marketplaces.flatMap((marketplace) => marketplace.plugins).map((plugin) => [plugin.id, plugin])).values()]
}

function PluginGlyph({ plugin }: { plugin: PluginSummary }): React.JSX.Element {
  const icon = plugin.interface?.composerIconUrl || plugin.interface?.logoUrlDark || plugin.interface?.logoUrl
  if (icon) return <img src={icon} alt="" />
  const name = plugin.interface?.displayName || plugin.name
  return <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
}

function TrashIcon(): React.JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function PluginMentionMenu({ state, plugins, selectedIndex, onChoose, onBrowse, onUninstalled }: {
  state: 'loading' | 'ready' | 'error'
  plugins: PluginSummary[]
  selectedIndex: number
  onChoose: (plugin: PluginSummary) => void
  onBrowse: () => void
  onUninstalled: (pluginId: string) => void
}): React.JSX.Element {
  const [removing, setRemoving] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)

  const remove = (plugin: PluginSummary): void => {
    if (armed !== plugin.id) {
      setArmed(plugin.id)
      return
    }
    const uninstallId = pluginUninstallId(plugin)
    if (!uninstallId) return
    setRemoving(plugin.id)
    void window.api.codex.uninstallPlugin(uninstallId).then(() => {
      onUninstalled(plugin.id)
      setArmed(null)
    }).finally(() => setRemoving(null))
  }

  return (
    <div className="plugin-mention-menu" role="listbox" aria-label="Installed plugins">
      <div className="plugin-mention-heading"><span>Installed plugins</span><span>{plugins.length || ''}</span></div>
      <div className="plugin-mention-list">
        {state === 'loading' ? <div className="plugin-menu-message shimmer-text">Loading plugins…</div> : null}
        {state === 'error' ? <div className="plugin-menu-message">Plugins could not be loaded.</div> : null}
        {state === 'ready' && !plugins.length ? <div className="plugin-menu-message">No matching installed plugins.</div> : null}
        {state === 'ready' ? plugins.map((plugin, index) => (
          <div className={`plugin-mention-row ${selectedIndex === index ? 'is-selected' : ''}`} key={plugin.id} role="option" aria-selected={selectedIndex === index}>
            <button type="button" className="plugin-mention-select" onClick={() => onChoose(plugin)}>
              <span className="plugin-glyph"><PluginGlyph plugin={plugin} /></span>
              <span className="plugin-mention-copy"><strong>{plugin.interface?.displayName || plugin.name}</strong><small>{plugin.interface?.shortDescription || plugin.interface?.capabilities.slice(0, 2).join(' · ') || 'Plugin'}</small></span>
            </button>
            <button type="button" className={`plugin-remove ${armed === plugin.id ? 'is-armed' : ''}`} aria-label={armed === plugin.id ? `Confirm remove ${plugin.name}` : `Remove ${plugin.name}`} title={armed === plugin.id ? 'Click again to remove' : 'Remove plugin'} disabled={removing === plugin.id} onClick={() => remove(plugin)}>
              {armed === plugin.id ? <span>Remove</span> : <TrashIcon />}
            </button>
          </div>
        )) : null}
      </div>
      <button type="button" className="browse-plugins-button" onClick={onBrowse}><span>Browse plugins</span><span aria-hidden="true">↗</span></button>
    </div>
  )
}

type PluginConnectionInfo = {
  apps: AppSummary[]
  needsAuth: AppSummary[]
}

type PluginSetupFlow = {
  plugin: PluginSummary
  apps: AppSummary[]
  authPolicy: PluginAuthPolicy
  phase: 'prompt' | 'opening' | 'waiting' | 'success' | 'error' | 'timeout'
  activeAppId: string | null
  authTabId: string | null
  error: string | null
}

function PluginBrowserView({ workspace, onClose, onChanged }: {
  workspace: string | null
  onClose: () => void
  onChanged: (plugins: PluginSummary[]) => void
}): React.JSX.Element {
  const [marketplaces, setMarketplaces] = useState<PluginMarketplaceEntry[]>([])
  const [query, setQuery] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [connectionByPluginId, setConnectionByPluginId] = useState<Record<string, PluginConnectionInfo>>({})
  const [setup, setSetup] = useState<PluginSetupFlow | null>(null)
  const [isCheckingAuth, setIsCheckingAuth] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  const refreshConnections = useCallback(async (nextMarketplaces: PluginMarketplaceEntry[]): Promise<void> => {
    const installed = nextMarketplaces.flatMap((marketplace) =>
      marketplace.plugins.filter((plugin) => plugin.installed).map((plugin) => ({ marketplace, plugin }))
    )
    if (!installed.length) {
      setConnectionByPluginId({})
      return
    }

    const detailResults = await Promise.allSettled(installed.map(async ({ marketplace, plugin }) => {
      const params = pluginInstallParams(plugin, marketplace)
      if (!params) return { pluginId: plugin.id, apps: [] as AppSummary[] }
      const response = await window.api.codex.readPlugin(params)
      return { pluginId: plugin.id, apps: response.plugin.apps }
    }))
    const appGroups = detailResults.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const appIds = [...new Set(appGroups.flatMap((group) => group.apps.map((app) => app.id)))]
    const statuses = appIds.length
      ? (await window.api.codex.getPluginAppStatuses({ appIds })).apps
      : []
    const nextConnections: Record<string, PluginConnectionInfo> = {}
    for (const group of appGroups) {
      nextConnections[group.pluginId] = {
        apps: group.apps,
        needsAuth: unresolvedPluginApps(group.apps, statuses)
      }
    }
    setConnectionByPluginId(nextConnections)
  }, [])

  const load = useCallback(async (showLoading = true): Promise<void> => {
    if (showLoading) setState('loading')
    try {
      const result = await window.api.codex.listPlugins({ cwd: workspace })
      setMarketplaces(result.marketplaces)
      onChanged(flattenPlugins(result.marketplaces).filter((plugin) => plugin.installed))
      setState('ready')
      void refreshConnections(result.marketplaces).catch(() => {})
    } catch {
      setState('error')
    }
  }, [workspace, onChanged, refreshConnections])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    closeRef.current?.focus()
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const plugins = flattenPlugins(marketplaces).filter((plugin) => {
    const haystack = [plugin.name, plugin.interface?.displayName, plugin.interface?.shortDescription, plugin.interface?.category, ...plugin.keywords].filter(Boolean).join(' ').toLowerCase()
    return !query.trim() || haystack.includes(query.trim().toLowerCase())
  })

  const firstMarketplaceByPluginId = new Map<string, PluginMarketplaceEntry>()
  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      if (!firstMarketplaceByPluginId.has(plugin.id)) firstMarketplaceByPluginId.set(plugin.id, marketplace)
    }
  }

  const beginConnection = (plugin: PluginSummary, apps: AppSummary[], authPolicy = plugin.authPolicy): void => {
    setActionError(null)
    setSetup({ plugin, apps, authPolicy, phase: 'prompt', activeAppId: null, authTabId: null, error: null })
  }

  const install = async (plugin: PluginSummary, marketplace: PluginMarketplaceEntry | undefined): Promise<void> => {
    const params = pluginInstallParams(plugin, marketplace)
    if (!params) {
      setActionError(`${plugin.interface?.displayName || plugin.name} is missing its remote installation identifier.`)
      return
    }
    setActionError(null)
    setBusyId(plugin.id)
    try {
      const result = await window.api.codex.installPlugin(params)
      await load(false)
      if (result.appsNeedingAuth.length) {
        setConnectionByPluginId((current) => ({
          ...current,
          [plugin.id]: { apps: result.appsNeedingAuth, needsAuth: result.appsNeedingAuth }
        }))
        beginConnection({ ...plugin, installed: true, enabled: true }, result.appsNeedingAuth, result.authPolicy)
      } else {
        setSetup({
          plugin: { ...plugin, installed: true, enabled: true },
          apps: [],
          authPolicy: result.authPolicy,
          phase: 'success',
          activeAppId: null,
          authTabId: null,
          error: null
        })
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Could not install ${plugin.name}.`)
    } finally {
      setBusyId(null)
    }
  }

  const uninstall = async (plugin: PluginSummary): Promise<void> => {
    const uninstallId = pluginUninstallId(plugin)
    if (!uninstallId) {
      setActionError(`${plugin.interface?.displayName || plugin.name} is missing its remote installation identifier.`)
      return
    }
    setActionError(null)
    setBusyId(plugin.id)
    try {
      await window.api.codex.uninstallPlugin(uninstallId)
      setSetup((current) => current?.plugin.id === plugin.id ? null : current)
      await load(false)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Could not remove ${plugin.name}.`)
    } finally {
      setBusyId(null)
    }
  }

  const openAuthentication = async (): Promise<void> => {
    const app = setup?.apps[0]
    const installUrl = safePluginAuthUrl(app?.installUrl)
    if (!setup || !app || !installUrl) {
      setSetup((current) => current ? { ...current, phase: 'error', error: 'This connector did not provide a trusted ChatGPT authentication page.' } : current)
      return
    }
    setSetup((current) => current ? { ...current, phase: 'opening', activeAppId: app.id, error: null } : current)
    try {
      const tabId = await window.api.browser.newTab(installUrl)
      if (!tabId) throw new Error('The authentication tab could not be opened.')
      setSetup((current) => current ? { ...current, phase: 'waiting', authTabId: tabId } : current)
    } catch (error) {
      setSetup((current) => current ? {
        ...current,
        phase: 'error',
        error: error instanceof Error ? error.message : 'The authentication tab could not be opened.'
      } : current)
    }
  }

  const verifyAuthentication = useCallback(async (): Promise<void> => {
    if (!setup || setup.phase !== 'waiting') return
    setIsCheckingAuth(true)
    try {
      const response = await window.api.codex.getPluginAppStatuses({
        appIds: setup.apps.map((app) => app.id),
        forceRefetch: true
      })
      const remaining = unresolvedPluginApps(setup.apps, response.apps)
      setConnectionByPluginId((current) => ({
        ...current,
        [setup.plugin.id]: { apps: setup.apps, needsAuth: remaining }
      }))
      if (!remaining.length) {
        if (setup.authTabId) void window.api.browser.closeTab(setup.authTabId)
        setSetup((current) => current?.plugin.id === setup.plugin.id ? {
          ...current,
          phase: 'success',
          apps: [],
          activeAppId: null,
          authTabId: null,
          error: null
        } : current)
        await load(false)
      } else if (remaining.length < setup.apps.length) {
        if (setup.authTabId) void window.api.browser.closeTab(setup.authTabId)
        setSetup((current) => current?.plugin.id === setup.plugin.id ? {
          ...current,
          phase: 'prompt',
          apps: remaining,
          activeAppId: null,
          authTabId: null,
          error: null
        } : current)
      }
    } catch (error) {
      setSetup((current) => current?.plugin.id === setup.plugin.id ? {
        ...current,
        phase: 'error',
        error: error instanceof Error ? error.message : 'Could not verify the connection.'
      } : current)
    } finally {
      setIsCheckingAuth(false)
    }
  }, [setup, load])

  useEffect(() => {
    if (!setup || setup.phase !== 'waiting') return
    const pluginId = setup.plugin.id
    let lastLoadedUrl = ''
    const dispose = window.api.browser.onState((browser) => {
      const tab = browser.tabs.find((candidate) => candidate.id === setup.authTabId)
      if (!tab || (!tab.isLoading && tab.url !== lastLoadedUrl)) {
        lastLoadedUrl = tab?.url ?? ''
        void verifyAuthentication()
      }
    })
    const interval = window.setInterval(() => void verifyAuthentication(), 5_000)
    const timeout = window.setTimeout(() => {
      setSetup((current) => current?.plugin.id === pluginId && current.phase === 'waiting'
        ? { ...current, phase: 'timeout', error: 'Still waiting for ChatGPT to confirm this connection.' }
        : current)
    }, 120_000)
    void verifyAuthentication()
    return () => {
      dispose()
      window.clearInterval(interval)
      window.clearTimeout(timeout)
    }
  }, [setup?.plugin.id, setup?.phase, setup?.authTabId, verifyAuthentication])

  const dismissSetup = (): void => {
    if (setup?.authTabId) void window.api.browser.closeTab(setup.authTabId)
    setSetup(null)
  }

  return (
      <section className="plugin-browser-view" aria-labelledby="plugin-browser-title">
        <header className="plugin-browser-header">
          <button ref={closeRef} type="button" className="plugin-browser-back" aria-label="Back to chat" title="Back to chat" onClick={onClose}><span aria-hidden="true">←</span></button>
          <h2 id="plugin-browser-title">Plugins</h2>
        </header>
        <div className="plugin-browser-tools"><label><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search plugins and capabilities" aria-label="Search plugins" /></label></div>
        <div className="plugin-browser-catalog">
          {setup ? (
            <PluginSetupPanel
              setup={setup}
              checking={isCheckingAuth}
              onConnect={() => void openAuthentication()}
              onCheck={() => void verifyAuthentication()}
              onRetry={() => setSetup((current) => current ? { ...current, phase: current.authTabId ? 'waiting' : 'prompt', error: null } : current)}
              onDismiss={dismissSetup}
            />
          ) : null}
          {actionError ? <div className="plugin-action-error" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError(null)} aria-label="Dismiss error">×</button></div> : null}
          {state === 'loading' ? <div className="plugin-browser-state shimmer-text">Loading plugin catalog…</div> : null}
          {state === 'error' ? <div className="plugin-browser-state">The plugin catalog could not be loaded. <button type="button" onClick={() => void load()}>Try again</button></div> : null}
          {state === 'ready' && !plugins.length ? <div className="plugin-browser-state">No plugins match that search.</div> : null}
          {state === 'ready' && plugins.length ? (
            <section className="plugin-browser-group">
              <h3>Codex Desktop plugins</h3>
              <div className="plugin-browser-grid">
                {plugins.map((plugin) => {
                  const name = plugin.interface?.displayName || plugin.name
                  const marketplace = firstMarketplaceByPluginId.get(plugin.id)
                  const connection = connectionByPluginId[plugin.id]
                  const needsAuth = Boolean(connection?.needsAuth.length)
                  const action = busyId === plugin.id ? 'Working…' : needsAuth ? 'Connect' : plugin.installed ? 'Remove' : plugin.availability === 'AVAILABLE' ? 'Get' : 'Unavailable'
                  const status = plugin.installed
                    ? needsAuth ? 'Connection required' : connection?.apps.length ? 'Connected' : 'Ready'
                    : null
                  return <article className="plugin-browser-card" key={plugin.id}>
                    <span className="plugin-glyph is-large"><PluginGlyph plugin={plugin} /></span>
                    <div className="plugin-browser-card-copy"><h4>{name}</h4><p>{plugin.interface?.shortDescription || plugin.interface?.longDescription || 'Adds focused capabilities to Codex Desktop.'}</p>{status ? <span className={`plugin-card-status ${needsAuth ? 'needs-auth' : 'is-ready'}`}><i aria-hidden="true" />{status}</span> : null}</div>
                    <div className="plugin-card-actions">
                      <button type="button" className={`plugin-install-button ${plugin.installed && !needsAuth ? 'is-installed' : ''} ${needsAuth ? 'needs-auth' : ''}`} aria-label={`${action} ${name}`} disabled={busyId === plugin.id || plugin.availability !== 'AVAILABLE'} onClick={() => needsAuth ? beginConnection(plugin, connection.needsAuth) : plugin.installed ? void uninstall(plugin) : void install(plugin, marketplace)}>{action}</button>
                      {needsAuth ? <button type="button" className="plugin-remove-link" disabled={busyId === plugin.id} onClick={() => void uninstall(plugin)}>Remove</button> : null}
                    </div>
                  </article>
                })}
              </div>
            </section>
          ) : null}
        </div>
      </section>
  )
}

function PluginSetupPanel({ setup, checking, onConnect, onCheck, onRetry, onDismiss }: {
  setup: PluginSetupFlow
  checking: boolean
  onConnect: () => void
  onCheck: () => void
  onRetry: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const pluginName = setup.plugin.interface?.displayName || setup.plugin.name
  const appName = setup.apps[0]?.name || pluginName
  const isSuccess = setup.phase === 'success'
  const isProblem = setup.phase === 'error' || setup.phase === 'timeout'
  const title = isSuccess
    ? `${pluginName} is ready`
    : setup.phase === 'waiting'
      ? `Finish connecting ${appName}`
      : isProblem
        ? `Connection needs attention`
        : `${pluginName} is installed`
  const copy = isSuccess
    ? 'Its skills and connected tools will be available in your next chat.'
    : setup.phase === 'waiting'
      ? 'Complete the sign-in in the browser. This page will update automatically when ChatGPT confirms access.'
      : setup.phase === 'timeout'
        ? 'The plugin is still installed. Keep the authentication page open and check again, or finish later.'
        : setup.phase === 'error'
          ? setup.error || 'The connection could not be verified.'
          : `${appName} needs your permission before its connected tools can be used.`

  return (
    <section className={`plugin-setup-panel is-${isSuccess ? 'success' : isProblem ? 'problem' : setup.phase}`} aria-live="polite">
      <span className="plugin-setup-icon" aria-hidden="true">{isSuccess ? '✓' : isProblem ? '!' : '↗'}</span>
      <div className="plugin-setup-copy">
        <div className="plugin-setup-heading"><span>{isSuccess ? 'Setup complete' : setup.phase === 'waiting' ? 'Browser connection' : 'One more step'}</span><strong>{title}</strong></div>
        <p>{copy}</p>
        {setup.phase === 'waiting' ? <div className="plugin-setup-progress"><span className="plugin-setup-spinner" aria-hidden="true" /><span>{checking ? 'Checking connection…' : 'Waiting for authorization…'}</span></div> : null}
      </div>
      <div className="plugin-setup-actions">
        {setup.phase === 'prompt' ? <button type="button" className="plugin-setup-primary" onClick={onConnect}>Connect {appName}</button> : null}
        {setup.phase === 'opening' ? <button type="button" className="plugin-setup-primary" disabled>Opening browser…</button> : null}
        {setup.phase === 'waiting' ? <button type="button" className="plugin-setup-primary" disabled={checking} onClick={onCheck}>{checking ? 'Checking…' : 'Check now'}</button> : null}
        {isProblem ? <button type="button" className="plugin-setup-primary" onClick={onRetry}>Try again</button> : null}
        <button type="button" className="plugin-setup-secondary" onClick={onDismiss}>{isSuccess ? 'Done' : 'Finish later'}</button>
      </div>
    </section>
  )
}

function persistLastThreadId(threadId: string | null, provider: AgentProvider): void {
  const storageKey = threadStorageKey(provider)
  if (threadId) {
    window.localStorage.setItem(storageKey, threadId)
  } else {
    window.localStorage.removeItem(storageKey)
  }
}

function threadStorageKey(provider: AgentProvider): string {
  return provider === 'claude' ? claudeLastThreadStorageKey : lastThreadStorageKey
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
