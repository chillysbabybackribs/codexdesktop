import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AgentColumn, AgentTabStrip, SendArrowIcon } from './AgentDock';
import { ModelPill } from './ModelPill';
import type { AgentSession } from './AgentDock';
import type {
  BrowserBounds,
  BrowserState,
  MemoryPersistParams,
} from '../../shared/ipc';
import type { ServerNotification } from '../../shared/session-protocol';
import type { ReasoningEffort } from '../../shared/session-protocol';
import type { CodexErrorInfo } from '../../shared/session-protocol';
import type { TurnError } from '../../shared/session-protocol';
import type { Model } from '../../shared/session-protocol';
import type { Thread } from '../../shared/session-protocol';
import type { ThreadGoal } from '../../shared/session-protocol';
import type { ThreadGoalStatus } from '../../shared/session-protocol';
import type { ThreadItem } from '../../shared/session-protocol';
import type { ThreadTokenUsage } from '../../shared/session-protocol';
import type { PluginSummary } from '../../shared/session-protocol';
import type { Turn } from '../../shared/session-protocol';
import { summarizeTurnDiff } from './diff';
import { TraceModal, formatTokens } from './TraceModal';
import { buildTurnTrace, isTurnTrace, type TurnTrace } from './trace';
import {
  modelCallAttributionForItem,
  reduceTurnTelemetry,
} from './turn-telemetry';
import {
  AutoFollow,
  FileReviewContext,
  TurnTail,
  WorkGroup,
  type FileReviewActions,
  type ItemMeta,
  type TurnMeta,
  type TurnPlanItem,
  type WorkItem,
} from './TaskActivity';
import { ReviewBar, type ReviewChange } from './ReviewBar';
import {
  buildMentionContext,
  rankMentionCandidates,
  stripMentionContext,
  type FileMention,
  type MentionCandidate,
} from './mention-model';
import { selectCompletedWork } from './memory-work';
import {
  AttachmentButton,
  AttachmentStrip,
  attachmentsFromUserInput,
  saveBrowserFiles,
} from './Attachments';
import type { ChatAttachment } from '../../shared/ipc';
import {
  buildRows,
  isWorkItem,
  upsertMany,
  type ActivityItem,
  type ChatItem,
  type SystemItem,
} from './transcript-model';
import {
  isImmediateItemNotification,
  isItemNotification,
  reduceItemNotificationItems,
  reduceItemNotificationMeta,
  type ItemNotification,
} from './item-notifications';
import { reduceResearchProgressMeta } from './activity-model';
import { BrowserPane } from './BrowserPane';
import { MarkdownContent, StreamingMarkdownContent } from './MarkdownContent';
import {
  SessionStore,
  emptySessionState,
  reduceSessionNotification,
  type SessionRenderState,
} from './session-store';
import { parseTranscriptSession, serializeTranscriptSession } from './transcript-cache-model';
import {
  buildAuditFeedbackMessage,
  buildAuditPrompt,
  liveTurnGlance,
  parseAuditFeedback,
  parseAuditVerdict,
  shouldSendAuditFeedback,
  shouldTriggerAudit,
  turnAnswerText,
  turnChangedFiles,
  turnStepLines,
} from './audit-trigger';
import {
  liteMessagesFromItems,
  restoreAgentDock as restorePersistedAgentDock,
} from './agent-dock-restore';
import { createAgentCommands } from './agent-commands';
import { createAgentLifecycle } from './agent-lifecycle';
import { useAgentSessions } from './useAgentSessions';
import { agentSessionsForMainChatTab, defaultReviewerModel, latestAuditReport } from './agent-session-model';
import { pluginUninstallId } from './plugin-lifecycle';
import { flattenPlugins, PluginBrowserView, PluginGlyph } from './PluginBrowser';
import {
  buildOptimisticUserMessage,
  hasAuthoritativeUserMessage,
  stripOptimisticUserMessage,
} from './optimistic-user-message';
import {
  closeMainChatTab,
  createMainChatTab,
  findMainChatTabDropTarget,
  maxMainChatTabs,
  needsMainChatTabHydration,
  parseMainChatTabState,
  reorderMainChatTabs,
  serializeMainChatTabState,
  tabForThread,
  type MainChatTab,
  type MainChatTabState,
} from './main-chat-tabs';
import {
  alwaysKeepAllStorageKey,
  isAlwaysKeepAllStored,
  storedAlwaysKeepAllValue,
} from './review-preference';

function modelAcceptsImages(models: Model[], model: string | null): boolean {
  const selected = models.find((candidate) => candidate.model === model || candidate.id === model);
  return !selected || selected.inputModalities.includes('image');
}

const minChatWidth = 280;
const minBrowserWidth = 420;
const dividerWidth = 8;
const lastThreadStorageKey = 'codexdesktop.lastThreadId';
const mainChatTabsStorageKey = 'codexdesktop.mainChatTabs.v1';
const agentDockStorageKey = 'codexdesktop.agentDock.v1';
const modelStorageKey = 'codexdesktop.model';
const reasoningEffortStorageKey = 'codexdesktop.reasoningEffort';
const fastModeStorageKey = 'codexdesktop.fastMode';

function isTerminalTurnStatus(status: TurnMeta['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'interrupted';
}

// Turn failures the app can recover from by retrying/continuing on the same
// thread: capacity problems on the provider side, not problems with the
// request itself (auth, context window, budget, policy).
const maxAutoRecoveryAttempts = 3;
const autoRecoveryDelayMs = 10_000;
const autoRecoveryPrompt =
  'The previous turn was cut short by a model availability error. Continue the task from where you left off.';

function isRecoverableTurnError(info: CodexErrorInfo | null): boolean {
  if (!info) return false;
  if (info === 'serverOverloaded' || info === 'internalServerError') return true;
  return typeof info === 'object' && 'responseTooManyFailedAttempts' in info;
}

type AutoRecoveryState = {
  threadId: string;
  attempts: number;
  // Turn ids already handled, so the `error` notification and the
  // `turn/completed` failure for the same turn schedule only one recovery.
  handledTurnIds: Set<string>;
  timer: number | null;
};

type PendingThreadStartOwner = { kind: 'main'; key: string } | { kind: 'agent'; key: string };

function cloneGoal(goal: ThreadGoal | null): ThreadGoal | null {
  return goal ? { ...goal } : null;
}

// The per-session render model now lives in session-store.ts (Phase 2); a
// main-chat "snapshot" is simply a session state held under the tab's key.
type MainChatSnapshot = SessionRenderState;

export default function App(): React.JSX.Element {
  const [split, setSplit] = useState(() => {
    const stored = Number(window.localStorage.getItem('codexdesktop.split'));
    return Number.isFinite(stored) && stored > 20 && stored < 70 ? stored : 37;
  });
  const [mainChatTabState, setMainChatTabState] = useState<MainChatTabState>(() =>
    parseMainChatTabState(
      window.localStorage.getItem(mainChatTabsStorageKey),
      window.localStorage.getItem(lastThreadStorageKey),
      () => crypto.randomUUID(),
      {
        // One-time migration source for tab state saved before model choices
        // were isolated per chat.
        model: window.localStorage.getItem(modelStorageKey),
        reasoningEffort: window.localStorage.getItem(reasoningEffortStorageKey),
      },
    ),
  );
  const mainChatTabs = mainChatTabState.tabs;
  const activeMainChatTabKey = mainChatTabState.activeKey;
  const initialMainChatTab =
    mainChatTabs.find((tab) => tab.key === activeMainChatTabKey) ?? mainChatTabs[0];
  const [isGoalUpdating, setIsGoalUpdating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const [reconcilingMainChatTabKey, setReconcilingMainChatTabKey] = useState<string | null>(null);
  const [codexStatus, setCodexStatus] = useState('idle');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsNextCursor, setThreadsNextCursor] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(() =>
    window.localStorage.getItem('codexdesktop.workspace'),
  );
  const [isThreadMenuOpen, setIsThreadMenuOpen] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  // The active tab projects its saved model choice into the composer. `null`
  // means no explicit override, so turns use the CLI-configured default.
  const [selectedModel, setSelectedModel] = useState<string | null>(initialMainChatTab.model);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort | null>(
    initialMainChatTab.reasoningEffort,
  );
  const [fastMode, setFastMode] = useState(
    () => window.localStorage.getItem(fastModeStorageKey) === '1',
  );
  const [alwaysKeepAll, setAlwaysKeepAll] = useState(
    () => isAlwaysKeepAllStored(window.localStorage.getItem(alwaysKeepAllStorageKey)),
  );
  const [browserState, setBrowserState] = useState<BrowserState>({ tabs: [], activeTabId: null });
  const [viewBounds, setViewBounds] = useState<BrowserBounds | null>(null);
  const sessionStoreRef = useRef<SessionStore>(null as unknown as SessionStore);
  if (!sessionStoreRef.current) sessionStoreRef.current = new SessionStore();
  // Declared before useAgentSessions so its reviewer-model derivation can
  // close over them; synced further down alongside the other mirrors.
  const selectedModelRef = useRef<string | null>(selectedModel);
  const modelsRef = useRef<Model[]>(models);
  const {
    agentSessions,
    openAgentKeys,
    selectedAgentKey,
    setOpenAgentKeys,
    setSelectedAgentKey,
    agentSessionsRef,
    agentStartQueueRef,
    agentCounterRef,
    agentDockRestoredRef,
    updateAgentSessions,
    patchAgentSession,
    appendAgentMessage,
    appendAgentMessageOnce,
    setAgentSessionRender,
    resetAgentSessionRender,
    removeAgentSessionRender,
    backgroundSessionForThread,
    handleAgentNotification,
    handleNewAgent,
    handleOpenAgent,
    handleMinimizeAgent,
    handleToggleWatchAgent,
    handleToggleAuditAgent,
    handleToggleReportAgent,
    handleDecideSendPolicy,
    handleSetAgentModel,
  } = useAgentSessions(
    agentDockStorageKey,
    sessionStoreRef.current,
    {
      schedule: maybeScheduleAgentRecovery,
      cancel: cancelAgentRecovery,
    },
    // Cross-family reviewer default: derived against the active tab's model
    // at the moment an agent is born or armed. Null (single provider) makes
    // the agent follow the main chat's model — the correct fallback.
    () => defaultReviewerModel(selectedModelRef.current, modelsRef.current),
  );
  const appRef = useRef<HTMLDivElement | null>(null);
  const viewHostRef = useRef<HTMLDivElement | null>(null);
  const pendingBoundsRef = useRef<BrowserBounds | null>(null);
  const rafRef = useRef<number | null>(null);
  const isDraggingDividerRef = useRef(false);
  const splitRef = useRef(split);
  const userTurnRequestPendingRef = useRef(false);
  // Audit feedback loop bookkeeping: which main-chat turns were started by an
  // auditor's flagged report (bounce cap), what each auditor last audited
  // (same-thread + bounce gates), and the in-flight marker consumed by
  // handleSend to tag the feedback turn it starts.
  const auditFeedbackTurnIdsRef = useRef<Set<string>>(new Set());
  const auditContextByAuditorRef = useRef<Map<string, { threadId: string | null; auditedTurnWasFeedback: boolean }>>(new Map());
  const pendingAuditFeedbackRef = useRef(false);
  const userRequestedTurnIdRef = useRef<string | null>(null);
  const optimisticUserMessageIdRef = useRef<string | null>(null);
  const selectedReasoningEffortRef = useRef<ReasoningEffort | null>(selectedReasoningEffort);
  const fastModeRef = useRef(fastMode);
  const workspaceRef = useRef<string | null>(workspace);
  // Pending overload recovery for the watched thread; single slot because the
  // notification handler only reacts to one relevant thread at a time.
  const autoRecoveryRef = useRef<AutoRecoveryState | null>(null);
  const watchThreadIdRef = useRef<string | null>(null);
  const resumeGenerationRef = useRef(0);
  const hasAutoRestoredRef = useRef(false);
  const initializationPromiseRef = useRef<Promise<void> | null>(null);
  // All streaming patches (agent text, command output, reasoning, plan, file
  // changes) accumulate here and apply in a single batched setItems per frame.
  // Batching every delta kind — not just agent text — is what keeps a long
  // turn's reasoning/command streams from re-rendering the transcript per token.
  const pendingItemMutationsRef = useRef<Array<(items: ChatItem[]) => ChatItem[]>>([]);
  const itemMutationFrameRef = useRef<number | null>(null);
  const threadsNextCursorRef = useRef<string | null>(null);
  const persistedTraceFingerprintsRef = useRef<Map<string, string>>(new Map());
  const persistedMemoryFingerprintsRef = useRef<Map<string, string>>(new Map());
  const mainChatTabStateRef = useRef(mainChatTabState);
  const activeMainChatTabKeyRef = useRef(activeMainChatTabKey);
  const olderHistoryCursorByThreadRef = useRef<Map<string, string | null>>(new Map());
  const olderHistoryLoadsRef = useRef<Set<string>>(new Set());
  // A failed resume is transient transport state, not proof that the thread is
  // gone. Keep the persisted tab/thread pointer and retry on the next tab
  // selection instead of silently turning a recoverable startup hiccup into a
  // blank new chat.
  const resumeFailuresByTabRef = useRef<Map<string, string>>(new Map());
  const mainThreadStartsInFlightRef = useRef<Set<string>>(new Set());
  const pendingThreadStartOwnersRef = useRef<PendingThreadStartOwner[]>([]);
  const reconcilingMainChatTabKeyRef = useRef<string | null>(null);
  // Per-session overload recovery, keyed by session key — the dock equivalent
  // of autoRecoveryRef (which only ever tracks the focused thread).
  const agentRecoveryRef = useRef<Map<string, Omit<AutoRecoveryState, 'threadId'>>>(new Map());

  // ── Phase 2: the active tab's render model lives in the SessionStore under
  // the active tab key. React subscribes via useSyncExternalStore; the legacy
  // setter/ref names below are store-backed shims so call sites are unchanged.
  const subscribeToSessions = useCallback(
    (onStoreChange: () => void) => sessionStoreRef.current.subscribeAll(onStoreChange),
    [],
  );
  const readActiveSession = useCallback(
    () => sessionStoreRef.current.get(activeMainChatTabKeyRef.current),
    [],
  );
  const activeSession = useSyncExternalStore(subscribeToSessions, readActiveSession);
  const items = activeSession.items;
  const itemMeta = activeSession.itemMeta;
  const turnMeta = activeSession.turnMeta;
  const contextUsage = activeSession.contextUsage;
  const activeGoal = activeSession.goal;
  const isCompacting = activeSession.isCompacting;
  const activeThreadId = activeSession.threadId;
  const activeThreadTitle = activeSession.title;
  const activeTurnId = activeSession.turnId;
  const activeReasoningEffort = activeSession.reasoningEffort;

  const activeSessionShims = useMemo(() => {
    const updateField = <K extends keyof SessionRenderState>(
      field: K,
      value: SessionRenderState[K] | ((current: SessionRenderState[K]) => SessionRenderState[K]),
    ): void => {
      sessionStoreRef.current.update(activeMainChatTabKeyRef.current, (session) => {
        const next =
          typeof value === 'function'
            ? (value as (current: SessionRenderState[K]) => SessionRenderState[K])(session[field])
            : value;
        return Object.is(next, session[field]) ? session : { ...session, [field]: next };
      });
    };
    const makeSetter =
      <K extends keyof SessionRenderState>(field: K) =>
      (
        value: SessionRenderState[K] | ((current: SessionRenderState[K]) => SessionRenderState[K]),
      ): void =>
        updateField(field, value);
    const makeRef = <K extends keyof SessionRenderState>(
      field: K,
    ): { current: SessionRenderState[K] } => ({
      get current(): SessionRenderState[K] {
        return sessionStoreRef.current.get(activeMainChatTabKeyRef.current)[field];
      },
      set current(value: SessionRenderState[K]) {
        updateField(field, value);
      },
    });
    return {
      setItems: makeSetter('items'),
      setItemMeta: makeSetter('itemMeta'),
      setTurnMeta: makeSetter('turnMeta'),
      setContextUsage: makeSetter('contextUsage'),
      setActiveGoal: makeSetter('goal'),
      setIsCompacting: makeSetter('isCompacting'),
      setActiveThreadId: makeSetter('threadId'),
      setActiveThreadTitle: makeSetter('title'),
      setActiveTurnId: makeSetter('turnId'),
      setActiveReasoningEffort: makeSetter('reasoningEffort'),
      itemsRef: makeRef('items'),
      itemMetaRef: makeRef('itemMeta'),
      turnMetaRef: makeRef('turnMeta'),
      contextUsageRef: makeRef('contextUsage'),
      activeGoalRef: makeRef('goal'),
      activeReasoningEffortRef: makeRef('reasoningEffort'),
      activeThreadIdRef: makeRef('threadId'),
      activeThreadTitleRef: makeRef('title'),
      activeTurnIdRef: makeRef('turnId'),
      activeCompactionRef: makeRef('activeCompaction'),
      precedingModelInputByTurnRef: makeRef('precedingModelInputByTurn'),
      pendingCompactionByTurnRef: makeRef('pendingCompactionByTurn'),
    };
  }, []);
  const {
    setItems,
    setItemMeta,
    setTurnMeta,
    setContextUsage,
    setActiveGoal,
    setIsCompacting,
    setActiveThreadId,
    setActiveThreadTitle,
    setActiveTurnId,
    setActiveReasoningEffort,
    itemsRef,
    itemMetaRef,
    turnMetaRef,
    contextUsageRef,
    activeGoalRef,
    activeReasoningEffortRef,
    activeThreadIdRef,
    activeThreadTitleRef,
    activeTurnIdRef,
    activeCompactionRef,
    precedingModelInputByTurnRef,
    pendingCompactionByTurnRef,
  } = activeSessionShims;

  useEffect(() => {
    return window.api.browser.onState(setBrowserState);
  }, []);

  useEffect(
    () => () => {
      if (itemMutationFrameRef.current !== null) {
        window.cancelAnimationFrame(itemMutationFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  // Keep one compact, renderer-owned transcript snapshot per active thread.
  // Debouncing lets streaming settle before disk work and makes the cache an
  // instant-paint aid, not another source of per-token render pressure.
  useEffect(() => {
    const snapshot = serializeTranscriptSession(activeSession);
    if (!snapshot) return;
    const timer = window.setTimeout(() => {
      void window.api.transcriptCache
        .persist({ threadId: snapshot.session.threadId!, snapshot })
        .catch((error) => console.warn('Failed to persist transcript cache', error));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeSession]);

  useEffect(() => {
    activeThreadTitleRef.current = activeThreadTitle;
  }, [activeThreadTitle]);

  useEffect(() => {
    activeTurnIdRef.current = activeTurnId;
  }, [activeTurnId]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    itemMetaRef.current = itemMeta;
  }, [itemMeta]);

  useEffect(() => {
    turnMetaRef.current = turnMeta;
  }, [turnMeta]);

  useEffect(() => {
    mainChatTabStateRef.current = mainChatTabState;
    activeMainChatTabKeyRef.current = mainChatTabState.activeKey;
    window.localStorage.setItem(
      mainChatTabsStorageKey,
      serializeMainChatTabState(mainChatTabState),
    );
  }, [mainChatTabState]);

  useEffect(() => {
    activeGoalRef.current = activeGoal;
  }, [activeGoal]);

  useEffect(() => {
    activeReasoningEffortRef.current = activeReasoningEffort;
  }, [activeReasoningEffort]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    selectedReasoningEffortRef.current = selectedReasoningEffort;
  }, [selectedReasoningEffort]);

  useEffect(() => {
    fastModeRef.current = fastMode;
  }, [fastMode]);

  useEffect(() => {
    modelsRef.current = models;
  }, [models]);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    splitRef.current = split;
  }, [split]);

  useEffect(() => {
    threadsNextCursorRef.current = threadsNextCursor;
  }, [threadsNextCursor]);

  function updateMainChatTabs(update: (state: MainChatTabState) => MainChatTabState): void {
    // Applied eagerly against the ref (the always-current source) so
    // activeMainChatTabKeyRef is correct the moment this returns — active-
    // session writes that follow in the same handler must target the new key,
    // not wait for React to run a queued updater.
    const next = update(mainChatTabStateRef.current);
    mainChatTabStateRef.current = next;
    activeMainChatTabKeyRef.current = next.activeKey;
    setMainChatTabState(next);
  }

  function patchMainChatTab(key: string, update: (tab: MainChatTab) => MainChatTab): void {
    updateMainChatTabs((state) => ({
      ...state,
      tabs: state.tabs.map((tab) => (tab.key === key ? update(tab) : tab)),
    }));
  }

  function handleReorderMainChatTabs(
    sourceKey: string,
    targetKey: string,
    placement: 'before' | 'after',
  ): void {
    updateMainChatTabs((state) => reorderMainChatTabs(state, sourceKey, targetKey, placement));
  }

  function mainChatTabForThread(threadId: string): MainChatTab | null {
    return tabForThread(mainChatTabStateRef.current.tabs, threadId);
  }

  function setActiveMainChatModelSelection(
    model: string | null,
    reasoningEffort: ReasoningEffort | null,
  ): void {
    selectedModelRef.current = model;
    selectedReasoningEffortRef.current = reasoningEffort;
    setSelectedModel(model);
    setSelectedReasoningEffort(reasoningEffort);
    patchMainChatTab(activeMainChatTabKeyRef.current, (tab) => ({
      ...tab,
      model,
      reasoningEffort,
    }));
  }

  function flushActiveMainChatSession(): void {
    // Every active-path write already lands in the session store live; only
    // rAF-batched item mutations can still be pending when the active key is
    // about to change, and they must land under the OLD key.
    flushPendingItemMutations();
  }

  function focusMainChatTab(tab: MainChatTab, session?: SessionRenderState): void {
    // Tab-scoped composer selections project into the composer.
    selectedModelRef.current = tab.model;
    selectedReasoningEffortRef.current = tab.reasoningEffort;
    setSelectedModel(tab.model);
    setSelectedReasoningEffort(tab.reasoningEffort);
    // Route notifications for this tab's thread to the focused view even
    // before the session learns its threadId from hydration.
    watchThreadIdRef.current = session?.threadId ?? tab.threadId;
    // Header continuity for uncached tabs. A title-only session never reads
    // as cached, because hydration keys off the session's threadId.
    if (!session && tab.title) {
      sessionStoreRef.current.update(tab.key, (current) =>
        current.title === tab.title ? current : { ...current, title: tab.title },
      );
    }
    setIsGoalUpdating(false);
  }

  useEffect(() => {
    if (workspace) {
      window.localStorage.setItem('codexdesktop.workspace', workspace);
    } else {
      window.localStorage.removeItem('codexdesktop.workspace');
    }
  }, [workspace]);

  useEffect(() => {
    if (!hasAutoRestoredRef.current) {
      return;
    }

    void refreshThreads();
  }, [workspace]);

  useEffect(() => {
    if (!activeThreadId) return;

    for (const [turnId, meta] of Object.entries(turnMeta)) {
      if (meta.origin !== 'live' || !isTerminalTurnStatus(meta.status)) continue;

      const trace = buildTurnTrace({
        threadId: activeThreadId,
        threadTitle: activeThreadTitle,
        turnId,
        model: selectedModel,
        workspace,
        items,
        itemMeta,
        meta,
      });
      const content = `${JSON.stringify(trace, null, 2)}\n`;
      const fingerprint = JSON.stringify({ ...trace, exportedAt: '' });
      const key = `${activeThreadId}/${turnId}`;

      if (persistedTraceFingerprintsRef.current.get(key) === fingerprint) continue;
      persistedTraceFingerprintsRef.current.set(key, fingerprint);

      void window.api.trace
        .persist({ threadId: activeThreadId, turnId, content })
        .catch((error) => {
          if (persistedTraceFingerprintsRef.current.get(key) === fingerprint) {
            persistedTraceFingerprintsRef.current.delete(key);
          }
          console.warn('Failed to persist completed turn trace', error);
        });
    }
  }, [activeThreadId, activeThreadTitle, selectedModel, workspace, items, itemMeta, turnMeta]);

  useEffect(() => {
    if (!activeThreadId || activeTurnId) return;
    if (
      !Object.values(turnMeta).some(
        (meta) => meta.origin === 'live' && isTerminalTurnStatus(meta.status),
      )
    )
      return;

    const turns = completedMemoryTurns(items, itemMeta, turnMeta);
    if (!turns.length) return;

    const completionTimes = Object.values(turnMeta)
      .map((meta) => meta.completedAtMs)
      .filter((value): value is number => typeof value === 'number');
    const completedAtMs = completionTimes.length ? Math.max(...completionTimes) : Date.now();
    const params: MemoryPersistParams = {
      threadId: activeThreadId,
      title: activeThreadTitle,
      workspace,
      updatedAt: new Date(completedAtMs).toISOString(),
      turns,
    };
    const fingerprint = JSON.stringify(params);

    if (persistedMemoryFingerprintsRef.current.get(activeThreadId) === fingerprint) return;
    persistedMemoryFingerprintsRef.current.set(activeThreadId, fingerprint);

    void window.api.memory.persist(params).catch((error) => {
      if (persistedMemoryFingerprintsRef.current.get(activeThreadId) === fingerprint) {
        persistedMemoryFingerprintsRef.current.delete(activeThreadId);
      }
      console.warn('Failed to persist chat memory', error);
    });
  }, [activeThreadId, activeThreadTitle, activeTurnId, workspace, items, itemMeta, turnMeta]);

  // The merged catalog comes from each registered runtime: Codex app-server's
  // `model/list` plus Claude Agent SDK `supportedModels()`. Loaded once the
  // shared session surface is ready; if it fails, sends omit the override.
  useEffect(() => {
    if (codexStatus !== 'ready' || models.length) {
      return;
    }

    let cancelled = false;

    window.api.session.listModels().then(
      (list: Model[]) => {
        if (cancelled || !list.length) {
          return;
        }
        setModels(list);
        const normalizeTab = (tab: MainChatTab): MainChatTab => {
          // A saved explicit pick may disappear after a CLI/config update.
          // In that case fall back to the server default for this tab only.
          const savedModel = tab.model
            ? list.find(
                (candidate) =>
                  candidate.model === tab.model ||
                  (candidate.providerId === 'claude' &&
                    (candidate.runtimeModel === tab.model ||
                      candidate.resolvedModel === tab.model)),
              )
            : null;
          const model = savedModel?.model ?? null;
          const active =
            list.find((candidate) => candidate.model === model) ??
            list.find((candidate) => candidate.isDefault) ??
            list[0];
          const supported = active.supportedReasoningEfforts.map(
            (option) => option.reasoningEffort,
          );
          const reasoningEffort =
            tab.reasoningEffort && supported.includes(tab.reasoningEffort)
              ? tab.reasoningEffort
              : supported.length
                ? active.defaultReasoningEffort
                : null;
          return { ...tab, model, reasoningEffort };
        };
        const activeTab = normalizeTab(
          mainChatTabStateRef.current.tabs.find(
            (tab) => tab.key === activeMainChatTabKeyRef.current,
          ) ?? mainChatTabStateRef.current.tabs[0],
        );
        updateMainChatTabs((state) => ({
          ...state,
          tabs: state.tabs.map(normalizeTab),
        }));
        selectedModelRef.current = activeTab.model;
        selectedReasoningEffortRef.current = activeTab.reasoningEffort;
        setSelectedModel(activeTab.model);
        setSelectedReasoningEffort(activeTab.reasoningEffort);
      },
      (error: Error) => console.warn('Failed to load model catalog', error),
    );

    return () => {
      cancelled = true;
    };
  }, [codexStatus, models.length]);

  useEffect(() => {
    const dispose = window.api.session.onEvent((event) => {
      if (event.type === 'status') {
        setCodexStatus(event.status);

        if (event.status === 'exited' || event.status === 'error') {
          addSystemItem(
            event.message ?? 'Codex app-server is not available.',
            event.status === 'error' ? 'error' : 'warning',
          );
        }

        return;
      }

      if (event.type === 'researchProgress') {
        if (isRelevantThread(event.threadId)) {
          setItemMeta((current) => reduceResearchProgressMeta(current, event));
        }
        return;
      }

      handleCodexNotification(event.notification as ServerNotification);
    });

    if (!initializationPromiseRef.current) {
      const activeTab = mainChatTabStateRef.current.tabs.find(
        (tab) => tab.key === mainChatTabStateRef.current.activeKey,
      );
      const lastThreadId = activeTab?.threadId ?? null;
      initializationPromiseRef.current = (async () => {
        const authPromise = window.api.session.getAuthStatus().catch((error) => {
          addSystemItem(`Codex auth check failed: ${(error as Error).message}`, 'error');
        });
        const threadsPromise = refreshThreads();
        // Main thread first — it warms up the codex child, so the dock's
        // resume calls don't race a cold start. The dock restore then skips
        // any thread the main view already owns.
        const restorePromise = (async () => {
          if (lastThreadId) {
            await restoreCachedTranscript(
              lastThreadId,
              activeTab?.key ?? activeMainChatTabKeyRef.current,
            );
            await resumeThreadById(lastThreadId, { silent: true });
          }
          await restoreBackgroundMainChatTabs(lastThreadId);
          await restoreAgentDock();
        })();

        await Promise.all([authPromise, threadsPromise, restorePromise]);
        hasAutoRestoredRef.current = true;
        setIsRestoring(false);
      })();
    }

    void initializationPromiseRef.current;

    return dispose;
  }, []);

  const measureBrowserBounds = useCallback((): BrowserBounds | null => {
    const host = viewHostRef.current;

    if (!host) {
      return null;
    }

    const rect = host.getBoundingClientRect();
    const style = window.getComputedStyle(host);
    const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
    const borderRight = Number.parseFloat(style.borderRightWidth) || 0;
    const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
    const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;

    return {
      // WebContentsView is composited above the renderer. Target the host's
      // inner edge so the native page cannot paint over the visible frame.
      x: rect.left + borderLeft,
      y: rect.top + borderTop,
      width: Math.max(1, rect.width - borderLeft - borderRight),
      height: Math.max(1, rect.height - borderTop - borderBottom),
    };
  }, []);

  const updateBrowserBounds = useCallback(
    (sendFinal = false) => {
      const bounds = measureBrowserBounds();

      if (!bounds) {
        return;
      }

      setViewBounds(bounds);
      pendingBoundsRef.current = bounds;

      if (sendFinal) {
        void window.api.browser.setBounds(bounds);
        return;
      }

      if (rafRef.current !== null) {
        return;
      }

      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;

        if (!isDraggingDividerRef.current && pendingBoundsRef.current) {
          void window.api.browser.setBounds(pendingBoundsRef.current);
        }
      });
    },
    [measureBrowserBounds],
  );

  useEffect(() => {
    updateBrowserBounds(true);
  }, [split, updateBrowserBounds]);

  useEffect(() => {
    const host = viewHostRef.current;

    if (!host) {
      return;
    }

    const observer = new ResizeObserver(() => updateBrowserBounds());
    const handleResize = (): void => updateBrowserBounds();

    observer.observe(host);
    window.addEventListener('resize', handleResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [updateBrowserBounds]);

  const activeTab = useMemo(
    () => browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ?? null,
    [browserState],
  );

  const handleDividerPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const app = appRef.current;

    if (!app) {
      return;
    }

    isDraggingDividerRef.current = true;
    void window.api.browser.beginDividerDrag();
    event.currentTarget.setPointerCapture(event.pointerId);

    const appRect = app.getBoundingClientRect();

    const handleMove = (moveEvent: globalThis.PointerEvent): void => {
      const rawChatWidth = moveEvent.clientX - appRect.left;
      const maxChatWidth = appRect.width - minBrowserWidth - dividerWidth;
      const clamped = Math.min(Math.max(rawChatWidth, minChatWidth), maxChatWidth);
      const nextSplit = (clamped / appRect.width) * 100;
      splitRef.current = nextSplit;
      setSplit(nextSplit);
    };

    let dragFinished = false;
    const finishDrag = (): void => {
      if (dragFinished) return;
      dragFinished = true;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      window.localStorage.setItem('codexdesktop.split', String(splitRef.current));
      isDraggingDividerRef.current = false;
      const latestBounds = measureBrowserBounds() ?? pendingBoundsRef.current;

      if (latestBounds) {
        void window.api.browser.endDividerDrag(latestBounds);
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', finishDrag, { once: true });
    window.addEventListener('pointercancel', finishDrag, { once: true });
  };

  const handleSend = async (text: string, attachments: ChatAttachment[] = []): Promise<boolean> => {
    const trimmed = text.trim();
    const targetTabKey = activeMainChatTabKeyRef.current;

    if (
      (!trimmed && !attachments.length) ||
      isSending ||
      activeTurnId ||
      isMainChatTransitionLocked()
    ) {
      return false;
    }
    if (
      attachments.some((attachment) => attachment.kind === 'image') &&
      !modelAcceptsImages(models, selectedModel)
    ) {
      addSystemItem(
        'The selected model does not accept image inputs. Choose an image-capable model or remove the image.',
        'warning',
      );
      return false;
    }

    // The user is driving again — drop any pending overload recovery.
    cancelAutoRecovery();
    setIsSending(true);
    userTurnRequestPendingRef.current = true;
    watchThreadIdRef.current = activeThreadId;
    const optimisticId = `optimistic-user-${crypto.randomUUID()}`;
    optimisticUserMessageIdRef.current = optimisticId;
    setItems((current) => [
      ...current,
      buildOptimisticUserMessage(optimisticId, trimmed, attachments),
    ]);

    try {
      const threadId = activeThreadIdRef.current;
      if (!threadId) {
        mainThreadStartsInFlightRef.current.add(targetTabKey);
        pendingThreadStartOwnersRef.current.push({ kind: 'main', key: targetTabKey });
      }

      const response = await window.api.session.sendMessage({
        threadId,
        text: trimmed,
        attachments,
        cwd: workspace,
        model: selectedModel,
        effort: selectedReasoningEffort,
        fastMode,
      });
      if (pendingAuditFeedbackRef.current) {
        // This turn was started by an auditor's flagged report; its own audit
        // will run and display, but cannot auto-send again (bounce cap).
        auditFeedbackTurnIdsRef.current.add(response.turn.id);
        pendingAuditFeedbackRef.current = false;
      }
      patchMainChatTab(targetTabKey, (tab) => ({
        ...tab,
        threadId: response.threadId,
        status: 'working',
        turnId: response.turn.id,
      }));
      if (activeMainChatTabKeyRef.current !== targetTabKey) {
        const snapshot = sessionStoreRef.current.peek(targetTabKey);
        if (snapshot) {
          sessionStoreRef.current.set(targetTabKey, {
            ...snapshot,
            threadId: response.threadId,
            turnId: response.turn.id,
            reasoningEffort: response.reasoningEffort,
          });
        }
        return true;
      }
      watchThreadIdRef.current = response.threadId;
      activeThreadIdRef.current = response.threadId;
      setActiveThreadId(response.threadId);
      persistLastThreadId(response.threadId);
      const turnAlreadyObserved = activeTurnIdRef.current === response.turn.id;
      if (!turnAlreadyObserved) userRequestedTurnIdRef.current = response.turn.id;
      setActiveTurnId(response.turn.id);
      activeTurnIdRef.current = response.turn.id;
      setActiveReasoningEffort(response.reasoningEffort);
      activeReasoningEffortRef.current = response.reasoningEffort;
      const goalSnapshot = cloneGoal(activeGoalRef.current);
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
        startedAtMs: response.turn.startedAt ? response.turn.startedAt * 1000 : Date.now(),
      });
      adoptTurnItems(response.turn.id, response.turn.items);
      mergeItems(response.turn.items);
      return true;
    } catch (error) {
      if (optimisticUserMessageIdRef.current === optimisticId) {
        optimisticUserMessageIdRef.current = null;
        setItems((current) => current.filter((item) => item.id !== optimisticId));
      }
      addSystemItem(`Codex turn failed to start: ${(error as Error).message}`, 'error');
      return false;
    } finally {
      mainThreadStartsInFlightRef.current.delete(targetTabKey);
      pendingThreadStartOwnersRef.current = pendingThreadStartOwnersRef.current.filter(
        (owner) => owner.kind !== 'main' || owner.key !== targetTabKey,
      );
      userTurnRequestPendingRef.current = false;
      setIsSending(false);
    }
  };

  const handleSteer = async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    const threadId = activeThreadIdRef.current;
    const turnId = activeTurnIdRef.current;

    if (!trimmed || !threadId || !turnId) {
      return false;
    }

    try {
      await window.api.session.steerTurn({ threadId, turnId, text: trimmed });
      return true;
    } catch (error) {
      addSystemItem(
        `Could not add guidance to the active turn: ${(error as Error).message}`,
        'error',
      );
      return false;
    }
  };

  const handleSelectModel = (model: string): void => {
    cancelAutoRecovery();

    const selected = models.find((candidate) => candidate.model === model);
    if (!selected) {
      setActiveMainChatModelSelection(model, selectedReasoningEffortRef.current);
      return;
    }
    const supported = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort);
    const nextEffort =
      selectedReasoningEffortRef.current && supported.includes(selectedReasoningEffortRef.current)
        ? selectedReasoningEffortRef.current
        : supported.length
          ? selected.defaultReasoningEffort
          : null;
    setActiveMainChatModelSelection(model, nextEffort);
  };

  const handleSelectModelEffort = (model: string, effort: ReasoningEffort): void => {
    cancelAutoRecovery();
    setActiveMainChatModelSelection(model, effort);
  };

  const handleSetFastMode = (enabled: boolean): void => {
    setFastMode(enabled);
    window.localStorage.setItem(fastModeStorageKey, enabled ? '1' : '0');
  };

  const handleSelectAgentModel = (key: string, model: string): void => {
    const selected = modelsRef.current.find((candidate) => candidate.model === model);
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key);
    if (!selected || !session) {
      handleSetAgentModel(key, model);
      return;
    }
    const supported = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort);
    const nextEffort =
      session.reasoningEffort && supported.includes(session.reasoningEffort)
        ? session.reasoningEffort
        : supported.length
          ? selected.defaultReasoningEffort
          : null;
    handleSetAgentModel(key, model, nextEffort);
  };

  const handleSelectAgentModelEffort = (
    key: string,
    model: string,
    effort: ReasoningEffort,
  ): void => {
    handleSetAgentModel(key, model, effort);
  };

  const handleStop = async (): Promise<void> => {
    if (!activeThreadId || !activeTurnId) {
      return;
    }

    try {
      await window.api.session.interruptTurn({ threadId: activeThreadId, turnId: activeTurnId });
    } catch (error) {
      addSystemItem(`Stop failed: ${(error as Error).message}`, 'error');
    }
  };

  const handleCompactThread = async (): Promise<void> => {
    const threadId = activeThreadIdRef.current;
    if (!threadId || activeTurnIdRef.current || isMainChatTransitionLocked()) {
      return;
    }

    try {
      // No optimistic message: the server's contextCompaction item arrives
      // within ~100ms and renders the live progress row itself.
      await window.api.session.compactThread(threadId);
    } catch (error) {
      addSystemItem(`Compaction failed: ${(error as Error).message}`, 'error');
    }
  };

  function isMainChatTransitionLocked(): boolean {
    return Boolean(
      userTurnRequestPendingRef.current ||
        isGoalUpdating ||
        isRestoring ||
        reconcilingMainChatTabKeyRef.current,
    );
  }

  function unsubscribeDetachedMainThread(threadId: string): void {
    // This thread no longer has a renderer owner. The request is best-effort,
    // but a failure must remain diagnosable: otherwise an app-server outage
    // leaves an invisible subscription behind with no recovery signal.
    void window.api.session.unsubscribeThread(threadId).catch((error) => {
      console.warn(`Failed to unsubscribe detached main thread ${threadId}`, error);
    });
  }

  const handleNewThread = (): void => {
    if (isMainChatTransitionLocked() || activeTurnIdRef.current) return;
    const previousThreadId = activeThreadIdRef.current;
    const tabKey = activeMainChatTabKeyRef.current;

    cancelAutoRecovery();
    setIsThreadMenuOpen(false);
    resumeGenerationRef.current += 1;
    watchThreadIdRef.current = null;
    persistLastThreadId(null);
    activeThreadIdRef.current = null;
    setActiveThreadId(null);
    activeThreadTitleRef.current = 'New Chat';
    setActiveThreadTitle('New Chat');
    setActiveTurnId(null);
    activeTurnIdRef.current = null;
    userRequestedTurnIdRef.current = null;
    optimisticUserMessageIdRef.current = null;
    setActiveGoal(null);
    activeGoalRef.current = null;
    setActiveReasoningEffort(null);
    activeReasoningEffortRef.current = null;
    itemsRef.current = [];
    itemMetaRef.current = {};
    turnMetaRef.current = {};
    setItems([]);
    setItemMeta({});
    setTurnMeta({});
    setContextUsage(null);
    contextUsageRef.current = null;
    setIsCompacting(false);
    activeCompactionRef.current = null;
    precedingModelInputByTurnRef.current = new Map();
    pendingCompactionByTurnRef.current = new Set();
    sessionStoreRef.current.remove(tabKey);
    resumeFailuresByTabRef.current.delete(tabKey);
    discardComposerDraft(tabKey);
    patchMainChatTab(tabKey, (tab) => ({
      ...createMainChatTab(tab.key, null, 'New Chat', tab.model, tab.reasoningEffort),
      key: tab.key,
    }));

    if (
      previousThreadId &&
      !backgroundSessionForThread(previousThreadId) &&
      !mainChatTabStateRef.current.tabs.some(
        (tab) => tab.key !== tabKey && tab.threadId === previousThreadId,
      )
    ) {
      unsubscribeDetachedMainThread(previousThreadId);
    }
  };

  const handleNewMainChatTab = (): boolean => {
    if (isMainChatTransitionLocked() || mainChatTabStateRef.current.tabs.length >= maxMainChatTabs)
      return false;
    flushActiveMainChatSession();
    cancelAutoRecovery();
    setIsThreadMenuOpen(false);
    const tab = createMainChatTab(
      crypto.randomUUID(),
      null,
      'New Chat',
      selectedModelRef.current,
      selectedReasoningEffortRef.current,
    );
    updateMainChatTabs((state) => ({ tabs: [...state.tabs, tab], activeKey: tab.key }));
    focusMainChatTab(tab);
    persistLastThreadId(null);
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),
    );
    return true;
  };

  const handleSelectMainChatTab = async (key: string): Promise<boolean> => {
    const retryThreadId = resumeFailuresByTabRef.current.get(key) ?? null;
    if (key === activeMainChatTabKeyRef.current && !retryThreadId) return true;
    if (isMainChatTransitionLocked()) return false;
    const target = mainChatTabStateRef.current.tabs.find((tab) => tab.key === key);
    if (!target) return false;

    if (
      key === activeMainChatTabKeyRef.current &&
      target.threadId &&
      retryThreadId === target.threadId
    ) {
      reconcilingMainChatTabKeyRef.current = key;
      setReconcilingMainChatTabKey(key);
      setIsRestoring(true);
      const resumed = await resumeThreadById(target.threadId, { silent: true, tabKey: key });
      if (activeMainChatTabKeyRef.current === key) {
        setIsRestoring(false);
        setReconcilingMainChatTabKey(null);
        reconcilingMainChatTabKeyRef.current = null;
      }
      return resumed;
    }

    flushActiveMainChatSession();
    cancelAutoRecovery();
    setIsThreadMenuOpen(false);
    updateMainChatTabs((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === key && tab.status === 'attention'
          ? { ...tab, status: tab.turnId ? 'working' : 'idle' }
          : tab,
      ),
      activeKey: key,
    }));
    let snapshot = sessionStoreRef.current.peek(key);
    const targetThreadId = target.threadId;
    const needsHydration =
      targetThreadId !== null && needsMainChatTabHydration(target, snapshot?.threadId);
    const needsRemoteResume =
      targetThreadId !== null &&
      (needsHydration || resumeFailuresByTabRef.current.get(key) === targetThreadId);
    if (needsHydration) {
      await restoreCachedTranscript(targetThreadId, key);
      snapshot = sessionStoreRef.current.peek(key);
    }
    focusMainChatTab(target, snapshot);
    persistLastThreadId(target.threadId);

    if (needsRemoteResume && targetThreadId) {
      reconcilingMainChatTabKeyRef.current = key;
      setReconcilingMainChatTabKey(key);
      if (!snapshot) setIsRestoring(true);
      const resumed = await resumeThreadById(targetThreadId, { silent: true, tabKey: key });
      if (activeMainChatTabKeyRef.current === key) {
        setIsRestoring(false);
        setReconcilingMainChatTabKey(null);
        reconcilingMainChatTabKeyRef.current = null;
      }
      if (!resumed) return false;
    }
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),
    );
    return true;
  };

  const handleCloseMainChatTab = async (key: string): Promise<void> => {
    if (isMainChatTransitionLocked()) return;
    const current = mainChatTabStateRef.current;
    const closing = current.tabs.find((tab) => tab.key === key);
    if (!closing || closing.status === 'working') return;
    const wasActive = current.activeKey === key;
    if (wasActive) flushActiveMainChatSession();
    const next = closeMainChatTab(current, key, () => crypto.randomUUID());
    sessionStoreRef.current.remove(key);
    resumeFailuresByTabRef.current.delete(key);
    discardComposerDraft(key);
    updateMainChatTabs(() => next);

    if (closing.threadId) {
      unsubscribeDetachedMainThread(closing.threadId);
    }
    if (!wasActive) return;

    cancelAutoRecovery();
    const target = next.tabs.find((tab) => tab.key === next.activeKey) ?? next.tabs[0];
    const snapshot = sessionStoreRef.current.peek(target.key);
    focusMainChatTab(target, snapshot);
    persistLastThreadId(target.threadId);
    const targetThreadId = target.threadId;
    if (
      targetThreadId &&
      (needsMainChatTabHydration(target, snapshot?.threadId) ||
        resumeFailuresByTabRef.current.get(target.key) === targetThreadId)
    ) {
      reconcilingMainChatTabKeyRef.current = target.key;
      setReconcilingMainChatTabKey(target.key);
      if (!snapshot) setIsRestoring(true);
      await resumeThreadById(targetThreadId, { silent: true, tabKey: target.key });
      if (activeMainChatTabKeyRef.current === target.key) {
        setIsRestoring(false);
        setReconcilingMainChatTabKey(null);
        reconcilingMainChatTabKeyRef.current = null;
      }
    }
  };

  const handleResumeThread = async (threadId: string): Promise<boolean> => {
    if (isMainChatTransitionLocked()) return false;
    setIsThreadMenuOpen(false);
    const existing = mainChatTabForThread(threadId);
    if (existing) {
      return handleSelectMainChatTab(existing.key);
    }

    const previousState = mainChatTabStateRef.current;
    const current = previousState.tabs.find((tab) => tab.key === activeMainChatTabKeyRef.current);
    const reuseCurrent = Boolean(current && !current.threadId && itemsRef.current.length === 0);
    if (!reuseCurrent && previousState.tabs.length >= maxMainChatTabs) return false;
    const target = reuseCurrent
      ? {
          ...current!,
          threadId,
          title: threads.find((thread) => thread.id === threadId)?.name ?? 'Chat',
        }
      : createMainChatTab(
          crypto.randomUUID(),
          threadId,
          threads.find((thread) => thread.id === threadId)?.name ?? 'Chat',
          selectedModelRef.current,
          selectedReasoningEffortRef.current,
        );

    flushActiveMainChatSession();
    const previousSnapshot = sessionStoreRef.current.peek(previousState.activeKey);
    if (reuseCurrent) {
      sessionStoreRef.current.remove(target.key);
      resumeFailuresByTabRef.current.delete(target.key);
    }
    updateMainChatTabs((state) => ({
      tabs: reuseCurrent
        ? state.tabs.map((tab) => (tab.key === target.key ? target : tab))
        : [...state.tabs, target],
      activeKey: target.key,
    }));
    focusMainChatTab(target);
    reconcilingMainChatTabKeyRef.current = target.key;
    setReconcilingMainChatTabKey(target.key);
    setIsRestoring(true);
    const resumed = await resumeThreadById(threadId, { tabKey: target.key });
    if (activeMainChatTabKeyRef.current === target.key) {
      setIsRestoring(false);
      setReconcilingMainChatTabKey(null);
      reconcilingMainChatTabKeyRef.current = null;
    }
    if (!resumed) {
      sessionStoreRef.current.remove(target.key);
      resumeFailuresByTabRef.current.delete(target.key);
      if (previousSnapshot) {
        sessionStoreRef.current.set(previousState.activeKey, previousSnapshot);
      }
      updateMainChatTabs((state) => ({
        tabs: reuseCurrent
          ? state.tabs.map((tab) => (tab.key === target.key ? current! : tab))
          : state.tabs.filter((tab) => tab.key !== target.key),
        activeKey: previousState.activeKey,
      }));
      const previousTab = previousState.tabs.find((tab) => tab.key === previousState.activeKey);
      if (previousTab) {
        focusMainChatTab(previousTab, previousSnapshot);
        persistLastThreadId(previousTab.threadId);
      }
      return false;
    }

    const dockOwner = backgroundSessionForThread(threadId);
    if (dockOwner) handleCloseAgentSession(dockOwner.key);
    return true;
  };

  async function restoreCachedTranscript(threadId: string, tabKey: string): Promise<void> {
    try {
      const cached = parseTranscriptSession(
        await window.api.transcriptCache.load(threadId),
        threadId,
      );
      if (!cached) return;
      sessionStoreRef.current.set(tabKey, { ...emptySessionState(), ...cached });
      patchMainChatTab(tabKey, (tab) => ({
        ...tab,
        threadId,
        title: cached.title ?? tab.title,
        status: cached.turnId ? 'working' : 'idle',
        turnId: cached.turnId ?? null,
      }));
    } catch (error) {
      console.warn(`Failed to restore cached transcript for ${threadId}`, error);
    }
  }

  function resumeFailureItemId(threadId: string): string {
    return `resume-failure-${threadId}`;
  }

  function markResumeFailure(tabKey: string, threadId: string, error: unknown): void {
    resumeFailuresByTabRef.current.set(tabKey, threadId);
    const message = (error as Error).message || String(error);
    const tab = mainChatTabStateRef.current.tabs.find((candidate) => candidate.key === tabKey);
    sessionStoreRef.current.update(tabKey, (session) => ({
      ...session,
      threadId,
      title: session.title || tab?.title || 'Chat',
      turnId: null,
      isCompacting: false,
      activeCompaction: null,
      items: upsertMany(session.items, [
        {
          type: 'system',
          id: resumeFailureItemId(threadId),
          level: 'warning',
          text: `Could not reconnect to this conversation: ${message}. The cached transcript is still available; select this chat to retry.`,
        },
      ]),
    }));
    patchMainChatTab(tabKey, (current) => ({ ...current, status: 'attention', turnId: null }));
  }

  function clearResumeFailure(tabKey: string, threadId: string): void {
    if (resumeFailuresByTabRef.current.get(tabKey) !== threadId) return;
    resumeFailuresByTabRef.current.delete(tabKey);
    const itemId = resumeFailureItemId(threadId);
    sessionStoreRef.current.update(tabKey, (session) => {
      const items = session.items.filter((item) => item.id !== itemId);
      return items.length === session.items.length ? session : { ...session, items };
    });
  }

  async function resumeThreadById(
    threadId: string,
    options: { silent?: boolean; tabKey?: string } = {},
  ): Promise<boolean> {
    const generation = ++resumeGenerationRef.current;
    const tabKey = options.tabKey ?? activeMainChatTabKeyRef.current;
    optimisticUserMessageIdRef.current = null;

    if (activeThreadIdRef.current !== threadId) {
      cancelAutoRecovery();
    }
    setActiveGoal(null);
    activeGoalRef.current = null;
    setActiveReasoningEffort(null);
    activeReasoningEffortRef.current = null;

    watchThreadIdRef.current = threadId;

    try {
      const resumed = await window.api.session.resumeThread({ threadId, history: 'main' });

      if (
        generation !== resumeGenerationRef.current ||
        activeMainChatTabKeyRef.current !== tabKey
      ) {
        return false;
      }

      const environment = {
        model: resumed.model,
        workspace: resumed.cwd,
        reasoningEffort: resumed.reasoningEffort,
      };
      const tab = mainChatTabStateRef.current.tabs.find((candidate) => candidate.key === tabKey);
      const model = resumed.model ?? tab?.model ?? null;
      const reasoningEffort = resumed.reasoningEffort ?? tab?.reasoningEffort ?? null;
      patchMainChatTab(tabKey, (current) => ({ ...current, model, reasoningEffort }));
      selectedModelRef.current = model;
      selectedReasoningEffortRef.current = reasoningEffort;
      setSelectedModel(model);
      setSelectedReasoningEffort(reasoningEffort);
      setActiveReasoningEffort(resumed.reasoningEffort);
      activeReasoningEffortRef.current = resumed.reasoningEffort;
      // Resume pages are newest-first for fast retrieval. The transcript is
      // rendered in reading order, so reverse its one-turn first page exactly once.
      hydrateThread(
        resumed.thread,
        [...(resumed.initialTurnsPage?.data ?? [])].reverse(),
        environment,
      );
      olderHistoryCursorByThreadRef.current.set(
        threadId,
        resumed.initialTurnsPage?.nextCursor ?? null,
      );
      // Let the recent tail commit before warming a single 10-turn page. More
      // history stays demand-driven as the reader reaches the top.
      window.setTimeout(() => {
        void loadOlderThreadHistory(threadId, tabKey);
      }, 0);

      try {
        const goal = await window.api.session.getGoal(threadId);
        if (
          generation !== resumeGenerationRef.current ||
          activeMainChatTabKeyRef.current !== tabKey
        )
          return false;
        setActiveGoal(goal);
        activeGoalRef.current = goal;
      } catch (error) {
        console.warn('Failed to restore thread goal', error);
      }

      persistLastThreadId(threadId);
      clearResumeFailure(tabKey, threadId);
      return true;
    } catch (error) {
      if (
        generation !== resumeGenerationRef.current ||
        activeMainChatTabKeyRef.current !== tabKey
      ) {
        return false;
      }

      watchThreadIdRef.current = activeThreadIdRef.current;

      markResumeFailure(tabKey, threadId, error);
      return false;
    }
  }

  const handlePickWorkspace = async (): Promise<void> => {
    try {
      const picked = await window.api.workspace.pick();

      if (picked) {
        setWorkspace(picked);
      }
    } catch (error) {
      addSystemItem(`Workspace selection failed: ${(error as Error).message}`, 'error');
    }
  };

  async function ensureThreadForGoal(): Promise<string> {
    const existingThreadId = activeThreadIdRef.current;
    if (existingThreadId) return existingThreadId;

    const started = await window.api.session.startThread({
      cwd: workspaceRef.current,
      model: selectedModelRef.current,
    });
    const threadId = started.thread.id;
    watchThreadIdRef.current = threadId;
    activeThreadIdRef.current = threadId;
    setActiveThreadId(threadId);
    const title = threadTitle(started.thread);
    activeThreadTitleRef.current = title;
    setActiveThreadTitle(title);
    setActiveReasoningEffort(started.reasoningEffort);
    activeReasoningEffortRef.current = started.reasoningEffort;
    patchMainChatTab(activeMainChatTabKeyRef.current, (tab) => ({
      ...tab,
      threadId,
      title,
    }));
    persistLastThreadId(threadId);
    return threadId;
  }

  async function handleSaveGoal(objective: string, tokenBudget: number | null): Promise<boolean> {
    const trimmed = objective.trim();
    if (!trimmed || activeTurnIdRef.current || isGoalUpdating || isMainChatTransitionLocked())
      return false;

    setIsGoalUpdating(true);
    try {
      const threadId = await ensureThreadForGoal();
      const goal = await window.api.session.setGoal({
        threadId,
        objective: trimmed,
        status: 'active',
        tokenBudget,
      });
      setActiveGoal(goal);
      activeGoalRef.current = goal;
      return true;
    } catch (error) {
      addSystemItem(`Goal update failed: ${(error as Error).message}`, 'error');
      return false;
    } finally {
      setIsGoalUpdating(false);
    }
  }

  async function handleSetGoalStatus(
    status: Extract<ThreadGoalStatus, 'active' | 'paused'>,
  ): Promise<void> {
    const threadId = activeThreadIdRef.current;
    if (
      !threadId ||
      !activeGoalRef.current ||
      activeTurnIdRef.current ||
      isGoalUpdating ||
      isMainChatTransitionLocked()
    )
      return;

    setIsGoalUpdating(true);
    try {
      const goal = await window.api.session.setGoal({ threadId, status });
      setActiveGoal(goal);
      activeGoalRef.current = goal;
    } catch (error) {
      addSystemItem(`Goal status update failed: ${(error as Error).message}`, 'error');
    } finally {
      setIsGoalUpdating(false);
    }
  }

  async function handleClearGoal(): Promise<void> {
    const threadId = activeThreadIdRef.current;
    if (
      !threadId ||
      !activeGoalRef.current ||
      activeTurnIdRef.current ||
      isGoalUpdating ||
      isMainChatTransitionLocked()
    )
      return;

    setIsGoalUpdating(true);
    try {
      await window.api.session.clearGoal(threadId);
      setActiveGoal(null);
      activeGoalRef.current = null;
    } catch (error) {
      addSystemItem(`Goal clear failed: ${(error as Error).message}`, 'error');
    } finally {
      setIsGoalUpdating(false);
    }
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey || event.altKey) return;

      if (event.key.toLowerCase() === 't' && !event.shiftKey) {
        event.preventDefault();
        handleNewMainChatTab();
        return;
      }

      if (event.key.toLowerCase() === 'w' && !event.shiftKey) {
        event.preventDefault();
        void handleCloseMainChatTab(activeMainChatTabKeyRef.current);
        return;
      }

      if (
        event.key.toLowerCase() === 'n' &&
        !event.shiftKey &&
        !activeTurnIdRef.current &&
        !isMainChatTransitionLocked()
      ) {
        event.preventDefault();
        handleNewThread();
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),
        );
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        const state = mainChatTabStateRef.current;
        if (state.tabs.length < 2) return;
        const index = state.tabs.findIndex((tab) => tab.key === state.activeKey);
        const direction = event.shiftKey ? -1 : 1;
        const next = state.tabs[(index + direction + state.tabs.length) % state.tabs.length];
        void handleSelectMainChatTab(next.key);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSending, isGoalUpdating, isRestoring, reconcilingMainChatTabKey]);

  const hasThreadContent = items.length > 0;

  function isRelevantThread(incomingThreadId: string): boolean {
    const watched = watchThreadIdRef.current ?? activeThreadIdRef.current;
    return watched !== null && incomingThreadId === watched;
  }

  // ---- Background agent sessions -------------------------------------------

  function restoreAgentDock(): Promise<void> {
    return restorePersistedAgentDock({
      storageKey: agentDockStorageKey,
      mainThreadIds: new Set(
        mainChatTabStateRef.current.tabs.flatMap((tab) => (tab.threadId ? [tab.threadId] : [])),
      ),
      mainChatTabKeys: new Set(mainChatTabStateRef.current.tabs.map((tab) => tab.key)),
      activeMainChatTabKey: activeMainChatTabKeyRef.current,
      store: {
        counterRef: agentCounterRef,
        restoredRef: agentDockRestoredRef,
        updateSessions: updateAgentSessions,
        setOpenKeys: setOpenAgentKeys,
        setSelectedKey: setSelectedAgentKey,
        patchSession: patchAgentSession,
        appendMessage: appendAgentMessage,
        setRenderState: setAgentSessionRender,
      },
    });
  }

  // Compact digest of the focused conversation, prepended to helper-agent
  // sends. Built from renderer state — no extra IPC or token-heavy replay.
  function buildMainChatContext(): string {
    const recent = liteMessagesFromItems(itemsRef.current).slice(-8);
    const lines = recent.map((message) => {
      const text = message.text.length > 600 ? `${message.text.slice(0, 600)}…` : message.text;
      return `${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
    });
    return [
      '<main-chat-context>',
      "You are an optional helper agent running beside the user's main conversation.",
      'Recent main-chat messages follow. Use them as context for the message after the closing tag.',
      'Do not modify workspace files or take actions unless the user explicitly asks you to.',
      '',
      ...lines,
      '',
      `Main chat status: ${activeTurnIdRef.current ? 'a turn is currently running' : 'idle'}.`,
      '</main-chat-context>',
    ].join('\n');
  }

  const {
    bindAgentThread,
    handleAgentSend,
    handleAgentStop,
    handleAgentCompact,
    handleAgentSteer,
  } = createAgentCommands({
    store: {
      sessionsRef: agentSessionsRef,
      startQueueRef: agentStartQueueRef,
      patchSession: patchAgentSession,
      appendMessage: appendAgentMessage,
    },
    getWorkspace: () => workspaceRef.current,
    getSelectedModel: () => selectedModelRef.current,
    getSelectedEffort: () => selectedReasoningEffortRef.current,
    getFastMode: () => fastModeRef.current,
    acceptsImages: (model) => modelAcceptsImages(modelsRef.current, model),
    buildMainChatContext,
    cancelRecovery: cancelAgentRecovery,
    queueThreadStart: (key) => pendingThreadStartOwnersRef.current.push({ kind: 'agent', key }),
    settleThreadStart: (key) => {
      pendingThreadStartOwnersRef.current = pendingThreadStartOwnersRef.current.filter(
        (owner) => owner.kind !== 'agent' || owner.key !== key,
      );
    },
  });

  const agentLifecycle = createAgentLifecycle({
    store: {
      sessionsRef: agentSessionsRef,
      startQueueRef: agentStartQueueRef,
      recoveryRef: agentRecoveryRef,
      updateSessions: updateAgentSessions,
      patchSession: patchAgentSession,
      appendMessage: appendAgentMessage,
      appendMessageOnce: appendAgentMessageOnce,
      resetRenderState: resetAgentSessionRender,
      removeRenderState: removeAgentSessionRender,
      setOpenKeys: setOpenAgentKeys,
      setSelectedKey: setSelectedAgentKey,
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
    createMainThread: handleNewMainChatTab,
    resumeMainThread: handleResumeThread,
  });

  function cancelAgentRecovery(key: string): void {
    agentLifecycle.cancelRecovery(key);
  }

  function maybeScheduleAgentRecovery(key: string, turnId: string, error: TurnError | null): void {
    agentLifecycle.scheduleRecovery(key, turnId, error);
  }

  // Store cleanup for close/reset/promote lives inside agent-lifecycle via
  // resetRenderState/removeRenderState — no App-side wrapping needed.
  const { handleCloseAgentSession, handleResetAgentSession, handlePromoteAgent } = agentLifecycle;

  // ---- End background agent sessions ---------------------------------------

  function cancelAutoRecovery(): void {
    const state = autoRecoveryRef.current;
    if (state?.timer !== null && state?.timer !== undefined) {
      window.clearTimeout(state.timer);
    }
    autoRecoveryRef.current = null;
  }

  function currentModelSlug(): string | null {
    return (
      selectedModelRef.current ?? modelsRef.current.find((model) => model.isDefault)?.model ?? null
    );
  }

  // Next visible catalog entry after the current model, wrapping around. Falls
  // back to the current model when the catalog has nothing else to offer.
  function pickFallbackModel(currentModel: string | null): string | null {
    const catalog = modelsRef.current.filter((model) => !model.hidden);
    if (!catalog.length) return currentModel;
    const index = catalog.findIndex((model) => model.model === currentModel);
    const next = catalog[(index + 1) % catalog.length];
    return next.model === currentModel ? currentModel : next.model;
  }

  function maybeScheduleAutoRecovery(
    threadId: string,
    turnId: string,
    error: TurnError | null,
  ): void {
    if (!error || !isRecoverableTurnError(error.codexErrorInfo)) return;

    const existing =
      autoRecoveryRef.current?.threadId === threadId ? autoRecoveryRef.current : null;
    if (existing?.handledTurnIds.has(turnId)) return;

    const state: AutoRecoveryState = existing ?? {
      threadId,
      attempts: 0,
      handledTurnIds: new Set<string>(),
      timer: null,
    };
    state.handledTurnIds.add(turnId);
    autoRecoveryRef.current = state;

    if (state.attempts >= maxAutoRecoveryAttempts) {
      // Keep the state so the duplicate failure event for this turn stays
      // deduped; a user send or a completed turn resets it.
      addSystemItem(
        `Auto-recovery stopped after ${maxAutoRecoveryAttempts} attempts. Send a message to continue the task.`,
        'error',
      );
      return;
    }

    state.attempts += 1;
    const currentModel = currentModelSlug();
    // First retry stays on the picked model (overload is often transient);
    // later attempts walk the catalog.
    const nextModel = state.attempts === 1 ? currentModel : pickFallbackModel(currentModel);
    const switching = nextModel !== null && nextModel !== currentModel;
    const delaySeconds = Math.round(autoRecoveryDelayMs / 1000);
    addSystemItem(
      switching
        ? `${currentModel ?? 'The model'} is under heavy load — continuing on ${nextModel} in ${delaySeconds}s (attempt ${state.attempts}/${maxAutoRecoveryAttempts}).`
        : `The model is under heavy load — retrying in ${delaySeconds}s (attempt ${state.attempts}/${maxAutoRecoveryAttempts}).`,
      'warning',
    );
    state.timer = window.setTimeout(() => {
      state.timer = null;
      void runAutoRecovery(threadId, nextModel);
    }, autoRecoveryDelayMs);
  }

  async function runAutoRecovery(threadId: string, model: string | null): Promise<void> {
    // Bail silently if the recovery was cancelled or the user took over
    // (sent a message, started a turn, or switched threads) while waiting.
    if (autoRecoveryRef.current?.threadId !== threadId) return;
    if (activeTurnIdRef.current || userTurnRequestPendingRef.current) return;
    if (activeThreadIdRef.current !== threadId) return;

    if (model !== selectedModelRef.current) {
      const selected =
        modelsRef.current.find((candidate) => candidate.model === model) ??
        modelsRef.current.find((candidate) => candidate.isDefault) ??
        null;
      const supported =
        selected?.supportedReasoningEfforts.map((option) => option.reasoningEffort) ?? [];
      const reasoningEffort =
        selectedReasoningEffortRef.current && supported.includes(selectedReasoningEffortRef.current)
          ? selectedReasoningEffortRef.current
          : supported.length
            ? (selected?.defaultReasoningEffort ?? null)
            : null;
      setActiveMainChatModelSelection(model, reasoningEffort);
    }

    try {
      // Turn bookkeeping (active turn id, telemetry, items) happens in the
      // `turn/started` notification handler, same as goal-continuation turns.
      await window.api.session.sendMessage({
        threadId,
        text: autoRecoveryPrompt,
        cwd: workspaceRef.current,
        model,
      });
    } catch (error) {
      addSystemItem(
        `Auto-recovery could not restart the turn: ${(error as Error).message}`,
        'error',
      );
      cancelAutoRecovery();
    }
  }

  function handleMainItemNotification(notification: ItemNotification): void {
    if (!isRelevantThread(notification.params.threadId)) return;

    let compactionBeforeTokens: number | null | undefined;
    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      rememberModelCallInput(notification.params.turnId, notification.params.item);
    }

    if (
      notification.method === 'item/started' &&
      notification.params.item.type === 'contextCompaction'
    ) {
      compactionBeforeTokens = contextUsageRef.current?.last.totalTokens ?? null;
      activeCompactionRef.current = {
        itemId: notification.params.item.id,
        turnId: notification.params.turnId,
        beforeTokens: compactionBeforeTokens,
      };
      setIsCompacting(true);
    }

    setItemMeta((current) =>
      reduceItemNotificationMeta(current, notification, { compactionBeforeTokens }),
    );

    if (isImmediateItemNotification(notification)) {
      // File-change notifications are full, growing snapshots rather than
      // tiny append-only token deltas. Applying each snapshot immediately
      // lets the live diff card visibly grow during long writes instead of
      // collapsing a burst of patches into one update on the next frame.
      flushPendingItemMutations();
      const incomingItems =
        notification.method === 'item/started' || notification.method === 'item/completed'
          ? [notification.params.item]
          : [];
      const optimisticId = optimisticUserMessageIdRef.current;
      if (optimisticId && hasAuthoritativeUserMessage(incomingItems)) {
        optimisticUserMessageIdRef.current = null;
      }
      setItems((current) =>
        reduceItemNotificationItems(
          stripOptimisticUserMessage(current, optimisticId, incomingItems),
          notification,
        ),
      );
    } else if (notification.method !== 'item/mcpToolCall/progress') {
      enqueueItemMutation((current) => reduceItemNotificationItems(current, notification));
    }

    if (
      notification.method === 'item/completed' &&
      notification.params.item.type === 'contextCompaction'
    ) {
      if (activeCompactionRef.current?.itemId === notification.params.item.id) {
        activeCompactionRef.current = null;
      }
      setIsCompacting(false);
    }
  }

  function persistBackgroundMainChatCompletion(
    tab: MainChatTab,
    threadId: string,
    turnId: string,
    snapshot: MainChatSnapshot,
  ): void {
    const meta = snapshot.turnMeta[turnId];
    if (!meta) return;
    const model = meta.model ?? tab.model;
    const workspace = meta.workspace ?? workspaceRef.current;
    const trace = buildTurnTrace({
      threadId,
      threadTitle: snapshot.title || tab.title,
      turnId,
      model,
      workspace,
      items: snapshot.items,
      itemMeta: snapshot.itemMeta,
      meta,
    });
    const traceContent = `${JSON.stringify(trace, null, 2)}\n`;
    const traceFingerprint = JSON.stringify({ ...trace, exportedAt: '' });
    const traceKey = `${threadId}/${turnId}`;
    if (persistedTraceFingerprintsRef.current.get(traceKey) !== traceFingerprint) {
      persistedTraceFingerprintsRef.current.set(traceKey, traceFingerprint);
      void window.api.trace.persist({ threadId, turnId, content: traceContent }).catch((error) => {
        if (persistedTraceFingerprintsRef.current.get(traceKey) === traceFingerprint) {
          persistedTraceFingerprintsRef.current.delete(traceKey);
        }
        console.warn('Failed to persist background turn trace', error);
      });
    }

    const turns = completedMemoryTurns(snapshot.items, snapshot.itemMeta, snapshot.turnMeta);
    if (!turns.length) return;
    const completedAtMs = meta.completedAtMs ?? Date.now();
    const params: MemoryPersistParams = {
      threadId,
      title: snapshot.title || tab.title,
      workspace,
      updatedAt: new Date(completedAtMs).toISOString(),
      turns,
    };
    const memoryFingerprint = JSON.stringify(params);
    if (persistedMemoryFingerprintsRef.current.get(threadId) === memoryFingerprint) return;
    persistedMemoryFingerprintsRef.current.set(threadId, memoryFingerprint);
    void window.api.memory.persist(params).catch((error) => {
      if (persistedMemoryFingerprintsRef.current.get(threadId) === memoryFingerprint) {
        persistedMemoryFingerprintsRef.current.delete(threadId);
      }
      console.warn('Failed to persist background chat memory', error);
    });
  }

  function handleBackgroundMainChatNotification(
    tab: MainChatTab,
    notification: ServerNotification,
  ): void {
    const store = sessionStoreRef.current;
    const existing = store.peek(tab.key);
    // Session presence under a tab key means "cached transcript" and gates
    // hydration (needsMainChatTabHydration), so a rename for a tab that never
    // cached one must not conjure an empty session.
    let nextState: SessionRenderState | null = existing ?? null;
    if (existing || notification.method !== 'thread/name/updated') {
      const seeded = existing ?? emptySessionState({ threadId: tab.threadId, title: tab.title });
      const next = reduceSessionNotification(seeded, notification, {
        atMs: Date.now(),
        fallbackModel: tab.model,
        workspace: workspaceRef.current,
      });
      // A freshly seeded session is stored only when the notification actually
      // touched it — untouched seeds would also read as "cached".
      if (existing || next !== seeded) {
        store.set(tab.key, next);
        nextState = next;
      }
    }

    switch (notification.method) {
      case 'thread/name/updated':
        patchMainChatTab(tab.key, (current) => ({
          ...current,
          title: notification.params.threadName || 'New Chat',
        }));
        void refreshThreads();
        return;
      case 'turn/started':
        patchMainChatTab(tab.key, (current) => ({
          ...current,
          status: 'working',
          turnId: notification.params.turn.id,
        }));
        return;
      case 'turn/completed': {
        const turn = notification.params.turn;
        patchMainChatTab(tab.key, (current) => ({
          ...current,
          status: 'attention',
          turnId: null,
        }));
        void window.api.notifications.backgroundTurn({
          threadId: notification.params.threadId,
          title: tab.title || 'Chat',
          status: turn.status === 'failed' ? 'failed' : 'completed',
          message: turn.error?.message ?? null,
        });
        if (nextState) {
          persistBackgroundMainChatCompletion(
            tab,
            notification.params.threadId,
            turn.id,
            nextState,
          );
        }
        void refreshThreads();
        return;
      }
      case 'error':
        if (!notification.params.willRetry) {
          patchMainChatTab(tab.key, (current) => ({
            ...current,
            status: 'attention',
            turnId: null,
          }));
        }
        return;
      default:
        return;
    }
  }

  function handleCodexNotification(notification: ServerNotification): void {
    const currentThreadId = activeThreadIdRef.current;

    // Threads owned by background agent sessions route to the lite reducer and
    // never touch the focused view's state.
    const incomingThreadId = (notification.params as { threadId?: string } | undefined)?.threadId;
    if (incomingThreadId && !isRelevantThread(incomingThreadId)) {
      const backgroundMainTab = mainChatTabForThread(incomingThreadId);
      if (backgroundMainTab) {
        handleBackgroundMainChatNotification(backgroundMainTab, notification);
        return;
      }
      const backgroundSession = backgroundSessionForThread(incomingThreadId);
      if (backgroundSession) {
        if (notification.method === 'thread/name/updated') {
          // Dock titles stay "Agent N"; only the history list refreshes.
          void refreshThreads();
          return;
        }
        // useAgentSessions owns the store reduction for dock threads (it
        // reduces via reduceSessionNotification under the agent key and
        // projects the lite view from the result) — reducing here as well
        // would apply every delta twice.
        handleAgentNotification(backgroundSession, notification);
        if (notification.method === 'turn/completed') {
          void maybeSendAuditFeedback(backgroundSession.key);
        }
        return;
      }
    }

    if (isItemNotification(notification)) {
      handleMainItemNotification(notification);
      return;
    }

    switch (notification.method) {
      case 'thread/started': {
        // A thread started for a dock agent binds to its session instead of
        // taking over the main view. Two orderings are possible: if the
        // startThread IPC response resolved first, the thread is already bound
        // (check by id); if this notification arrived first, the pending queue
        // holds the session key.
        const startedThreadId = notification.params.thread.id;
        if (mainChatTabForThread(startedThreadId)) {
          return;
        }
        if (startedThreadId && backgroundSessionForThread(startedThreadId)) {
          return;
        }
        // A first send creates its thread inside `sendMessage`. Its
        // notifications can arrive before that IPC call returns, so claim the
        // next IPC owner before `turn/started` needs to route its items.
        const pendingOwner = pendingThreadStartOwnersRef.current.shift();
        if (pendingOwner?.kind === 'main') {
          mainThreadStartsInFlightRef.current.delete(pendingOwner.key);
          const startedTitle = threadTitle(notification.params.thread);
          patchMainChatTab(pendingOwner.key, (tab) => ({
            ...tab,
            threadId: startedThreadId,
            title: startedTitle,
          }));
          if (activeMainChatTabKeyRef.current === pendingOwner.key) {
            watchThreadIdRef.current = startedThreadId;
            activeThreadIdRef.current = startedThreadId;
            setActiveThreadId(startedThreadId);
            activeThreadTitleRef.current = startedTitle;
            setActiveThreadTitle(startedTitle);
            persistLastThreadId(startedThreadId);
          }
          return;
        }
        if (pendingOwner?.kind === 'agent') {
          bindAgentThread(pendingOwner.key, startedThreadId);
          return;
        }
        watchThreadIdRef.current = notification.params.thread.id;
        persistLastThreadId(notification.params.thread.id);
        activeThreadIdRef.current = notification.params.thread.id;
        setActiveThreadId(notification.params.thread.id);
        activeThreadTitleRef.current = threadTitle(notification.params.thread);
        setActiveThreadTitle(activeThreadTitleRef.current);
        patchMainChatTab(activeMainChatTabKeyRef.current, (tab) => ({
          ...tab,
          threadId: notification.params.thread.id,
          title: threadTitle(notification.params.thread),
        }));
        return;
      }
      case 'thread/goal/updated':
        if (isRelevantThread(notification.params.threadId)) {
          const goal = cloneGoal(notification.params.goal);
          setActiveGoal(goal);
          activeGoalRef.current = goal;
          if (notification.params.turnId) {
            noteTurn(notification.params.turnId, { goalAtEnd: goal });
          }
        }
        return;
      case 'thread/goal/cleared':
        if (isRelevantThread(notification.params.threadId)) {
          setActiveGoal(null);
          activeGoalRef.current = null;
          const turnId = activeTurnIdRef.current;
          if (turnId) noteTurn(turnId, { goalAtEnd: null });
        }
        return;
      case 'thread/name/updated':
        if (notification.params.threadId === currentThreadId) {
          const title = notification.params.threadName || 'New Chat';
          activeThreadTitleRef.current = title;
          setActiveThreadTitle(title);
          patchMainChatTab(activeMainChatTabKeyRef.current, (tab) => ({ ...tab, title }));
        }
        void refreshThreads();
        return;
      case 'thread/archived':
      case 'thread/deleted':
      case 'thread/closed':
        removeThreadFromList(notification.params.threadId);
        return;
      case 'turn/started':
        if (!watchThreadIdRef.current && !activeThreadIdRef.current) {
          watchThreadIdRef.current = notification.params.threadId;
          persistLastThreadId(notification.params.threadId);
        }

        if (isRelevantThread(notification.params.threadId)) {
          const turn = notification.params.turn;
          const goalSnapshot = cloneGoal(activeGoalRef.current);
          const userInitiated =
            userTurnRequestPendingRef.current || userRequestedTurnIdRef.current === turn.id;
          if (userRequestedTurnIdRef.current === turn.id) userRequestedTurnIdRef.current = null;
          const goalContinuation = goalSnapshot?.status === 'active' && !userInitiated;
          setActiveThreadId(notification.params.threadId);
          setActiveTurnId(turn.id);
          activeTurnIdRef.current = turn.id;
          patchMainChatTab(activeMainChatTabKeyRef.current, (tab) => ({
            ...tab,
            threadId: notification.params.threadId,
            status: 'working',
            turnId: turn.id,
          }));
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
            startedAtMs: turn.startedAt ? turn.startedAt * 1000 : Date.now(),
          });
          for (const item of turn.items) rememberModelCallInput(turn.id, item);
          adoptTurnItems(turn.id, turn.items);
          mergeItems(turn.items);
        }
        return;
      case 'turn/completed':
        if (isRelevantThread(notification.params.threadId)) {
          const turn = notification.params.turn;
          adoptTurnItems(turn.id, turn.items);
          mergeItems(turn.items);
          noteTurn(turn.id, {
            status: turn.status === 'inProgress' ? 'completed' : turn.status,
            completedAtMs: turn.completedAt ? turn.completedAt * 1000 : Date.now(),
            durationMs: turn.durationMs ?? undefined,
            errorMessage: turn.error?.message,
            goalAtEnd: cloneGoal(activeGoalRef.current),
          });
          if (activeTurnIdRef.current === turn.id) activeTurnIdRef.current = null;
          setActiveTurnId((current) => (current === turn.id ? null : current));
          patchMainChatTab(activeMainChatTabKeyRef.current, (tab) => ({
            ...tab,
            status: 'idle',
            turnId: null,
          }));
          void maybeTriggerAuditors(turn.id);
          if (turn.status === 'failed') {
            maybeScheduleAutoRecovery(notification.params.threadId, turn.id, turn.error);
          } else {
            // The thread produced a healthy terminal turn (completed, or the
            // user interrupted), so any recovery chain is over.
            cancelAutoRecovery();
          }
        }
        void refreshThreads();
        return;
      case 'thread/tokenUsage/updated':
        if (isRelevantThread(notification.params.threadId)) {
          contextUsageRef.current = notification.params.tokenUsage;
          setContextUsage(notification.params.tokenUsage);
          const activeCompaction = activeCompactionRef.current;
          if (activeCompaction && activeCompaction.turnId === notification.params.turnId) {
            // The compaction turn reports the shrunken context before its
            // item completes; pin both sizes on the item for the transcript.
            noteItem(activeCompaction.itemId, activeCompaction.turnId, {
              compaction: {
                beforeTokens: activeCompaction.beforeTokens,
                afterTokens: notification.params.tokenUsage.last.totalTokens,
              },
            });
          }
          // Computed OUTSIDE the setter: store-backed setters apply
          // synchronously, so a ref write nested inside the updater would be
          // overwritten when the outer update commits its (stale-base) result.
          {
            const existing = turnMetaRef.current[notification.params.turnId]?.tokens;
            const isNewCall = existing
              ? notification.params.tokenUsage.total.totalTokens >
                existing.threadTotalAtEnd.totalTokens
              : notification.params.tokenUsage.last.totalTokens > 0;
            const compactedBeforeCall =
              isNewCall && pendingCompactionByTurnRef.current.has(notification.params.turnId);
            if (compactedBeforeCall) {
              pendingCompactionByTurnRef.current = new Set(
                [...pendingCompactionByTurnRef.current].filter(
                  (turnId) => turnId !== notification.params.turnId,
                ),
              );
            }
            const precedingItem =
              precedingModelInputByTurnRef.current.get(notification.params.turnId) ?? null;

            setTurnMeta((current) =>
              reduceTurnTelemetry(current, {
                type: 'tokenUsage',
                turnId: notification.params.turnId,
                tokenUsage: notification.params.tokenUsage,
                atMs: Date.now(),
                precedingItem,
                compactedBeforeCall,
              }),
            );
          }
        }
        return;
      case 'model/rerouted':
        if (isRelevantThread(notification.params.threadId)) {
          setTurnMeta((current) =>
            reduceTurnTelemetry(current, {
              type: 'modelRerouted',
              turnId: notification.params.turnId,
              atMs: Date.now(),
              fromModel: notification.params.fromModel,
              toModel: notification.params.toModel,
              reason: notification.params.reason,
            }),
          );
        }
        return;
      case 'turn/diff/updated':
        if (isRelevantThread(notification.params.threadId)) {
          noteTurn(notification.params.turnId, {
            diffSummary: summarizeTurnDiff(notification.params.diff),
          });
        }
        return;
      case 'turn/plan/updated':
        if (isRelevantThread(notification.params.threadId)) {
          upsertTurnPlan(
            notification.params.turnId,
            notification.params.explanation,
            notification.params.plan,
          );
        }
        return;
      case 'error':
        if (isRelevantThread(notification.params.threadId)) {
          setTurnMeta((current) =>
            reduceTurnTelemetry(current, {
              type: 'error',
              turnId: notification.params.turnId,
              atMs: Date.now(),
              message: notification.params.error.message,
              willRetry: notification.params.willRetry,
            }),
          );

          if (!notification.params.willRetry) {
            addSystemItem(notification.params.error.message, 'error');
            if (activeTurnIdRef.current === notification.params.turnId)
              activeTurnIdRef.current = null;
            setActiveTurnId((current) => (current === notification.params.turnId ? null : current));
            patchMainChatTab(activeMainChatTabKeyRef.current, (tab) => ({
              ...tab,
              status: 'idle',
              turnId: null,
            }));
            maybeScheduleAutoRecovery(
              notification.params.threadId,
              notification.params.turnId,
              notification.params.error,
            );
          }
        }
        return;
      case 'warning':
        if (!notification.params.threadId || isRelevantThread(notification.params.threadId)) {
          addSystemItem(notification.params.message, 'warning');
        }
        return;
      default:
        return;
    }
  }

  function mergeItems(nextItems: ThreadItem[]): void {
    flushPendingItemMutations();
    const optimisticId = optimisticUserMessageIdRef.current;
    if (optimisticId && hasAuthoritativeUserMessage(nextItems)) {
      optimisticUserMessageIdRef.current = null;
    }
    setItems((current) =>
      upsertMany(stripOptimisticUserMessage(current, optimisticId, nextItems), nextItems),
    );
  }

  // Record lifecycle metadata for an item. The incoming turnId wins when
  // present; existing fields survive partial updates.
  function noteItem(itemId: string, turnId: string | null, patch: Partial<ItemMeta> = {}): void {
    setItemMeta((current) => {
      const existing = current[itemId];
      const nextItem = {
        ...existing,
        ...patch,
        turnId: turnId ?? existing?.turnId ?? null,
      };

      if (
        existing &&
        Object.keys(nextItem).every((key) =>
          Object.is(existing[key as keyof ItemMeta], nextItem[key as keyof ItemMeta]),
        )
      ) {
        return current;
      }

      return {
        ...current,
        [itemId]: nextItem,
      };
    });
  }

  function noteTurn(turnId: string, patch: Partial<TurnMeta>): void {
    setTurnMeta((current) => reduceTurnTelemetry(current, { type: 'patch', turnId, patch }));
  }

  function rememberModelCallInput(turnId: string, item: ThreadItem): void {
    if (item.type === 'contextCompaction') {
      pendingCompactionByTurnRef.current = new Set(pendingCompactionByTurnRef.current).add(turnId);
      return;
    }

    const attribution = modelCallAttributionForItem(item);
    if (attribution) {
      precedingModelInputByTurnRef.current = new Map(precedingModelInputByTurnRef.current).set(
        turnId,
        attribution,
      );
    }
  }

  // Tag a batch of items (from turn/started, turn/completed, or turn/start
  // responses) with the turn they belong to.
  function adoptTurnItems(turnId: string, turnItems: ThreadItem[]): void {
    setItemMeta((current) => {
      const next = { ...current };
      for (const item of turnItems) {
        next[item.id] = { ...next[item.id], turnId };
      }
      return next;
    });
  }

  function removeThreadFromList(threadId: string): void {
    setThreads((current) => current.filter((thread) => thread.id !== threadId));

    if (window.localStorage.getItem(lastThreadStorageKey) === threadId) {
      persistLastThreadId(null);
    }
  }

  async function refreshThreads(options: { append?: boolean } = {}): Promise<void> {
    const cursor = options.append ? threadsNextCursorRef.current : null;

    try {
      setThreadsLoading(true);

      if (!options.append) {
        setThreadsError(null);
      }

      const response = await window.api.session.listThreads({
        // Ref, not state: refreshThreads is invoked from the mount-only codex
        // event handler (e.g. agent turn/completed), whose closure captured the
        // launch-time `workspace`. Using the ref refetches the current workspace.
        cwd: workspaceRef.current,
        cursor,
      });

      setThreads((current) => (options.append ? [...current, ...response.data] : response.data));
      setThreadsNextCursor(response.nextCursor);
    } catch (error) {
      if (!options.append) {
        setThreadsError((error as Error).message);
      }
    } finally {
      setThreadsLoading(false);
    }
  }

  async function loadMoreThreads(): Promise<void> {
    if (!threadsNextCursorRef.current || threadsLoading) {
      return;
    }

    await refreshThreads({ append: true });
  }

  async function restoreBackgroundMainChatTabs(activeThreadId: string | null): Promise<void> {
    const backgroundTabs = mainChatTabStateRef.current.tabs.filter(
      (tab) => tab.threadId && tab.threadId !== activeThreadId,
    );
    // Paint every persisted tab from its own cache before a user can switch to
    // it. These reads are tiny and parallel; server resumes below still own
    // live status and metadata reconciliation.
    await Promise.all(backgroundTabs.map((tab) => restoreCachedTranscript(tab.threadId!, tab.key)));
    // Resume in small waves: each call can return a substantial initial turn
    // page, and restoring a full working set should not stampede app-server.
    for (let index = 0; index < backgroundTabs.length; index += 3) {
      const wave = backgroundTabs.slice(index, index + 3);
      await Promise.all(
        wave.map(async (tab) => {
          try {
            const resumed = await window.api.session.resumeThread({
              threadId: tab.threadId!,
              history: 'background',
            });
            const turns: Turn[] = resumed.thread.turns.length
              ? resumed.thread.turns
              : (resumed.initialTurnsPage?.data ?? []);
            const inProgress = turns.find((turn) => turn.status === 'inProgress') ?? null;
            patchMainChatTab(tab.key, (current) => ({
              ...current,
              title: threadTitle(resumed.thread),
              model: resumed.model ?? current.model,
              reasoningEffort: resumed.reasoningEffort ?? current.reasoningEffort,
              status: inProgress ? 'working' : 'idle',
              turnId: inProgress?.id ?? null,
            }));
            clearResumeFailure(tab.key, tab.threadId!);
          } catch (error) {
            console.warn(`Failed to restore background chat tab ${tab.threadId}`, error);
            markResumeFailure(tab.key, tab.threadId!, error);
          }
        }),
      );
    }
  }

  function hydrateThread(
    thread: Thread,
    fallbackTurns?: Turn[],
    environment?: {
      model: string | null;
      workspace: string | null;
      reasoningEffort: ReasoningEffort | null;
    },
  ): void {
    const turns = thread.turns.length > 0 ? thread.turns : (fallbackTurns ?? []);
    const cached = sessionStoreRef.current.peek(activeMainChatTabKeyRef.current);
    const cachedSession = cached?.threadId === thread.id ? cached : null;

    precedingModelInputByTurnRef.current = new Map();
    pendingCompactionByTurnRef.current = new Set();
    // No usage snapshot until the resumed thread's next model call reports in.
    setContextUsage(null);
    contextUsageRef.current = null;
    setIsCompacting(false);
    activeCompactionRef.current = null;

    const nextTitle = threadTitle(thread);
    watchThreadIdRef.current = thread.id;
    activeThreadIdRef.current = thread.id;
    setActiveThreadId(thread.id);
    activeThreadTitleRef.current = nextTitle;
    setActiveThreadTitle(nextTitle);
    const inProgressTurnId = turns.find((turn) => turn.status === 'inProgress')?.id ?? null;
    setActiveTurnId(inProgressTurnId);
    activeTurnIdRef.current = inProgressTurnId;

    const nextItems: ChatItem[] = [];
    const nextItemMeta: Record<string, ItemMeta> = {};
    const nextTurnMeta: Record<string, TurnMeta> = {};

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
        errorMessage: turn.error?.message,
      };
      for (const item of turn.items) {
        if (turn.status === 'inProgress') rememberModelCallInput(turn.id, item);
        nextItemMeta[item.id] = { turnId: turn.id };
        nextItems.push(item);
      }
    }

    // A fast disk restore may already have older rows on screen. The resumed
    // server tail is authoritative for duplicate ids, while cached-only rows
    // remain visible until their normal lazy server page arrives.
    const reconciledItems = cachedSession ? upsertMany(cachedSession.items, nextItems) : nextItems;
    const reconciledItemMeta = cachedSession
      ? { ...cachedSession.itemMeta, ...nextItemMeta }
      : nextItemMeta;
    const reconciledTurnMeta = cachedSession
      ? { ...cachedSession.turnMeta, ...nextTurnMeta }
      : nextTurnMeta;
    itemsRef.current = reconciledItems;
    itemMetaRef.current = reconciledItemMeta;
    turnMetaRef.current = reconciledTurnMeta;
    setItems(reconciledItems);
    setItemMeta(reconciledItemMeta);
    setTurnMeta(reconciledTurnMeta);
    patchMainChatTab(activeMainChatTabKeyRef.current, (tab) => ({
      ...tab,
      threadId: thread.id,
      title: nextTitle,
      status: inProgressTurnId ? 'working' : 'idle',
      turnId: inProgressTurnId,
    }));
  }

  async function loadOlderThreadHistory(threadId: string, tabKey: string): Promise<void> {
    const cursor = olderHistoryCursorByThreadRef.current.get(threadId);
    if (!cursor || olderHistoryLoadsRef.current.has(threadId)) return;

    olderHistoryLoadsRef.current.add(threadId);
    try {
      const page = await window.api.session.listThreadTurns({ threadId, cursor, limit: 10 });
      olderHistoryCursorByThreadRef.current.set(threadId, page.nextCursor);
      if (activeThreadIdRef.current !== threadId || activeMainChatTabKeyRef.current !== tabKey)
        return;

      const currentItemIds = new Set(itemsRef.current.map((item) => item.id));
      const currentTurnIds = new Set(Object.keys(turnMetaRef.current));
      const olderItems: ChatItem[] = [];
      const nextItemMeta = { ...itemMetaRef.current };
      const nextTurnMeta = { ...turnMetaRef.current };
      const tab = mainChatTabStateRef.current.tabs.find((candidate) => candidate.key === tabKey);

      for (const turn of [...page.data].reverse()) {
        if (currentTurnIds.has(turn.id)) continue;
        nextTurnMeta[turn.id] = {
          status: turn.status,
          origin: 'restored',
          model: tab?.model ?? selectedModelRef.current,
          reasoningEffort: tab?.reasoningEffort ?? selectedReasoningEffortRef.current,
          workspace: workspaceRef.current,
          startedAtMs: turn.startedAt ? turn.startedAt * 1000 : undefined,
          completedAtMs: turn.completedAt ? turn.completedAt * 1000 : undefined,
          durationMs: turn.durationMs ?? undefined,
          errorMessage: turn.error?.message,
        };
        for (const item of turn.items) {
          if (currentItemIds.has(item.id)) continue;
          currentItemIds.add(item.id);
          olderItems.push(item);
          nextItemMeta[item.id] = { turnId: turn.id };
        }
      }

      if (!olderItems.length) return;
      const nextItems = [...olderItems, ...itemsRef.current];
      itemsRef.current = nextItems;
      itemMetaRef.current = nextItemMeta;
      turnMetaRef.current = nextTurnMeta;
      setItems(nextItems);
      setItemMeta(nextItemMeta);
      setTurnMeta(nextTurnMeta);
    } catch (error) {
      console.warn(`Failed to load older history for ${threadId}`, error);
    } finally {
      olderHistoryLoadsRef.current.delete(threadId);
    }
  }

  // Queue a streaming mutation and schedule a single batched apply. Every delta
  // kind funnels through here so a burst of reasoning/command/text tokens
  // collapses into one setItems (one buildRows + one render) per display frame
  // instead of one per token. This keeps final-answer motion at the screen's
  // native cadence while still coalescing bursts from the transport.
  function enqueueItemMutation(mutate: (items: ChatItem[]) => ChatItem[]): void {
    pendingItemMutationsRef.current.push(mutate);

    if (itemMutationFrameRef.current !== null) {
      return;
    }

    itemMutationFrameRef.current = window.requestAnimationFrame(() => {
      itemMutationFrameRef.current = null;
      flushPendingItemMutations();
    });
  }

  // Apply every queued mutation in order in a single state update. Ordering is
  // preserved (mutations run in enqueue order), so this is safe to call ahead of
  // a full-item upsert to keep pending deltas from landing after their item.
  function flushPendingItemMutations(): void {
    const pending = pendingItemMutationsRef.current;

    if (!pending.length) {
      return;
    }

    if (itemMutationFrameRef.current !== null) {
      window.cancelAnimationFrame(itemMutationFrameRef.current);
      itemMutationFrameRef.current = null;
    }

    pendingItemMutationsRef.current = [];
    let next = itemsRef.current;
    for (const mutate of pending) {
      next = mutate(next);
    }
    itemsRef.current = next;
    setItems(next);
  }

  // The structured turn plan renders as a live checklist card that updates in
  // place as steps complete.
  function upsertTurnPlan(
    turnId: string,
    explanation: string | null,
    plan: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>,
  ): void {
    if (!plan.length && !explanation) {
      return;
    }

    const id = `turn-plan-${turnId}`;
    const item: TurnPlanItem = { type: 'turnPlan', id, explanation, steps: plan };
    noteItem(id, turnId);
    setItems((current) => upsertMany(current, [item]));
  }

  function addSystemItem(text: string, level: SystemItem['level'] = 'info'): void {
    setItems((current) => [...current, { type: 'system', id: crypto.randomUUID(), level, text }]);
  }

  // Codex-doer / Claude-auditor pairing: when the focused main chat completes
  // a turn, idle dock agents in audit mode receive a compact briefing. Turns
  // that changed files get the workspace-grounded diff audit (the auditor
  // runs `git diff` itself); chat-only turns get a second-opinion review of
  // the answer — trivial turns earn a few words by prompt design, not a skip.
  // Failed/interrupted turns trigger too: partial work is prime material.
  // Busy auditors are skipped, not queued.
  async function maybeTriggerAuditors(turnId: string): Promise<void> {
    const activeTabKey = activeMainChatTabKeyRef.current;
    const auditors = agentSessionsRef.current.filter(
      (session) => session.mainChatTabKey === activeTabKey && session.auditsMain,
    );
    if (!auditors.length) return;
    const threadId = activeThreadIdRef.current;
    // fileChange items only cover editor-tool edits; the checkpoint diff is
    // ground truth and also catches shell-command writes (the doer's most
    // common editing mode). null = detection unavailable (no checkpoint for
    // this turn — typically a non-git workspace), distinct from an empty diff.
    let changed = turnChangedFiles(itemsRef.current, itemMetaRef.current, turnId);
    let detectionUnavailable = false;
    if (!changed.length && threadId) {
      const diffed = await window.api.checkpoints
        .changedFiles({ threadId, turnId })
        .catch(() => null);
      if (diffed === null) detectionUnavailable = true;
      else changed = diffed;
    }
    // Check again after the async checkpoint lookup. The user may have
    // switched chats while the diff was loading; never send an audit prompt
    // built from the wrong main-chat tab.
    if (
      activeMainChatTabKeyRef.current !== activeTabKey ||
      activeThreadIdRef.current !== threadId
    ) {
      return;
    }
    const userItem = itemsRef.current.find(
      (item) => item.type === 'userMessage' && itemMetaRef.current[item.id]?.turnId === turnId,
    );
    const userText =
      userItem && userItem.type === 'userMessage'
        ? userItem.content
            .filter((content) => content.type === 'text')
            .map((content) => stripMentionContext(stripAutomaticSkillMarker(stripInjectedMemory(content.text))))
            .join('\n')
            .trim() || '(request text unavailable)'
        : '(request text unavailable)';
    const steps = turnStepLines(itemsRef.current, itemMetaRef.current, turnId);
    const answerText = turnAnswerText(itemsRef.current, itemMetaRef.current, turnId);
    if (!changed.length && !answerText && !steps.length) {
      // Nothing to review at all (interrupted before any output). Tell armed
      // auditors why nothing fired — silence reads as hung.
      for (const auditor of auditors) {
        patchAgentSession(auditor.key, (session) => ({
          ...session,
          lastAuditNote: 'Last turn finished with nothing to review',
        }));
      }
      return;
    }
    const prompt = buildAuditPrompt({ userText, files: changed, steps, answerText, detectionUnavailable });
    // Structured summary rides along on the displayed message so the card can
    // render a compact collapsible card; the model still receives `prompt`.
    const auditSummary = { userText, files: changed, steps, answerText };
    for (const auditor of auditors) {
      if (
        !shouldTriggerAudit({
          auditorStatus: auditor.status,
          auditorTurnId: auditor.turnId,
          changedFiles: changed,
          answerText,
          stepCount: steps.length,
        })
      )
        continue;
      patchAgentSession(auditor.key, (session) => ({ ...session, lastAuditNote: null }));
      auditContextByAuditorRef.current.set(auditor.key, {
        threadId,
        auditedTurnWasFeedback: auditFeedbackTurnIdsRef.current.has(turnId),
      });
      void handleAgentSend(auditor.key, prompt, [], { audit: auditSummary });
    }
  }

  // Audit feedback: when an auditor with "send findings to main chat" enabled
  // finishes an audit with VERDICT: flag, the report flows into the main chat
  // as a visible turn for the doer to act on. Gated (pure, tested): flag-only
  // (pass verdicts converge the loop), main idle, same thread, and one bounce
  // per user-initiated turn — feedback-started turns are re-audited and
  // display their verdict, but never auto-send again.
  async function maybeSendAuditFeedback(sessionKey: string): Promise<void> {
    const session = agentSessionsRef.current.find((candidate) => candidate.key === sessionKey);
    if (!session?.reportsToMain) return;
    const context = auditContextByAuditorRef.current.get(sessionKey);
    // Only the audit exchange counts: the latest user message must be the
    // audit briefing (manual chats with the agent never auto-send).
    const report = latestAuditReport(session.messages);
    if (!report) return;
    // One auto-send attempt per audit, whatever the outcome.
    auditContextByAuditorRef.current.delete(sessionKey);
    if (parseAuditVerdict(report) !== 'flag') return;
    // A flagged report that does NOT flow explains itself — a silently
    // suppressed sendback reads as broken (and the flag badge stays clickable
    // for manual escalation).
    const explainSkip = (reason: string): void => {
      patchAgentSession(sessionKey, (current) => ({ ...current, lastAuditNote: reason }));
    };
    if (!context) {
      explainSkip('Flagged — not auto-sent (audit predates this session); click the flag to send');
      return;
    }
    if (
      !shouldSendAuditFeedback({
        verdict: 'flag',
        reportsToMain: session.reportsToMain,
        mainIdle: !activeTurnIdRef.current,
        sameThread: context.threadId !== null && context.threadId === activeThreadIdRef.current,
        auditedTurnWasFeedback: context.auditedTurnWasFeedback,
      })
    ) {
      explainSkip(
        context.auditedTurnWasFeedback
          ? 'Flagged — auto-send capped at one round per turn; click the flag to send'
          : activeTurnIdRef.current
            ? 'Flagged — main chat was busy; click the flag to send'
            : 'Flagged — main chat moved on; click the flag to send',
      );
      return;
    }
    pendingAuditFeedbackRef.current = true;
    const sent = await handleSend(buildAuditFeedbackMessage({ agentTitle: session.title, report }));
    pendingAuditFeedbackRef.current = false;
    if (sent) {
      patchAgentSession(sessionKey, (current) => ({ ...current, lastAuditNote: null }));
    } else {
      explainSkip('Flagged — main chat became busy; click the flag to send');
    }
  }

  // Manual escalation: clicking a flagged verdict badge sends that audit's
  // report into the main chat now — covering toggled-on-too-late, busy-at-
  // completion, and post-restart audits that the auto path could not serve.
  async function handleSendAuditFeedbackNow(sessionKey: string): Promise<void> {
    const session = agentSessionsRef.current.find((candidate) => candidate.key === sessionKey);
    if (!session) return;
    const report = latestAuditReport(session.messages);
    if (!report) return;
    // User-initiated: no bounce mark — the resulting turn gets a fresh audit
    // with full auto-send rights, exactly like any user message.
    const sent = await handleSend(buildAuditFeedbackMessage({ agentTitle: session.title, report }));
    patchAgentSession(sessionKey, (current) => ({
      ...current,
      lastAuditNote: sent ? null : 'Main chat is busy — try again when it finishes',
    }));
  }

  // Phase 4 ledger: turnId -> checkpointId for the focused thread, refreshed on
  // thread switches and turn completion (checkpoints bind their turn id
  // shortly after the turn starts). Reversibility only — never a gate.
  const [turnCheckpoints, setTurnCheckpoints] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!activeThreadId) {
      setTurnCheckpoints({});
      return;
    }
    let stale = false;
    void window.api.checkpoints
      .list(activeThreadId)
      .then((records) => {
        if (stale) return;
        const byTurn: Record<string, string> = {};
        for (const record of records) {
          if (record.turnId) byTurn[record.turnId] = record.id;
        }
        setTurnCheckpoints(byTurn);
      })
      .catch(() => {
        // No checkpoints (non-git workspace or store failure): the ledger simply
        // offers no revert.
      });
    return () => {
      stale = true;
    };
  }, [activeThreadId, activeTurnId]);

  async function handleRevertTurn(turnId: string): Promise<boolean> {
    const checkpointId = turnCheckpoints[turnId];
    if (!checkpointId) return false;
    try {
      await window.api.checkpoints.revert({ checkpointId });
      addSystemItem(
        'Workspace files restored to before this turn. The pre-revert state was checkpointed too, so this revert can itself be reverted.',
      );
      return true;
    } catch (error) {
      addSystemItem(`Revert failed: ${(error as Error).message}`, 'error');
      return false;
    }
  }

  // Review flow (Cursor-style Keep/Undo): edits auto-apply during the turn;
  // once it settles, the review bar and per-file Undo buttons offer post-hoc
  // control backed by the same turn checkpoints. Client-side state only —
  // "kept" simply dismisses the review surface for that turn.
  const [turnReviews, setTurnReviews] = useState<Record<string, 'kept' | 'undone'>>({});
  const [undoneFiles, setUndoneFiles] = useState<Record<string, string[]>>({});
  useEffect(() => {
    setTurnReviews({});
    setUndoneFiles({});
  }, [activeThreadId]);

  const handleKeepTurn = useCallback((turnId: string): void => {
    setTurnReviews((current) => ({ ...current, [turnId]: 'kept' }));
  }, []);

  const handleSetAlwaysKeepAll = useCallback((enabled: boolean): void => {
    setAlwaysKeepAll(enabled);
    window.localStorage.setItem(alwaysKeepAllStorageKey, storedAlwaysKeepAllValue(enabled));
  }, []);

  const handleUndoTurnAll = useCallback(
    async (turnId: string): Promise<void> => {
      if (await handleRevertTurn(turnId)) {
        setTurnReviews((current) => ({ ...current, [turnId]: 'undone' }));
      }
    },
    // handleRevertTurn is a plain closure over turnCheckpoints.
    [turnCheckpoints],
  );

  const handleUndoFile = useCallback(
    async (turnId: string, path: string): Promise<void> => {
      const checkpointId = turnCheckpoints[turnId];
      if (!checkpointId) return;
      try {
        await window.api.checkpoints.revertFiles({ checkpointId, paths: [path] });
        setUndoneFiles((current) => ({
          ...current,
          [turnId]: [...(current[turnId] ?? []), path],
        }));
      } catch (error) {
        addSystemItem(`Undo failed: ${(error as Error).message}`, 'error');
      }
    },
    // addSystemItem is a stable plain closure; turnCheckpoints is the real dep.
    [turnCheckpoints],
  );

  return (
    <div ref={appRef} className="app-shell">
      <TitleBar />
      <main
        className="workspace"
        style={{ gridTemplateColumns: `${split}% ${dividerWidth}px 1fr` }}
      >
        <ChatPane
          turnCheckpoints={turnCheckpoints}
          onRevertTurn={(turnId) => void handleRevertTurn(turnId)}
          turnReviews={turnReviews}
          undoneFiles={undoneFiles}
          alwaysKeepAll={alwaysKeepAll}
          onKeepTurn={handleKeepTurn}
          onSetAlwaysKeepAll={handleSetAlwaysKeepAll}
          onUndoTurnAll={handleUndoTurnAll}
          onUndoFile={handleUndoFile}
          agentSessionStore={sessionStoreRef.current}
          mainChatTabs={mainChatTabs}
          activeMainChatTabKey={activeMainChatTabKey}
          mainChatTabsDisabled={
            isSending || isGoalUpdating || isRestoring || Boolean(reconcilingMainChatTabKey)
          }
          onSelectMainChatTab={handleSelectMainChatTab}
          onReorderMainChatTabs={handleReorderMainChatTabs}
          onCloseMainChatTab={handleCloseMainChatTab}
          onNewMainChatTab={handleNewMainChatTab}
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
          isBusy={
            isRestoring || isSending || Boolean(activeTurnId) || Boolean(reconcilingMainChatTabKey)
          }
          workspace={workspace}
          models={models}
          selectedModel={selectedModel}
          selectedReasoningEffort={selectedReasoningEffort}
          fastMode={fastMode}
          onSelectModel={handleSelectModel}
          onSelectModelEffort={handleSelectModelEffort}
          onSetFastMode={handleSetFastMode}
          onSend={handleSend}
          onSteer={handleSteer}
          onStop={handleStop}
          onNewThread={handleNewThread}
          onToggleThreadMenu={() => setIsThreadMenuOpen((open) => !open)}
          onResumeThread={async (threadId) => {
            await handleResumeThread(threadId);
          }}
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
          onToggleAuditAgent={handleToggleAuditAgent}
          onToggleReportAgent={handleToggleReportAgent}
          onSendAuditFeedback={(key) => void handleSendAuditFeedbackNow(key)}
          onDecideAgentSendPolicy={handleDecideSendPolicy}
          onSetAgentModel={handleSelectAgentModel}
          onSetAgentModelEffort={handleSelectAgentModelEffort}
          onNewAgent={(mainChatTabKey) => handleNewAgent(mainChatTabKey)}
          onPromoteAgent={(key) => void handlePromoteAgent(key)}
          onCloseAgentSession={handleCloseAgentSession}
          onResetAgentSession={handleResetAgentSession}
          onAgentSend={handleAgentSend}
          onAgentSteer={handleAgentSteer}
          onAgentStop={handleAgentStop}
          onAgentCompact={handleAgentCompact}
          onLoadOlderHistory={() => {
            const threadId = activeThreadIdRef.current;
            if (threadId) void loadOlderThreadHistory(threadId, activeMainChatTabKeyRef.current);
          }}
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
  );
}

function TitleBar(): React.JSX.Element {
  const isVerificationInstance = window.api.runtime.instanceRole === 'verification';

  return (
    <header className={`titlebar ${isVerificationInstance ? 'is-verification' : ''}`}>
      <div className="titlebar-title">
        {isVerificationInstance ? 'Chat — Verification Instance' : 'Chat'}
      </div>
      <div className="window-controls">
        <button
          type="button"
          aria-label="Minimize"
          onClick={() => void window.api.window.minimize()}
        >
          -
        </button>
        <button
          type="button"
          aria-label="Maximize"
          onClick={() => void window.api.window.toggleMaximize()}
        >
          □
        </button>
        <button type="button" aria-label="Close" onClick={() => void window.api.window.close()}>
          ×
        </button>
      </div>
    </header>
  );
}

function MainChatTabStrip({
  tabs,
  activeKey,
  disabled,
  onSelect,
  onReorder,
  onClose,
  onNew,
  onOpenSettings,
  title,
  threads,
  activeThreadId,
  isThreadMenuOpen,
  threadsNextCursor,
  threadsLoading,
  threadsError,
  onToggleThreadMenu,
  onResumeThread,
  onLoadMoreThreads,
}: {
  tabs: MainChatTab[];
  activeKey: string;
  disabled: boolean;
  onSelect: (key: string) => Promise<boolean>;
  onReorder: (sourceKey: string, targetKey: string, placement: 'before' | 'after') => void;
  onClose: (key: string) => Promise<void>;
  onNew: () => void;
  onOpenSettings: () => void;
  title: string;
  threads: Thread[];
  activeThreadId: string | null;
  isThreadMenuOpen: boolean;
  threadsNextCursor: string | null;
  threadsLoading: boolean;
  threadsError: string | null;
  onToggleThreadMenu: () => void;
  onResumeThread: (threadId: string) => Promise<void>;
  onLoadMoreThreads: () => Promise<void>;
}): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    sourceKey: string;
    startX: number;
    startY: number;
    pointerOffsetX: number;
    pointerOffsetY: number;
    sourceLeft: number;
    width: number;
    hasMoved: boolean;
    targetKey: string | null;
    placement: 'before' | 'after';
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState<{
    sourceKey: string;
    targetKey: string | null;
    placement: 'before' | 'after';
    previewLeft: number;
    previewTop: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>(
      `[data-main-chat-tab="${activeKey}"]`,
    );
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey, tabs.length]);

  const moveFocus = async (
    fromKey: string,
    direction: -1 | 1 | 'first' | 'last',
  ): Promise<void> => {
    const index = tabs.findIndex((tab) => tab.key === fromKey);
    const nextIndex =
      direction === 'first'
        ? 0
        : direction === 'last'
          ? tabs.length - 1
          : (index + direction + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    if (!(await onSelect(next.key))) return;
    requestAnimationFrame(() => {
      stripRef.current
        ?.querySelector<HTMLButtonElement>(`[data-main-chat-tab="${next.key}"]`)
        ?.focus();
    });
  };

  const beginTabDrag = (event: PointerEvent<HTMLButtonElement>, sourceKey: string): void => {
    if (disabled || event.button !== 0) return;
    const tab = event.currentTarget.closest<HTMLElement>('[data-main-chat-tab-key]');
    const rect = tab?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      sourceKey,
      startX: event.clientX,
      startY: event.clientY,
      pointerOffsetX: event.clientX - rect.left,
      pointerOffsetY: event.clientY - rect.top,
      sourceLeft: rect.left,
      width: rect.width,
      hasMoved: false,
      targetKey: null,
      placement: 'before',
    };
  };

  const updateTabDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.hasMoved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6)
      return;
    drag.hasMoved = true;

    const tabStripBounds = stripRef.current?.getBoundingClientRect();
    const minPreviewLeft = tabStripBounds?.left ?? 0;
    const maxPreviewLeft = Math.max(
      minPreviewLeft,
      (tabStripBounds?.right ?? window.innerWidth) - drag.width,
    );
    const previewLeft = Math.min(
      Math.max(event.clientX - drag.pointerOffsetX, minPreviewLeft),
      maxPreviewLeft,
    );
    const previewTop = Math.min(
      Math.max(event.clientY - drag.pointerOffsetY, 0),
      window.innerHeight - 40,
    );
    const dropTarget = findMainChatTabDropTarget(
      drag.sourceKey,
      drag.sourceLeft,
      previewLeft,
      drag.width,
      Array.from(
        stripRef.current?.querySelectorAll<HTMLElement>('[data-main-chat-tab-key]') ?? [],
      ).flatMap((tab) => {
        const key = tab.dataset.mainChatTabKey;
        if (!key) return [];
        const rect = tab.getBoundingClientRect();
        return [{ key, left: rect.left, right: rect.right }];
      }),
    );

    drag.targetKey = dropTarget?.key ?? null;
    drag.placement = dropTarget?.placement ?? 'before';
    setDragging({
      sourceKey: drag.sourceKey,
      targetKey: drag.targetKey,
      placement: drag.placement,
      previewLeft,
      previewTop,
      width: drag.width,
    });
  };

  const finishTabDrag = (event: PointerEvent<HTMLButtonElement>, shouldReorder: boolean): void => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (drag.hasMoved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (shouldReorder && drag.targetKey) {
        onReorder(drag.sourceKey, drag.targetKey, drag.placement);
      }
    }

    dragStateRef.current = null;
    setDragging(null);
  };

  const draggingTab = dragging
    ? (tabs.find((tab) => tab.key === dragging.sourceKey) ?? null)
    : null;

  return (
    <header className="main-chat-tabbar">
      <div ref={stripRef} className="main-chat-tabs-scroll" role="tablist" aria-label="Open chats">
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          const isDragging = dragging?.sourceKey === tab.key;
          const isDropTarget = dragging?.targetKey === tab.key;
          return (
            <div
              key={tab.key}
              data-main-chat-tab-key={tab.key}
              className={`main-chat-tab ${active ? 'is-active' : ''} is-${tab.status} ${
                isDragging ? 'is-dragging' : ''
              } ${isDropTarget ? `is-drop-${dragging?.placement}` : ''}`}
            >
              <button
                type="button"
                role="tab"
                className="main-chat-tab-target"
                data-main-chat-tab={tab.key}
                id={`main-chat-tab-${tab.key}`}
                aria-selected={active}
                aria-controls="main-chat-panel"
                tabIndex={active ? 0 : -1}
                disabled={disabled}
                title={tab.title}
                onClick={(event) => {
                  if (suppressClickRef.current) {
                    event.preventDefault();
                    suppressClickRef.current = false;
                    return;
                  }
                  void onSelect(tab.key);
                }}
                onPointerDown={(event) => beginTabDrag(event, tab.key)}
                onPointerMove={updateTabDrag}
                onPointerUp={(event) => finishTabDrag(event, true)}
                onPointerCancel={(event) => finishTabDrag(event, false)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    void moveFocus(tab.key, event.key === 'ArrowLeft' ? -1 : 1);
                  } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    void moveFocus(tab.key, event.key === 'Home' ? 'first' : 'last');
                  }
                }}
              >
                <MainChatGlyph />
                <span className="main-chat-tab-title">{tab.title}</span>
                {tab.status === 'working' ? (
                  <span className="main-chat-tab-spinner" aria-label="Running" />
                ) : tab.status === 'attention' ? (
                  <span className="main-chat-tab-attention" aria-label="Awaiting your attention" />
                ) : null}
              </button>
              <button
                type="button"
                className="main-chat-tab-close"
                aria-label={
                  tab.status === 'working' ? `${tab.title} is running` : `Close ${tab.title}`
                }
                title={
                  tab.status === 'working'
                    ? 'Stop this chat before closing it'
                    : 'Close chat (Ctrl+W)'
                }
                disabled={disabled || tab.status === 'working'}
                onClick={() => void onClose(tab.key)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          );
        })}
      </div>
      {dragging && draggingTab ? (
        <div
          className={`main-chat-tab-drag-preview ${draggingTab.key === activeKey ? 'is-active' : ''} is-${draggingTab.status}`}
          style={{ left: dragging.previewLeft, top: dragging.previewTop, width: dragging.width }}
          aria-hidden="true"
        >
          <MainChatGlyph />
          <span className="main-chat-tab-title">{draggingTab.title}</span>
          {draggingTab.status === 'working' ? (
            <span className="main-chat-tab-spinner" />
          ) : draggingTab.status === 'attention' ? (
            <span className="main-chat-tab-attention" />
          ) : null}
          <span className="main-chat-tab-drag-preview-close">×</span>
        </div>
      ) : null}
      <button
        type="button"
        className="main-chat-tab-action main-chat-tab-new"
        aria-label={tabs.length >= maxMainChatTabs ? 'Chat tab limit reached' : 'New chat tab'}
        title={
          tabs.length >= maxMainChatTabs
            ? `Up to ${maxMainChatTabs} chats can stay open`
            : 'New chat tab (Ctrl+T)'
        }
        disabled={disabled || tabs.length >= maxMainChatTabs}
        onClick={onNew}
      >
        <span aria-hidden="true">+</span>
      </button>
      <div className="main-chat-tabbar-spacer" />
      <ThreadMenu
        placement="tabbar"
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
        className="main-chat-tab-action"
        aria-label="Open settings"
        title="Settings"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
      </button>
    </header>
  );
}

function MainChatGlyph(): React.JSX.Element {
  return (
    <svg className="main-chat-tab-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4.75A1.75 1.75 0 0 1 5.75 3h4.5A1.75 1.75 0 0 1 12 4.75v3.5A1.75 1.75 0 0 1 10.25 10H7l-2.4 2v-2.15A1.75 1.75 0 0 1 4 8.5V4.75Z" />
    </svg>
  );
}

function VerticalDotsIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="5" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="19" r="1.5" fill="currentColor" />
    </svg>
  );
}

function ChatPane({
  turnCheckpoints,
  onRevertTurn,
  turnReviews,
  undoneFiles,
  alwaysKeepAll,
  onKeepTurn,
  onSetAlwaysKeepAll,
  onUndoTurnAll,
  onUndoFile,
  agentSessionStore,
  mainChatTabs,
  activeMainChatTabKey,
  mainChatTabsDisabled,
  onSelectMainChatTab,
  onReorderMainChatTabs,
  onCloseMainChatTab,
  onNewMainChatTab,
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
  fastMode,
  onSelectModel,
  onSelectModelEffort,
  onSetFastMode,
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
  onToggleAuditAgent,
  onToggleReportAgent,
  onSendAuditFeedback,
  onDecideAgentSendPolicy,
  onSetAgentModel,
  onSetAgentModelEffort,
  onNewAgent,
  onPromoteAgent,
  onCloseAgentSession,
  onResetAgentSession,
  onAgentSend,
  onAgentSteer,
  onAgentStop,
  onAgentCompact,
  onLoadOlderHistory,
}: {
  turnCheckpoints: Record<string, string>;
  onRevertTurn: (turnId: string) => void;
  turnReviews: Record<string, 'kept' | 'undone'>;
  undoneFiles: Record<string, string[]>;
  alwaysKeepAll: boolean;
  onKeepTurn: (turnId: string) => void;
  onSetAlwaysKeepAll: (enabled: boolean) => void;
  onUndoTurnAll: (turnId: string) => Promise<void>;
  onUndoFile: (turnId: string, path: string) => Promise<void>;
  agentSessionStore: SessionStore;
  mainChatTabs: MainChatTab[];
  activeMainChatTabKey: string;
  mainChatTabsDisabled: boolean;
  onSelectMainChatTab: (key: string) => Promise<boolean>;
  onReorderMainChatTabs: (
    sourceKey: string,
    targetKey: string,
    placement: 'before' | 'after',
  ) => void;
  onCloseMainChatTab: (key: string) => Promise<void>;
  onNewMainChatTab: () => void;
  items: ChatItem[];
  itemMeta: Record<string, ItemMeta>;
  turnMeta: Record<string, TurnMeta>;
  title: string;
  status: string;
  isRestoring: boolean;
  threads: Thread[];
  activeThreadId: string | null;
  activeTurnId: string | null;
  activeGoal: ThreadGoal | null;
  isGoalUpdating: boolean;
  isThreadMenuOpen: boolean;
  threadsNextCursor: string | null;
  threadsLoading: boolean;
  threadsError: string | null;
  hasThreadContent: boolean;
  isBusy: boolean;
  workspace: string | null;
  models: Model[];
  selectedModel: string | null;
  selectedReasoningEffort: ReasoningEffort | null;
  fastMode: boolean;
  onSelectModel: (model: string) => void;
  onSelectModelEffort: (model: string, effort: ReasoningEffort) => void;
  onSetFastMode: (enabled: boolean) => void;
  onSend: (text: string, attachments?: ChatAttachment[]) => Promise<boolean>;
  onSteer: (text: string) => Promise<boolean>;
  onStop: () => Promise<void>;
  onNewThread: () => void;
  onToggleThreadMenu: () => void;
  onResumeThread: (threadId: string) => Promise<void>;
  onLoadMoreThreads: () => Promise<void>;
  onPickWorkspace: () => Promise<void>;
  onSaveGoal: (objective: string, tokenBudget: number | null) => Promise<boolean>;
  onSetGoalStatus: (status: Extract<ThreadGoalStatus, 'active' | 'paused'>) => Promise<void>;
  onClearGoal: () => Promise<void>;
  contextUsage: ThreadTokenUsage | null;
  isCompacting: boolean;
  onCompactThread: () => Promise<void>;
  agentSessions: AgentSession[];
  openAgentKeys: string[];
  selectedAgentKey: string | null;
  onSelectAgent: (key: string) => void;
  onOpenAgent: (key: string) => void;
  onMinimizeAgent: (key: string) => void;
  onToggleWatchAgent: (key: string) => void;
  onToggleAuditAgent: (key: string) => void;
  onToggleReportAgent: (key: string) => void;
  onSendAuditFeedback: (key: string) => void;
  onDecideAgentSendPolicy: (key: string, policy: 'always' | 'keep') => void;
  onSetAgentModel: (key: string, model: string) => void;
  onSetAgentModelEffort: (key: string, model: string, effort: ReasoningEffort) => void;
  onNewAgent: (mainChatTabKey: string) => void;
  onPromoteAgent: (key: string) => void;
  onCloseAgentSession: (key: string) => void;
  onResetAgentSession: (key: string) => void;
  onAgentSend: (key: string, text: string, attachments?: ChatAttachment[]) => Promise<boolean>;
  onAgentSteer: (key: string, text: string) => Promise<boolean>;
  onAgentStop: (key: string) => Promise<void>;
  onAgentCompact: (key: string) => Promise<void>;
  onLoadOlderHistory: () => void;
}): React.JSX.Element {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPluginBrowserOpen, setIsPluginBrowserOpen] = useState(false);
  const [installedPlugins, setInstalledPlugins] = useState<PluginSummary[]>([]);
  // Which region the user is working in: the main chat (default) or the agent
  // column. Drives the dim/unfocus treatment on agent windows via CSS.
  const [isMainFocused, setIsMainFocused] = useState(true);
  const [traceTurnId, setTraceTurnId] = useState<string | null>(null);
  const [storedTrace, setStoredTrace] = useState<TurnTrace | null>(null);
  const traceLoadGenerationRef = useRef(0);
  const { rows, turnWork } = useMemo(
    () => buildRows(items, itemMeta, activeTurnId),
    [items, itemMeta, activeTurnId],
  );

  // Review target: the newest settled turn that edited files, still
  // unreviewed and revertible. Scanning stops at the newest edit-turn — once
  // it is kept/undone the bar goes away instead of resurfacing older turns.
  const reviewTarget = useMemo((): { turnId: string; changes: ReviewChange[] } | null => {
    if (activeTurnId) return null;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.kind !== 'tail') continue;
      const changes = (turnWork.get(row.turnId) ?? [])
        .filter(
          (item): item is Extract<WorkItem, { type: 'fileChange' }> => item.type === 'fileChange',
        )
        .flatMap((item) => item.changes);
      if (!changes.length) continue;
      if (turnReviews[row.turnId] || !turnCheckpoints[row.turnId]) return null;
      return { turnId: row.turnId, changes };
    }
    return null;
  }, [rows, turnWork, activeTurnId, turnReviews, turnCheckpoints]);

  // Context for per-file Undo on diff cards. Identity is stable across
  // streaming renders (deps change on turn boundaries and review actions
  // only), so memoized cards are not re-rendered per delta.
  const fileReview = useMemo(
    (): FileReviewActions => ({
      canUndo: (turnId) =>
        Boolean(
          turnId &&
            turnId !== activeTurnId &&
            turnCheckpoints[turnId] &&
            turnReviews[turnId] !== 'undone',
        ),
      isUndone: (turnId, path) =>
        Boolean(
          turnId && (turnReviews[turnId] === 'undone' || undoneFiles[turnId]?.includes(path)),
        ),
      undoFile: (turnId, path) => void onUndoFile(turnId, path),
    }),
    [activeTurnId, turnCheckpoints, turnReviews, undoneFiles, onUndoFile],
  );

  // Live glance at the in-flight turn for auditor dock cards ("watching" POV).
  // Cheap passes over state this pane already re-renders on.
  const liveMainTurn = useMemo(
    () => (activeTurnId ? liveTurnGlance(items, itemMeta, activeTurnId) : null),
    [items, itemMeta, activeTurnId],
  );
  const currentTrace = useMemo(
    () =>
      traceTurnId
        ? buildTurnTrace({
            threadId: activeThreadId,
            threadTitle: title,
            turnId: traceTurnId,
            model: selectedModel,
            workspace,
            items,
            itemMeta,
            meta: turnMeta[traceTurnId],
          })
        : null,
    [traceTurnId, activeThreadId, title, selectedModel, workspace, items, itemMeta, turnMeta],
  );
  const trace = storedTrace?.turn.id === traceTurnId ? storedTrace : currentTrace;

  function openTrace(turnId: string): void {
    const generation = ++traceLoadGenerationRef.current;
    setTraceTurnId(turnId);
    setStoredTrace(null);

    if (!activeThreadId || turnMeta[turnId]?.origin !== 'restored') return;

    void window.api.trace.load({ threadId: activeThreadId, turnId }).then(
      (content) => {
        if (generation !== traceLoadGenerationRef.current || !content) return;

        try {
          const parsed: unknown = JSON.parse(content);
          if (isTurnTrace(parsed) && parsed.turn.id === turnId) setStoredTrace(parsed);
        } catch (error) {
          console.warn('Failed to load persisted turn trace', error);
        }
      },
      (error) => {
        console.warn('Failed to load persisted turn trace', error);
      },
    );
  }

  useEffect(() => {
    traceLoadGenerationRef.current += 1;
    setTraceTurnId(null);
    setStoredTrace(null);
  }, [activeThreadId]);

  // True while the live turn's newest item is an assistant message still
  // receiving deltas — drives the "Writing" tail label and message caret.
  const streamingMessageId = useMemo(() => {
    if (!activeTurnId) {
      return null;
    }
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.type === 'system' || itemMeta[item.id]?.turnId !== activeTurnId) {
        continue;
      }
      if (
        item.type === 'agentMessage' &&
        item.phase !== 'commentary' &&
        !itemMeta[item.id]?.completedAtMs
      ) {
        return item.id;
      }
    }
    return null;
  }, [items, itemMeta, activeTurnId]);

  const activeAgentSessions = agentSessionsForMainChatTab(agentSessions, activeMainChatTabKey);
  const openAgentSessions = activeAgentSessions.filter((session) => openAgentKeys.includes(session.key));
  const selectedActiveAgentKey = openAgentSessions.some((session) => session.key === selectedAgentKey)
    ? selectedAgentKey
    : openAgentSessions[0]?.key ?? null;

  const openPluginBrowser = (): void => {
    setIsSettingsOpen(false);
    setIsPluginBrowserOpen(true);
  };

  const closePluginBrowser = (): void => {
    setIsPluginBrowserOpen(false);
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),
    );
  };

  // Pointer-downs and focus moves decide the active region: anything inside
  // the agent column or tab strip counts as agent territory, everything else
  // is the main chat.
  const updateFocusRegion = (target: EventTarget | null): void => {
    const inAgents =
      target instanceof HTMLElement && Boolean(target.closest('.agent-column-shell, .agent-tabs'));
    setIsMainFocused(!inAgents);
  };

  const focusAgent = (key: string): void => {
    const wasOpen = openAgentKeys.includes(key);
    onSelectAgent(key);
    onOpenAgent(key);
    // Alignment is an absolute, idempotent scrollTo — never a relative
    // scrollBy, which compounds when fired mid-animation. Settle runs on the
    // browser's scrollend event, not a guessed timeout, so it measures a
    // finished layout. A freshly opened window aligns instantly (the column is
    // reflowing anyway); an already-open one scrolls smoothly.
    const alignOnce = (behavior: ScrollBehavior): 'missing' | 'aligned' | 'scrolling' => {
      const node = document.querySelector(`[data-agent-key="${key}"]`);
      const scroller = node instanceof HTMLElement ? node.parentElement : null;
      if (!(node instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return 'missing';
      const raw =
        scroller.scrollTop +
        node.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
      const target = Math.max(0, Math.min(raw, scroller.scrollHeight - scroller.clientHeight));
      if (Math.abs(target - scroller.scrollTop) <= 4) return 'aligned';
      scroller.scrollTo({ top: target, behavior });
      return 'scrolling';
    };
    let attempts = 0;
    const run = (): void => {
      const state = alignOnce(wasOpen ? 'smooth' : 'auto');
      if (state === 'missing') {
        if (attempts++ < 12) requestAnimationFrame(run);
        return;
      }
      const node = document.querySelector(`[data-agent-key="${key}"]`);
      if (node instanceof HTMLElement) {
        node.classList.add('is-flash');
        window.setTimeout(() => node.classList.remove('is-flash'), 750);
      }
      if (state === 'scrolling') {
        const scroller = node instanceof HTMLElement ? node.parentElement : null;
        if (scroller instanceof HTMLElement) {
          const settle = (): void => {
            alignOnce('auto');
          };
          scroller.addEventListener('scrollend', settle, { once: true });
          // Fallback in case scrollend never fires; alignOnce is idempotent,
          // so a double settle is a no-op.
          window.setTimeout(() => {
            scroller.removeEventListener('scrollend', settle);
            alignOnce('auto');
          }, 900);
        }
      }
    };
    requestAnimationFrame(run);
  };

  return (
    <section
      id="main-chat-pane"
      className={`chat-pane ${isPluginBrowserOpen ? 'is-plugin-browser' : hasThreadContent ? 'is-thread' : 'is-empty'} ${isRestoring ? 'is-hydrating' : ''} ${
        !isPluginBrowserOpen && openAgentSessions.length ? 'has-agents' : ''
      } ${isMainFocused ? 'is-main-focused' : ''}`}
      aria-busy={isRestoring}
      onPointerDownCapture={(event) => updateFocusRegion(event.target)}
      onFocusCapture={(event) => updateFocusRegion(event.target)}
    >
      {isPluginBrowserOpen ? (
        <PluginBrowserView
          workspace={workspace}
          onClose={closePluginBrowser}
          onChanged={setInstalledPlugins}
        />
      ) : null}
      <div className={`chat-pane-content ${isPluginBrowserOpen ? 'is-hidden' : ''}`}>
        <MainChatTabStrip
          tabs={mainChatTabs}
          activeKey={activeMainChatTabKey}
          disabled={mainChatTabsDisabled}
          onSelect={onSelectMainChatTab}
          onReorder={onReorderMainChatTabs}
          onClose={onCloseMainChatTab}
          onNew={onNewMainChatTab}
          onOpenSettings={() => setIsSettingsOpen(true)}
          title={title}
          threads={threads}
          activeThreadId={activeThreadId}
          isThreadMenuOpen={isThreadMenuOpen}
          threadsNextCursor={threadsNextCursor}
          threadsLoading={threadsLoading}
          threadsError={threadsError}
          onToggleThreadMenu={onToggleThreadMenu}
          onResumeThread={onResumeThread}
          onLoadMoreThreads={onLoadMoreThreads}
        />

        <FileReviewContext.Provider value={fileReview}>
        <ThreadScroll
          id="main-chat-panel"
          labelledBy={`main-chat-tab-${activeMainChatTabKey}`}
          scrollKey={activeMainChatTabKey}
          resetKey={activeThreadId}
          activeTurnId={activeTurnId}
          dependencies={[items, itemMeta, activeTurnId]}
          onReachStart={onLoadOlderHistory}
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
              );
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
                  onRevert={
                    turnCheckpoints[row.turnId] ? () => onRevertTurn(row.turnId) : undefined
                  }
                />
              );
            }
            return (
              <ChatItemView
                key={row.item.id}
                item={row.item}
                meta={itemMeta[row.item.id]}
                turnId={row.turnId}
                streaming={row.item.id === streamingMessageId}
              />
            );
          })}
        </ThreadScroll>
        </FileReviewContext.Provider>

        <div
          className={`composer-dock ${hasThreadContent ? 'is-docked' : 'is-centered'} ${
            openAgentSessions.length ? 'has-agents' : ''
          }`}
        >
          {reviewTarget ? (
            <ReviewBar
              changes={reviewTarget.changes}
              workspace={workspace}
              undonePaths={new Set(undoneFiles[reviewTarget.turnId] ?? [])}
              alwaysKeepAll={alwaysKeepAll}
              onKeepAll={() => onKeepTurn(reviewTarget.turnId)}
              onSetAlwaysKeepAll={onSetAlwaysKeepAll}
              onUndoAll={() => void onUndoTurnAll(reviewTarget.turnId)}
              onUndoFile={(path) => void onUndoFile(reviewTarget.turnId, path)}
            />
          ) : null}
          {openAgentSessions.length ? (
            <AgentColumn
              sessions={openAgentSessions}
              sessionStore={agentSessionStore}
              workspace={workspace}
              selectedKey={selectedActiveAgentKey}
              models={models}
              mainModel={selectedModel}
              mainReasoningEffort={selectedReasoningEffort}
              liveMainTurn={liveMainTurn}
              isMainFocused={isMainFocused}
              onSetModel={onSetAgentModel}
              onSetModelEffort={onSetAgentModelEffort}
              onSelect={onSelectAgent}
              onMinimize={onMinimizeAgent}
              onCloseSession={onCloseAgentSession}
              onResetSession={onResetAgentSession}
              onPromote={onPromoteAgent}
              onToggleWatch={onToggleWatchAgent}
              onToggleAudit={onToggleAuditAgent}
              onToggleReport={onToggleReportAgent}
              onSendFeedback={onSendAuditFeedback}
              onDecideSendPolicy={onDecideAgentSendPolicy}
              onSend={onAgentSend}
              onSteer={onAgentSteer}
              onStop={onAgentStop}
              onCompact={onAgentCompact}
            />
          ) : null}
          <div className="composer-context">
            <WorkspacePill workspace={workspace} onPickWorkspace={onPickWorkspace} />
            {models.length ? (
              <ModelPill
                models={models}
                selectedModel={selectedModel}
                selectedEffort={selectedReasoningEffort}
                onSelectModel={onSelectModel}
                onSelectModelEffort={onSelectModelEffort}
                fastMode={fastMode}
                onToggleFastMode={onSetFastMode}
              />
            ) : null}
            <AgentTabStrip sessions={activeAgentSessions} openKeys={openAgentKeys} onFocus={focusAgent} />
            {/* Always available: a reviewer armed while idle audits the very
                next turn — the born-a-reviewer default is most useful BEFORE
                the work starts, not only mid-turn. */}
            <button
              type="button"
              className="composer-new-agent-button"
              aria-label="Open a new reviewer agent"
              title="New agent — born a reviewer"
              onClick={() => onNewAgent(activeMainChatTabKey)}
            >
              <NewAgentIcon />
            </button>
          </div>
          <Composer
            key={activeMainChatTabKey}
            draftKey={activeMainChatTabKey}
            docked={hasThreadContent}
            workspace={workspace}
            installedPlugins={installedPlugins}
            onInstalledPluginsChange={setInstalledPlugins}
            onBrowsePlugins={openPluginBrowser}
            isLoading={isRestoring || (isBusy && !activeTurnId)}
            isTurnActive={Boolean(activeTurnId)}
            status={isRestoring ? 'Restoring conversation' : activeTurnId ? 'Working' : status}
            onSend={onSend}
            onSteer={onSteer}
            onStop={onStop}
            onNewThread={onNewThread}
            onNewAgent={() => onNewAgent(activeMainChatTabKey)}
            footerTrailing={
              <ContextPill
                usage={contextUsage}
                disabled={Boolean(activeTurnId) || mainChatTabsDisabled}
                compacting={isCompacting}
                onCompact={onCompactThread}
              />
            }
          />
        </div>

        {isSettingsOpen ? (
          <SettingsModal
            goal={activeGoal}
            isGoalUpdating={Boolean(activeTurnId) || isGoalUpdating || mainChatTabsDisabled}
            onSaveGoal={onSaveGoal}
            onSetGoalStatus={onSetGoalStatus}
            onClearGoal={onClearGoal}
            onOpenPlugins={openPluginBrowser}
            onClose={() => setIsSettingsOpen(false)}
          />
        ) : null}
        {trace ? (
          <TraceModal
            trace={trace}
            onClose={() => {
              traceLoadGenerationRef.current += 1;
              setTraceTurnId(null);
              setStoredTrace(null);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

// Work items that stay visible when a settled turn's steps are collapsed:
// edits are the product, the plan is the status board — everything else is
// process and folds away Cursor-style.
function isEssentialWorkItem(item: WorkItem): boolean {
  return item.type === 'fileChange' || item.type === 'turnPlan';
}

function TaskActivityCard({
  items,
  itemMeta,
  live,
  workspace,
}: {
  items: ActivityItem[];
  itemMeta: Record<string, ItemMeta>;
  live: boolean;
  workspace: string | null;
}): React.JSX.Element {
  // null = default by liveness: live turns show everything, settled turns
  // collapse their step rows to a "N steps" toggle.
  const [stepsOpen, setStepsOpen] = useState<boolean | null>(null);
  const showSteps = live || (stepsOpen ?? false);
  const hiddenStepCount = live
    ? 0
    : items.filter((item) => isWorkItem(item) && !isEssentialWorkItem(item)).length;

  let newestWorkItemId: string | undefined;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (isWorkItem(items[i])) {
      newestWorkItemId = items[i].id;
      break;
    }
  }
  const newestActivityId = items[items.length - 1]?.id;
  const content: React.JSX.Element[] = [];
  let workRun: WorkItem[] = [];

  const flushWork = (): void => {
    const visible = showSteps ? workRun : workRun.filter(isEssentialWorkItem);
    workRun = [];
    if (!visible.length) {
      return;
    }
    const first = visible[0];
    content.push(
      <WorkGroup
        key={`work-${first.id}`}
        items={visible}
        itemMeta={itemMeta}
        live={live}
        workspace={workspace}
        newestItemId={newestWorkItemId}
      />,
    );
  };

  for (const item of items) {
    if (isWorkItem(item)) {
      workRun.push(item);
      continue;
    }

    flushWork();
    const messageStreaming =
      live && item.id === newestActivityId && !itemMeta[item.id]?.completedAtMs;
    content.push(
      <div
        className={`task-activity-message ${messageStreaming ? 'is-streaming' : ''}`}
        key={item.id}
      >
        {messageStreaming ? (
          <StreamingMarkdownContent text={item.text || ' '} />
        ) : (
          <MarkdownContent text={item.text || ' '} />
        )}
      </div>,
    );
  }
  flushWork();

  return (
    <section
      className={`task-activity-card ${live ? 'is-live' : ''}`}
      aria-label="In-task activity"
      aria-live={live ? 'polite' : 'off'}
    >
      {hiddenStepCount > 0 ? (
        <button
          type="button"
          className="activity-steps-toggle"
          aria-expanded={showSteps}
          onClick={() => setStepsOpen(!showSteps)}
        >
          <StepsChevronIcon className={`activity-steps-chevron ${showSteps ? 'is-open' : ''}`} />
          {hiddenStepCount} {hiddenStepCount === 1 ? 'step' : 'steps'}
        </button>
      ) : null}
      <AutoFollow className="task-activity-card-scroll">
        <div className="task-activity-card-content">{content}</div>
      </AutoFollow>
    </section>
  );
}

function StepsChevronIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m8.5 6 6 6-6 6" />
    </svg>
  );
}

// The thread selector opens a searchable recent-thread popover. The tab-bar
// trigger opens below the header; the legacy toolbar/composer placements retain
// their respective centered and upward menu geometry.
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
  onLoadMoreThreads,
}: {
  placement?: 'toolbar' | 'composer' | 'tabbar';
  title: string;
  threads: Thread[];
  activeThreadId: string | null;
  isOpen: boolean;
  threadsNextCursor: string | null;
  threadsLoading: boolean;
  threadsError: string | null;
  onToggle: () => void;
  onResumeThread: (threadId: string) => Promise<void>;
  onLoadMoreThreads: () => Promise<void>;
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  // Highlighted row for keyboard/hover navigation. `null` is the resting state;
  // `0..n` indexes the flat, filtered thread list.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Filter by title/preview, then bucket into recency groups. `nowSeconds` is
  // sampled once per open so relative labels ("2h", "Yesterday") stay stable.
  const { groups, flatIds } = useMemo(() => groupThreadsForMenu(threads, query), [threads, query]);

  // Reset transient state whenever the menu opens; focus the search field so the
  // user can immediately type to filter (Cursor-style).
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setQuery('');
    setActiveIndex(null);
    const id = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        onToggle();
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
    };
  }, [isOpen, onToggle]);

  const resume = (threadId: string): void => {
    onToggle();
    void onResumeThread(threadId);
  };

  const handleKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onToggle();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => {
        if (!flatIds.length) return null;
        return index === null ? 0 : Math.min(index + 1, flatIds.length - 1);
      });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => {
        if (!flatIds.length) return null;
        return index === null ? flatIds.length - 1 : Math.max(index - 1, 0);
      });
      return;
    }
    if (event.key === 'Enter') {
      // With nothing highlighted, let Enter fall through (no-op here).
      if (activeIndex === null) {
        return;
      }
      event.preventDefault();
      if (flatIds[activeIndex]) {
        resume(flatIds[activeIndex]);
      }
    }
  };

  return (
    <div ref={wrapRef} className={`thread-select-wrap is-${placement}`}>
      <button
        type="button"
        className={`thread-select ${isOpen ? 'is-open' : ''}`}
        aria-label={
          placement === 'tabbar'
            ? 'Open conversation history'
            : placement === 'composer'
              ? 'Chat history'
              : 'Open thread menu'
        }
        title={
          placement === 'tabbar'
            ? 'Conversation history'
            : placement === 'composer'
              ? 'Chat history'
              : undefined
        }
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        {placement === 'tabbar' ? (
          <VerticalDotsIcon />
        ) : placement === 'composer' ? (
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
                setQuery(event.target.value);
                setActiveIndex(null);
              }}
            />
          </div>

          <div className="thread-menu-scroll">
            {flatIds.length ? (
              groups.map((group) => (
                <div className="thread-menu-group" key={group.label}>
                  <div className="thread-menu-label">{group.label}</div>
                  {group.threads.map((thread) => {
                    const index = flatIds.indexOf(thread.id);
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
                    );
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
  );
}

type ThreadGroup = { label: string; threads: Thread[] };

// Filters threads by the search query, sorts by recency, and buckets them into
// human recency bands (Today / Yesterday / Previous 7 days / Older). Returns the
// grouped view plus a flat id list in display order for keyboard navigation.
function groupThreadsForMenu(
  threads: Thread[],
  query: string,
): { groups: ThreadGroup[]; flatIds: string[] } {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? threads.filter((thread) => threadTitle(thread).toLowerCase().includes(needle))
    : threads;

  const sorted = [...matched].sort(
    (a, b) => (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt),
  );

  const now = Date.now();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  const todayStart = startOfToday.getTime();
  const yesterdayStart = todayStart - dayMs;
  const weekStart = todayStart - 7 * dayMs;

  const buckets: ThreadGroup[] = [
    { label: 'Today', threads: [] },
    { label: 'Yesterday', threads: [] },
    { label: 'Previous 7 days', threads: [] },
    { label: 'Older', threads: [] },
  ];

  for (const thread of sorted) {
    const ms = (thread.recencyAt ?? thread.updatedAt) * 1000;
    if (ms >= todayStart) {
      buckets[0].threads.push(thread);
    } else if (ms >= yesterdayStart) {
      buckets[1].threads.push(thread);
    } else if (ms >= weekStart) {
      buckets[2].threads.push(thread);
    } else {
      buckets[3].threads.push(thread);
    }
  }

  const groups = buckets.filter((bucket) => bucket.threads.length > 0);
  const flatIds = groups.flatMap((group) => group.threads.map((thread) => thread.id));
  return { groups, flatIds };
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
  );
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
  );
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg
      className="workspace-pill-icon"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2a1.5 1.5 0 0 1 1.06.44l1.06 1.06A1.5 1.5 0 0 0 11.88 7H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg
      className="icon-settings"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NewChatIcon(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function NewAgentIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="3.75"
        y="6.75"
        width="12.5"
        height="10.5"
        rx="2.25"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M7.5 11.5h5M10 9v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M17.5 4.5v5M15 7h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function SettingsModal({
  goal,
  isGoalUpdating,
  onSaveGoal,
  onSetGoalStatus,
  onClearGoal,
  onOpenPlugins,
  onClose,
}: {
  goal: ThreadGoal | null;
  isGoalUpdating: boolean;
  onSaveGoal: (objective: string, tokenBudget: number | null) => Promise<boolean>;
  onSetGoalStatus: (status: Extract<ThreadGoalStatus, 'active' | 'paused'>) => Promise<void>;
  onClearGoal: () => Promise<void>;
  onOpenPlugins: () => void;
  onClose: () => void;
}): React.JSX.Element {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // The browser is a native view above the DOM, so hide it while this modal is
  // open — otherwise it renders on top of the modal. Restored on unmount.
  useEffect(() => {
    void window.api.browser.setOverlayOpen(true);
    return () => {
      void window.api.browser.setOverlayOpen(false);
    };
  }, []);

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
          <button
            type="button"
            className="settings-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <section className="settings-section">
          <h3 className="settings-section-title">Thread goal</h3>
          <GoalSettings
            goal={goal}
            disabled={isGoalUpdating}
            onSave={onSaveGoal}
            onSetStatus={onSetGoalStatus}
            onClear={onClearGoal}
          />
        </section>
        <section className="settings-section">
          <h3 className="settings-section-title">Extensions</h3>
          <button type="button" className="settings-navigation-row" onClick={onOpenPlugins}>
            <span className="settings-row-text">
              <span className="settings-row-label">Plugin Settings</span>
              <span className="settings-row-hint">
                Browse, install, and remove plugins available through @ mentions.
              </span>
            </span>
            <span className="settings-navigation-arrow" aria-hidden="true">
              →
            </span>
          </button>
        </section>
      </div>
    </div>
  );
}

// Keeps the transcript pinned to the bottom as content streams in, but yields to
// the user the moment they scroll up to read back — re-pinning only when they
// return to the bottom themselves.
function ThreadScroll({
  children,
  dependencies,
  scrollKey,
  resetKey,
  activeTurnId,
  id,
  labelledBy,
  onReachStart,
}: {
  children: React.ReactNode;
  dependencies: unknown[];
  scrollKey: string;
  resetKey: string | null;
  activeTurnId: string | null;
  id: string;
  labelledBy: string;
  onReachStart?: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const settleFrameRef = useRef<number | null>(null);
  // The rAF scheduled on a live send to run anchorTop once the new user row has
  // committed. Tracked so the reset effect and unmount cleanup can cancel it
  // (like frameRef/settleFrameRef) — otherwise it can fire against a torn-down
  // or reset component.
  const anchorFrameRef = useRef<number | null>(null);
  // While non-null, this turn's user message is anchored to the top of the
  // viewport (the answer streams into the space below). This mode overrides
  // bottom-follow and releases the moment the reader scrolls.
  const anchorTurnRef = useRef<string | null>(null);
  const prevTurnRef = useRef<string | null>(null);
  // A fresh/restored thread may arrive with activeTurnId already set for an
  // in-progress turn; that must NOT yank it to the top — only a live send does.
  const justResetRef = useRef(false);
  // Programmatic scrollTop writes fire onScroll; without this guard the first
  // anchor write would immediately release the anchor (bottom-pin doesn't need
  // it because it re-pins to the same value).
  const suppressScrollRef = useRef(false);
  const scrollKeyRef = useRef(scrollKey);
  const scrollPositionsRef = useRef(new Map<string, { top: number; pinned: boolean }>());
  const [spacerOn, setSpacerOn] = useState(false);

  const rememberScrollPosition = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    scrollPositionsRef.current.set(scrollKeyRef.current, {
      top: el.scrollTop,
      pinned: pinnedRef.current,
    });
  }, []);

  const cancelScheduledFollow = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (settleFrameRef.current !== null) {
      window.cancelAnimationFrame(settleFrameRef.current);
      settleFrameRef.current = null;
    }
    if (anchorFrameRef.current !== null) {
      window.cancelAnimationFrame(anchorFrameRef.current);
      anchorFrameRef.current = null;
    }
  }, []);

  // Scroll the anchored turn's user message to the top of the viewport, sizing
  // a trailing spacer so there is always room to scroll it that far even before
  // the answer fills in.
  const anchorTop = useCallback(() => {
    const el = ref.current;
    const turnId = anchorTurnRef.current;
    if (!el || !turnId) return;

    const node = el.querySelector<HTMLElement>(
      `.message-user[data-turn-id="${CSS.escape(turnId)}"]`,
    );
    if (!node) return;

    // Small breathing room so the message sits just below the viewport top
    // rather than flush against (or clipped above) the edge.
    const topGap = 12;

    // Size the trailing spacer to the exact shortfall of room below the user
    // message, so it can reach the top without leaving more than one viewport
    // of slack. Measured from the DOM, immune to offsetParent/padding quirks.
    const spacer = spacerRef.current;
    if (spacer) {
      const priorSpacer = spacer.offsetHeight;
      const elRect = el.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const nodeTopWithin = nodeRect.top - elRect.top + el.scrollTop;
      const contentBelow = el.scrollHeight - priorSpacer - nodeTopWithin;
      const needed = Math.max(0, el.clientHeight - contentBelow - topGap);
      const nextHeight = `${needed}px`;
      if (spacer.style.height !== nextHeight) spacer.style.height = nextHeight;
    }

    // Scroll by the measured delta between the message top and the viewport top
    // (minus the gap), rather than computing an absolute offsetTop target.
    const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - topGap;
    if (Math.abs(delta) > 1) {
      suppressScrollRef.current = true;
      el.scrollTop += delta;
      rememberScrollPosition();
    }
  }, [rememberScrollPosition]);

  const followTail = useCallback(() => {
    // Top-anchor mode owns the scroll position while active.
    if (anchorTurnRef.current !== null) {
      anchorTop();
      return;
    }
    if (!pinnedRef.current || ref.current === null || frameRef.current !== null) {
      return;
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const el = ref.current;

      if (!el || !pinnedRef.current) {
        return;
      }

      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      if (Math.abs(el.scrollTop - target) > 1) {
        suppressScrollRef.current = true;
        el.scrollTop = target;
      }
      rememberScrollPosition();

      // Markdown code blocks, font metrics, and live diff rows can settle one
      // layout pass after React commits. A second frame catches that growth
      // without making every stream delta pay for a synchronous measurement.
      if (settleFrameRef.current === null) {
        settleFrameRef.current = window.requestAnimationFrame(() => {
          settleFrameRef.current = null;
          const settled = ref.current;
          if (settled && pinnedRef.current) {
            const settledTarget = Math.max(0, settled.scrollHeight - settled.clientHeight);
            if (Math.abs(settled.scrollTop - settledTarget) > 1) {
              suppressScrollRef.current = true;
              settled.scrollTop = settledTarget;
            }
            rememberScrollPosition();
          }
        });
      }
    });
  }, [anchorTop, rememberScrollPosition]);

  const handleScroll = useCallback(() => {
    // Ignore the scroll events our own programmatic writes produce.
    if (suppressScrollRef.current) {
      suppressScrollRef.current = false;
      return;
    }

    const el = ref.current;
    if (!el) {
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom <= 48;
    rememberScrollPosition();

    // A deliberate scroll releases the top-anchor, exactly like it releases
    // bottom-follow — the reader is now driving.
    if (anchorTurnRef.current !== null) {
      anchorTurnRef.current = null;
      setSpacerOn(false);
    }

    // A queued frame from a prior delta must never pull a reader back down
    // after they have deliberately scrolled away from the live edge.
    if (!pinnedRef.current) {
      cancelScheduledFollow();
    }
    if (el.scrollTop <= 96) onReachStart?.();
  }, [cancelScheduledFollow, onReachStart, rememberScrollPosition]);

  useLayoutEffect(() => {
    // A tab has its own reading context. Restore its last known position when
    // returning to it; a never-seen tab still begins at its latest content.
    cancelScheduledFollow();
    anchorTurnRef.current = null;
    prevTurnRef.current = null;
    justResetRef.current = true;
    setSpacerOn(false);
    scrollKeyRef.current = scrollKey;
    const saved = scrollPositionsRef.current.get(scrollKey);
    pinnedRef.current = saved?.pinned ?? true;
    if (!saved) {
      followTail();
      return;
    }
    const restore = (): void => {
      const el = ref.current;
      if (!el || scrollKeyRef.current !== scrollKey) return;
      const maximum = Math.max(0, el.scrollHeight - el.clientHeight);
      suppressScrollRef.current = true;
      el.scrollTop = Math.min(saved.top, maximum);
      rememberScrollPosition();
    };
    const frame = window.requestAnimationFrame(restore);
    return () => window.cancelAnimationFrame(frame);
  }, [cancelScheduledFollow, followTail, rememberScrollPosition, resetKey, scrollKey]);

  useLayoutEffect(() => {
    followTail();
    // The caller supplies render-driving state rather than a single scalar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  // A live send (activeTurnId transitions to a new non-null value) anchors that
  // turn's user message to the top. Skip the transition that coincides with a
  // thread switch/restore — that turn is being read, not just asked.
  useLayoutEffect(() => {
    if (activeTurnId !== null && activeTurnId !== prevTurnRef.current && !justResetRef.current) {
      anchorTurnRef.current = activeTurnId;
      pinnedRef.current = false;
      cancelScheduledFollow();
      setSpacerOn(true);
      // The new user row + spacer land next commit; anchor once they exist.
      // Tracked so reset/unmount can cancel it before it fires.
      anchorFrameRef.current = window.requestAnimationFrame(() => {
        anchorFrameRef.current = null;
        anchorTop();
      });
    } else if (activeTurnId === null && anchorTurnRef.current !== null) {
      // The turn finished. Stop actively re-anchoring, but FREEZE the current
      // scroll position so the message/answer don't snap back down. Removing the
      // spacer entirely would shrink scrollHeight below the current scrollTop and
      // the browser would clamp it (the snap). Instead, size the spacer to the
      // exact minimum that preserves scrollTop — 0 if the answer already fills
      // the viewport, otherwise just enough to hold position (no excess).
      anchorTurnRef.current = null;
      const el = ref.current;
      const spacer = spacerRef.current;
      if (el && spacer) {
        const priorSpacer = spacer.offsetHeight;
        const contentWithoutSpacer = el.scrollHeight - priorSpacer;
        const needed = Math.max(0, el.scrollTop + el.clientHeight - contentWithoutSpacer);
        if (needed <= 0) {
          setSpacerOn(false);
        } else {
          spacer.style.height = `${needed}px`;
        }
      } else {
        setSpacerOn(false);
      }
      // The reader is no longer following the live edge; leave bottom-follow off
      // until they scroll back down themselves.
      pinnedRef.current = false;
    }
    prevTurnRef.current = activeTurnId;
    justResetRef.current = false;
  }, [activeTurnId, anchorTop, cancelScheduledFollow]);

  useEffect(() => {
    const el = ref.current;
    const content = contentRef.current;

    if (!el || !content) {
      return;
    }

    let active = true;
    // The `dependencies` layout effect already calls followTail on every React
    // commit (i.e. every batched streaming flush), which covers text growth.
    // The ResizeObserver catches the reflows React does NOT drive — code-block
    // wrapping, diff rows, and font metrics settling a frame after commit. A
    // subtree characterData MutationObserver would fire on every streamed
    // character for no gain over these two, so it is intentionally omitted.
    const resizeObserver = new ResizeObserver(followTail);
    resizeObserver.observe(el);
    resizeObserver.observe(content);

    // Web fonts can reflow existing markdown after the initial commit without
    // producing a React update. Catch that one late layout pass when supported.
    void document.fonts?.ready.then(() => {
      if (active) {
        followTail();
      }
    });

    return () => {
      active = false;
      resizeObserver.disconnect();
      cancelScheduledFollow();
    };
  }, [cancelScheduledFollow, followTail]);

  return (
    <div
      ref={ref}
      id={id}
      role="tabpanel"
      aria-labelledby={labelledBy}
      className="thread-scroll"
      onScroll={handleScroll}
    >
      <div ref={contentRef} className="thread-scroll-content">
        {children}
        {spacerOn ? (
          <div ref={spacerRef} className="thread-scroll-anchor-spacer" aria-hidden="true" />
        ) : null}
      </div>
    </div>
  );
}

function stripAutomaticSkillMarker(text: string): string {
  return text.replace(/^\$artifact-first-web-research[ \t]*\r?\n/, '');
}

function stripInjectedMemory(text: string): string {
  return text.replace(
    /^<codexdesktop-prior-chat-memory>[\s\S]*?<\/codexdesktop-prior-chat-memory>\s*Current user request:\s*/,
    '',
  );
}

function completedMemoryTurns(
  items: ChatItem[],
  itemMeta: Record<string, ItemMeta>,
  turnMeta: Record<string, TurnMeta>,
): MemoryPersistParams['turns'] {
  const turns = new Map<string, { user: string; assistant: string; completedWork: string[] }>();

  for (const item of items) {
    if (item.type === 'system') continue;
    const turnId = itemMeta[item.id]?.turnId;
    if (!turnId || !isTerminalTurnStatus(turnMeta[turnId]?.status)) continue;

    const turn = turns.get(turnId) ?? { user: '', assistant: '', completedWork: [] };

    if (item.type === 'userMessage') {
      turn.user = item.content
        .filter((content) => content.type === 'text')
        .map((content) => stripMentionContext(stripAutomaticSkillMarker(stripInjectedMemory(content.text))))
        .join('\n')
        .trim();
    } else if (item.type === 'agentMessage' && item.phase !== 'commentary') {
      turn.assistant = item.text.trim();
    } else {
      const completedWork = completedWorkSummary(item);
      if (completedWork && !turn.completedWork.includes(completedWork)) {
        turn.completedWork.push(completedWork);
      }
    }

    turns.set(turnId, turn);
  }

  return [...turns.values()]
    .filter((turn) => turn.user && turn.assistant)
    .map((turn) => ({ ...turn, completedWork: selectCompletedWork(turn.completedWork) }));
}

function completedWorkSummary(item: ChatItem): string | null {
  if (item.type === 'commandExecution' && item.status !== 'inProgress') {
    const outcome =
      item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null)
        ? (commandTestOutcome(item.aggregatedOutput) ?? 'Command succeeded')
        : `Command ${item.status}${item.exitCode === null ? '' : ` with exit ${item.exitCode}`}`;
    return `${outcome}: ${singleLineClip(item.command, 150)}`;
  }

  if (item.type === 'fileChange' && item.status !== 'inProgress') {
    const paths = item.changes.map((change) => change.path).slice(0, 4);
    const omitted = item.changes.length - paths.length;
    return `File changes ${item.status}: ${paths.join(', ')}${omitted > 0 ? ` and ${omitted} more` : ''}`;
  }

  if (item.type === 'dynamicToolCall' && item.status !== 'inProgress') {
    return `Tool ${item.status}: ${item.tool}`;
  }

  if (item.type === 'mcpToolCall' && item.status !== 'inProgress') {
    return `Tool ${item.status}: ${item.server}/${item.tool}`;
  }

  return null;
}

function commandTestOutcome(output: string | null): string | null {
  if (!output) return null;
  const tests = output.match(/(?:^|\n)[^\n]*tests\s+(\d+)/i)?.[1];
  const passed = output.match(/(?:^|\n)[^\n]*pass\s+(\d+)/i)?.[1];
  const failed = output.match(/(?:^|\n)[^\n]*fail\s+(\d+)/i)?.[1];
  if (!tests || !passed || failed === undefined) return null;
  return `${passed}/${tests} tests passed, ${failed} failed`;
}

function singleLineClip(value: string, maxChars: number): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > maxChars ? `${line.slice(0, maxChars).trimEnd()}…` : line;
}

// Auditor feedback in the main transcript: a quiet retractable card — header
// row with the flag + agent name, expandable to the full report. The doer
// model still receives the raw [audit-feedback] block; this is display only.
function AuditFeedbackCard({
  agentTitle,
  report,
}: {
  agentTitle: string;
  report: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const firstLine = report.split('\n')[0] ?? '';
  const preview = firstLine.length > 90 ? `${firstLine.slice(0, 90).trimEnd()}…` : firstLine;
  return (
    <div className={`audit-feedback-card ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="audit-feedback-row"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="audit-feedback-flag" aria-hidden="true">⚑</span>
        <span className="audit-feedback-title">Audit feedback · {agentTitle}</span>
        {!open && preview ? <span className="audit-feedback-preview">{preview}</span> : null}
        <span className="audit-feedback-chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="audit-feedback-body">
          <MarkdownContent text={report} />
        </div>
      ) : null}
    </div>
  );
}

const ChatItemView = memo(function ChatItemView({
  item,
  meta,
  streaming,
  turnId,
}: {
  item: ChatItem;
  meta?: ItemMeta;
  streaming: boolean;
  turnId?: string | null;
}): React.JSX.Element | null {
  if (item.type === 'system') {
    return (
      <article className={`message message-system message-system-${item.level}`}>
        {item.text}
      </article>
    );
  }

  if (item.type === 'userMessage') {
    const text = item.content
      .filter((content) => content.type === 'text')
      .map((content) => stripMentionContext(stripAutomaticSkillMarker(stripInjectedMemory(content.text))))
      .join('\n');
    const attachments = attachmentsFromUserInput(item.content);
    // Auditor feedback renders as a compact retractable card, not the raw
    // block the doer model receives.
    const feedback = parseAuditFeedback(text);
    if (feedback) {
      return (
        <article className="message message-audit-feedback" data-turn-id={turnId ?? undefined}>
          <AuditFeedbackCard agentTitle={feedback.agentTitle} report={feedback.report} />
        </article>
      );
    }

    return (
      <article className="message message-user" data-turn-id={turnId ?? undefined}>
        {text ? <p>{text}</p> : null}
        <AttachmentStrip attachments={attachments} />
      </article>
    );
  }

  if (item.type === 'agentMessage') {
    // Messages stream into the transcript live, Cursor-style — commentary
    // (in-task narration) renders slightly muted; the final answer full-weight.
    return (
      <AssistantMessage
        text={item.text}
        streaming={streaming}
        commentary={item.phase === 'commentary'}
      />
    );
  }

  if (item.type === 'contextCompaction') {
    const inProgress = Boolean(meta?.startedAtMs) && !meta?.completedAtMs;
    const before = meta?.compaction?.beforeTokens ?? null;
    const after = meta?.compaction?.afterTokens ?? null;

    if (inProgress) {
      return (
        <article className="message message-compaction">
          <span className="shimmer-text">
            {before
              ? `Compacting context — summarizing ${formatTokens(before)} tokens…`
              : 'Compacting context…'}
          </span>
        </article>
      );
    }

    // Compactions restored from history carry no token metadata; only live
    // ones can show the real shrink.
    const shrank = before !== null && after !== null && after < before;
    return (
      <article className="message message-compaction">
        {shrank
          ? `Context compacted — ${formatTokens(before)} → ${formatTokens(after)} tokens (${Math.round((1 - after / before) * 100)}% smaller)`
          : 'Context compacted'}
      </article>
    );
  }

  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    return (
      <article className="message message-system message-system-info">
        {item.type === 'enteredReviewMode' ? 'Entered review mode' : 'Exited review mode'}
      </article>
    );
  }

  // Anything else (hookPrompt and future item types) stays quiet but visible.
  return (
    <article className="message message-tool">
      <strong>{item.type}</strong>
    </article>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming,
  commentary,
}: {
  text: string;
  streaming: boolean;
  commentary: boolean;
}): React.JSX.Element {
  return (
    <article
      className={`message message-assistant ${commentary ? 'message-commentary' : ''} ${
        streaming ? 'is-streaming' : ''
      }`}
    >
      {streaming ? (
        <StreamingMarkdownContent text={text || ' '} />
      ) : (
        <MarkdownContent text={text || ' '} />
      )}
    </article>
  );
});

function WorkspacePill({
  workspace,
  onPickWorkspace,
}: {
  workspace: string | null;
  onPickWorkspace: () => Promise<void>;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="workspace-pill"
      title={workspace ?? 'No workspace selected — new chats start in your home folder'}
      onClick={() => void onPickWorkspace()}
    >
      <FolderIcon />
      <span className="workspace-pill-name">
        {workspace ? workspaceName(workspace) : 'Choose workspace'}
      </span>
      <span className="workspace-pill-caret">⌄</span>
    </button>
  );
}

// Composer pill showing how full the thread's model context is (the last
// model call's tokens against the model window). Clicking it asks the
// app-server to compact the thread; auto-compaction also runs at 80% from the
// main process, so this is the "clean up now" affordance.
function ContextPill({
  usage,
  disabled,
  compacting,
  onCompact,
}: {
  usage: ThreadTokenUsage | null;
  disabled: boolean;
  compacting: boolean;
  onCompact: () => Promise<void>;
}): React.JSX.Element | null {
  const window = usage?.modelContextWindow;
  const contextTokens = usage?.last.totalTokens ?? 0;

  if (!usage || !window || contextTokens <= 0) {
    return null;
  }

  const percent = Math.min(100, Math.round((contextTokens / window) * 100));
  const level = percent >= 80 ? 'is-high' : percent >= 60 ? 'is-warm' : '';

  return (
    <button
      type="button"
      className={`context-pill ${level} ${compacting ? 'is-compacting' : ''}`}
      disabled={disabled}
      title={
        compacting
          ? 'Compacting the conversation…'
          : `Context ${percent}% full (${contextTokens.toLocaleString()} of ${window.toLocaleString()} tokens). Click to compact the conversation.`
      }
      onClick={() => void onCompact()}
    >
      <span className="context-pill-track" aria-hidden="true">
        <span className="context-pill-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="context-pill-label">{compacting ? '…' : `${percent}%`}</span>
    </button>
  );
}

// Thread-scoped goal controls live in settings so the composer remains focused
// on composing, while preserving the app-server goal lifecycle and usage data.
function GoalSettings({
  goal,
  disabled,
  onSave,
  onSetStatus,
  onClear,
}: {
  goal: ThreadGoal | null;
  disabled: boolean;
  onSave: (objective: string, tokenBudget: number | null) => Promise<boolean>;
  onSetStatus: (status: Extract<ThreadGoalStatus, 'active' | 'paused'>) => Promise<void>;
  onClear: () => Promise<void>;
}): React.JSX.Element {
  const [objective, setObjective] = useState(goal?.objective ?? '');
  const [tokenBudget, setTokenBudget] = useState(goal?.tokenBudget ? String(goal.tokenBudget) : '');

  useEffect(() => {
    setObjective(goal?.objective ?? '');
    setTokenBudget(goal?.tokenBudget ? String(goal.tokenBudget) : '');
  }, [goal?.objective, goal?.tokenBudget]);

  const submitGoal = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const parsedBudget = tokenBudget.trim() ? Number(tokenBudget) : null;
    if (parsedBudget !== null && (!Number.isFinite(parsedBudget) || parsedBudget <= 0)) return;

    const saved = await onSave(objective, parsedBudget === null ? null : Math.floor(parsedBudget));
    if (!saved) return;
  };

  return (
    <div className="goal-settings">
      <div className="goal-settings-heading">
        <div>
          <p className="goal-settings-label">
            Keep this thread working toward a persistent objective.
          </p>
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
            <button type="button" disabled={disabled} onClick={() => void onSetStatus('paused')}>
              Pause
            </button>
          ) : goal?.status === 'paused' ? (
            <button type="button" disabled={disabled} onClick={() => void onSetStatus('active')}>
              Resume
            </button>
          ) : null}
          {goal ? (
            <button
              type="button"
              className="goal-clear"
              disabled={disabled}
              onClick={() => void onClear()}
            >
              Clear
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function goalStatusLabel(status: ThreadGoalStatus): string {
  return {
    active: 'Goal active',
    paused: 'Goal paused',
    blocked: 'Goal blocked',
    usageLimited: 'Usage limited',
    budgetLimited: 'Budget reached',
    complete: 'Goal complete',
  }[status];
}

function formatGoalTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 3_600
    ? `${minutes}m ${Math.round(seconds % 60)}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

type ComposerDraft = {
  value: string;
  attachments: ChatAttachment[];
  mentions?: FileMention[];
};

const composerDrafts = new Map<string, ComposerDraft>();

function discardComposerDraft(key: string): void {
  composerDrafts.delete(key);
}

function Composer({
  draftKey,
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
  onNewAgent,
  footerLeading,
  footerTrailing,
}: {
  draftKey: string;
  docked: boolean;
  workspace: string | null;
  installedPlugins: PluginSummary[];
  onInstalledPluginsChange: (plugins: PluginSummary[]) => void;
  onBrowsePlugins: () => void;
  isLoading: boolean;
  isTurnActive: boolean;
  status: string;
  onSend: (text: string, attachments?: ChatAttachment[]) => Promise<boolean>;
  onSteer: (text: string) => Promise<boolean>;
  onStop: () => Promise<void>;
  onNewThread: () => void;
  onNewAgent: () => void;
  footerLeading?: React.ReactNode;
  footerTrailing?: React.ReactNode;
}): React.JSX.Element {
  const [value, setValue] = useState(() => composerDrafts.get(draftKey)?.value ?? '');
  const [attachments, setAttachments] = useState<ChatAttachment[]>(
    () => composerDrafts.get(draftKey)?.attachments ?? [],
  );
  const [mentions, setMentions] = useState<FileMention[]>(
    () => composerDrafts.get(draftKey)?.mentions ?? [],
  );
  const [mentionIndex, setMentionIndex] = useState<{ files: string[]; dirs: string[] } | null>(
    null,
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const [pluginMenuState, setPluginMenuState] = useState<'closed' | 'loading' | 'ready' | 'error'>(
    'closed',
  );
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [pluginSelectionIndex, setPluginSelectionIndex] = useState(0);
  const pluginMention = value.match(/(?:^|\s)@([^\s@]*)$/);
  const pluginQuery = pluginMention?.[1].toLowerCase() ?? null;
  const hasDraft = Boolean(value.trim() || attachments.length || mentions.length);
  const isQuietStatus = status === 'idle' || status === 'ready';
  const visibleStatus = attachmentError ?? (isTurnActive || isQuietStatus ? null : status);

  useEffect(() => {
    composerDrafts.set(draftKey, { value, attachments, mentions });
  }, [draftKey, value, attachments, mentions]);

  // Workspace file index for @-mentions: fetched when a mention token opens,
  // cached for the life of that menu (the main process caches the git listing
  // too, so re-opens stay cheap).
  useEffect(() => {
    if (pluginQuery === null || !workspace) {
      setMentionIndex(null);
      return;
    }
    if (mentionIndex) return;
    let cancelled = false;
    void window.api.mentions.index({ workspace }).then(
      (result) => {
        if (!cancelled) setMentionIndex(result);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginQuery === null, workspace]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(190, Math.max(54, textarea.scrollHeight))}px`;
  }, [value]);

  useEffect(() => {
    if (pluginQuery === null || isLoading) {
      setPluginMenuState('closed');
      return;
    }

    let cancelled = false;
    setPluginMenuState('loading');
    void window.api.session.listInstalledPlugins({ cwd: workspace }).then(
      (result) => {
        if (cancelled) return;
        onInstalledPluginsChange(
          flattenPlugins(result.marketplaces).filter((plugin) => plugin.installed),
        );
        setPluginMenuState('ready');
      },
      () => {
        if (!cancelled) setPluginMenuState('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pluginQuery !== null, workspace, isLoading, onInstalledPluginsChange]);

  useEffect(() => setPluginSelectionIndex(0), [pluginQuery]);

  useEffect(() => {
    if (hasDraft || isTurnActive || isLoading) {
      setIsCreateMenuOpen(false);
    }
  }, [hasDraft, isTurnActive, isLoading]);

  useEffect(() => {
    if (!isCreateMenuOpen) return;

    const handlePointerDown = (event: MouseEvent): void => {
      if (createMenuRef.current && !createMenuRef.current.contains(event.target as Node)) {
        setIsCreateMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsCreateMenuOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isCreateMenuOpen]);

  const mentionPlugins = installedPlugins.filter((plugin) => {
    const name = plugin.interface?.displayName || plugin.name;
    return (
      !pluginQuery ||
      name.toLowerCase().includes(pluginQuery) ||
      plugin.keywords.some((keyword) => keyword.toLowerCase().includes(pluginQuery))
    );
  });

  // File/folder candidates share the mention menu with plugins: files first,
  // one selection index spanning both sections.
  const fileCandidates = useMemo(
    () =>
      pluginQuery !== null && mentionIndex
        ? rankMentionCandidates(pluginQuery, mentionIndex.files, mentionIndex.dirs, 8)
        : [],
    [pluginQuery, mentionIndex],
  );
  const mentionOptionCount = fileCandidates.length + mentionPlugins.length;

  const chooseMention = (candidate: MentionCandidate): void => {
    const match = value.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match || match.index === undefined) return;
    const leadingSpace = match[0].startsWith(' ') ? ' ' : '';
    setMentions((current) =>
      current.some((mention) => mention.path === candidate.path && mention.kind === candidate.kind)
        ? current
        : [...current, { path: candidate.path, kind: candidate.kind }],
    );
    setValue(`${value.slice(0, match.index)}${leadingSpace}`);
    setPluginMenuState('closed');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const choosePlugin = (plugin: PluginSummary): void => {
    const match = value.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match || match.index === undefined) return;
    const leadingSpace = match[0].startsWith(' ') ? ' ' : '';
    const name = plugin.interface?.displayName || plugin.name;
    setValue(`${value.slice(0, match.index)}${leadingSpace}@${name} `);
    setPluginMenuState('closed');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chooseMentionOption = (index: number): void => {
    if (index < fileCandidates.length) {
      chooseMention(fileCandidates[index]);
    } else if (mentionPlugins.length) {
      choosePlugin(mentionPlugins[Math.min(index - fileCandidates.length, mentionPlugins.length - 1)]);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    const text = value.trim();
    if ((!text && !attachments.length && !mentions.length) || isLoading) {
      return;
    }

    setValue('');
    const submittedAttachments = attachments;
    const submittedMentions = mentions;
    if (!isTurnActive) setAttachments([]);
    setMentions([]);

    // Cursor-style resolution: mentioned files/folders are read now and ride
    // along inside a marker block the transcript strips from display.
    let outgoing = text;
    if (submittedMentions.length && workspace) {
      const resolved = await Promise.all(
        submittedMentions.map(async (mention) => ({
          ...mention,
          ...(await window.api.mentions
            .read({ workspace, path: mention.path, kind: mention.kind })
            .catch(() => ({ content: null, truncated: false }))),
        })),
      );
      outgoing = `${text}${buildMentionContext(resolved)}`;
    }

    const accepted = isTurnActive
      ? await onSteer(outgoing)
      : await onSend(outgoing, submittedAttachments);
    if (!accepted) {
      setValue((current) => (current ? `${text}\n${current}` : text));
      if (!isTurnActive) setAttachments(submittedAttachments);
      setMentions(submittedMentions);
    } else {
      composerDrafts.delete(draftKey);
    }
  };

  const runCreateCommand = (command: () => void): void => {
    setIsCreateMenuOpen(false);
    command();
  };

  return (
    <form
      className="composer"
      onSubmit={handleSubmit}
      onDragOver={(event) => {
        if (!isTurnActive && event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (isTurnActive) return;
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        event.preventDefault();
        setAttachmentError(null);
        void saveBrowserFiles(files)
          .then((items) => setAttachments((current) => [...current, ...items]))
          .catch((error: unknown) =>
            setAttachmentError(error instanceof Error ? error.message : String(error)),
          );
      }}
    >
      {pluginMenuState !== 'closed' ? (
        <div className="composer-mention-stack">
          {fileCandidates.length ? (
            <FileMentionMenu
              candidates={fileCandidates}
              selectedIndex={pluginSelectionIndex}
              onChoose={chooseMention}
            />
          ) : null}
          <PluginMentionMenu
            state={pluginMenuState}
            plugins={mentionPlugins}
            selectedIndex={pluginSelectionIndex - fileCandidates.length}
            onChoose={choosePlugin}
            onBrowse={() => {
              setPluginMenuState('closed');
              onBrowsePlugins();
            }}
            onUninstalled={(pluginId) =>
              onInstalledPluginsChange(installedPlugins.filter((plugin) => plugin.id !== pluginId))
            }
          />
        </div>
      ) : null}
      {mentions.length ? (
        <div className="mention-strip" aria-label="Attached context">
          {mentions.map((mention) => (
            <span
              key={`${mention.kind}:${mention.path}`}
              className="mention-pill"
              title={mention.path}
            >
              <MentionGlyph kind={mention.kind} />
              <span className="mention-pill-name">
                {mention.path.split('/').pop() || mention.path}
              </span>
              <button
                type="button"
                className="mention-pill-remove"
                aria-label={`Remove ${mention.path}`}
                onClick={() =>
                  setMentions((current) =>
                    current.filter(
                      (existing) =>
                        !(existing.path === mention.path && existing.kind === mention.kind),
                    ),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <AttachmentStrip
        attachments={attachments}
        removable
        onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
      />
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder={
          isTurnActive
            ? 'Add guidance while Codex works…'
            : docked
              ? 'Reply…'
              : 'Plan, build, or ask anything…'
        }
        disabled={isLoading}
        onChange={(event) => setValue(event.target.value)}
        onPaste={(event) => {
          if (isTurnActive) return;
          const images = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith('image/'),
          );
          if (!images.length) return;
          const pastedText = event.clipboardData.getData('text/plain');
          const start = event.currentTarget.selectionStart;
          const end = event.currentTarget.selectionEnd;
          event.preventDefault();
          if (pastedText)
            setValue((current) => `${current.slice(0, start)}${pastedText}${current.slice(end)}`);
          setAttachmentError(null);
          void saveBrowserFiles(images)
            .then((items) => setAttachments((current) => [...current, ...items]))
            .catch((error: unknown) =>
              setAttachmentError(error instanceof Error ? error.message : String(error)),
            );
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && pluginMenuState !== 'closed') {
            event.preventDefault();
            setPluginMenuState('closed');
            return;
          }
          if (pluginMenuState === 'ready' && mentionOptionCount && event.key === 'ArrowDown') {
            event.preventDefault();
            setPluginSelectionIndex((current) => (current + 1) % mentionOptionCount);
            return;
          }
          if (pluginMenuState === 'ready' && mentionOptionCount && event.key === 'ArrowUp') {
            event.preventDefault();
            setPluginSelectionIndex(
              (current) => (current - 1 + mentionOptionCount) % mentionOptionCount,
            );
            return;
          }
          if (
            pluginMenuState === 'ready' &&
            mentionOptionCount &&
            event.key === 'Enter' &&
            !event.shiftKey
          ) {
            event.preventDefault();
            chooseMentionOption(Math.min(pluginSelectionIndex, mentionOptionCount - 1));
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="composer-footer">
        <div className="composer-leading-actions">
          <AttachmentButton
            disabled={isLoading || isTurnActive}
            onAdd={(items) => {
              setAttachmentError(null);
              setAttachments((current) => [...current, ...items]);
            }}
            onError={setAttachmentError}
          />
          {footerLeading}
        </div>
        {visibleStatus ? (
          <span className={`composer-status ${isLoading ? 'is-active' : ''}`}>{visibleStatus}</span>
        ) : null}
        {footerTrailing ? <div className="composer-trailing-actions">{footerTrailing}</div> : null}
        <div className="composer-primary-action" ref={createMenuRef}>
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
            <>
              {isCreateMenuOpen ? (
                <div className="composer-create-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-create-item"
                    onClick={() => runCreateCommand(onNewThread)}
                  >
                    <span className="composer-create-item-icon" aria-hidden="true">
                      <ChatBubbleIcon />
                    </span>
                    <span>New chat</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="composer-create-item"
                    onClick={() => runCreateCommand(onNewAgent)}
                  >
                    <span className="composer-create-item-icon" aria-hidden="true">
                      <NewAgentIcon />
                    </span>
                    <span>New agent</span>
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                className={`send-button composer-new-chat ${isCreateMenuOpen ? 'is-open' : ''}`}
                aria-label="Create"
                title="Create"
                aria-haspopup="menu"
                aria-expanded={isCreateMenuOpen}
                disabled={isLoading}
                onClick={() => setIsCreateMenuOpen((open) => !open)}
              >
                <NewChatIcon />
              </button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// The file/folder section of the @-mention menu (Cursor's @Files/@Folders).
// Shares one selection index with the plugin section below it.
function FileMentionMenu({
  candidates,
  selectedIndex,
  onChoose,
}: {
  candidates: MentionCandidate[];
  selectedIndex: number;
  onChoose: (candidate: MentionCandidate) => void;
}): React.JSX.Element {
  return (
    <div className="file-mention-menu" role="listbox" aria-label="Workspace files">
      <div className="file-mention-heading">Files &amp; folders</div>
      {candidates.map((candidate, index) => {
        const base = candidate.path.split('/').pop() || candidate.path;
        const dir = candidate.path.slice(0, Math.max(0, candidate.path.length - base.length - 1));
        return (
          <button
            key={`${candidate.kind}:${candidate.path}`}
            type="button"
            role="option"
            aria-selected={selectedIndex === index}
            className={`file-mention-row ${selectedIndex === index ? 'is-selected' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(candidate)}
          >
            <MentionGlyph kind={candidate.kind} />
            <span className="file-mention-base">{base}</span>
            {dir ? <span className="file-mention-dir">{dir}</span> : null}
            {candidate.kind === 'folder' ? <span className="file-mention-kind">folder</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function MentionGlyph({ kind }: { kind: 'file' | 'folder' }): React.JSX.Element {
  return (
    <svg
      className="mention-glyph"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'folder' ? (
        <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h3.6a1.5 1.5 0 0 1 1.1.44l1 1.06h7.8A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5L3.5 7Z" />
      ) : (
        <>
          <path d="M13 4H7a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9.5L13 4Z" />
          <path d="M13 4v5.5h5.5" />
        </>
      )}
    </svg>
  );
}

function PluginMentionMenu({
  state,
  plugins,
  selectedIndex,
  onChoose,
  onBrowse,
  onUninstalled,
}: {
  state: 'loading' | 'ready' | 'error';
  plugins: PluginSummary[];
  selectedIndex: number;
  onChoose: (plugin: PluginSummary) => void;
  onBrowse: () => void;
  onUninstalled: (pluginId: string) => void;
}): React.JSX.Element {
  const [removing, setRemoving] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const remove = (plugin: PluginSummary): void => {
    if (armed !== plugin.id) {
      setArmed(plugin.id);
      return;
    }
    const uninstallId = pluginUninstallId(plugin);
    if (!uninstallId) return;
    setRemoving(plugin.id);
    void window.api.session
      .uninstallPlugin(uninstallId)
      .then(() => {
        onUninstalled(plugin.id);
        setArmed(null);
      })
      .finally(() => setRemoving(null));
  };

  return (
    <div className="plugin-mention-menu" role="listbox" aria-label="Installed plugins">
      <div className="plugin-mention-heading">
        <span>Installed plugins</span>
        <span>{plugins.length || ''}</span>
      </div>
      <div className="plugin-mention-list">
        {state === 'loading' ? (
          <div className="plugin-menu-message shimmer-text">Loading plugins…</div>
        ) : null}
        {state === 'error' ? (
          <div className="plugin-menu-message">Plugins could not be loaded.</div>
        ) : null}
        {state === 'ready' && !plugins.length ? (
          <div className="plugin-menu-message">No matching installed plugins.</div>
        ) : null}
        {state === 'ready'
          ? plugins.map((plugin, index) => (
              <div
                className={`plugin-mention-row ${selectedIndex === index ? 'is-selected' : ''}`}
                key={plugin.id}
                role="option"
                aria-selected={selectedIndex === index}
              >
                <button
                  type="button"
                  className="plugin-mention-select"
                  onClick={() => onChoose(plugin)}
                >
                  <span className="plugin-glyph">
                    <PluginGlyph plugin={plugin} />
                  </span>
                  <span className="plugin-mention-copy">
                    <strong>{plugin.interface?.displayName || plugin.name}</strong>
                    <small>
                      {plugin.interface?.shortDescription ||
                        plugin.interface?.capabilities.slice(0, 2).join(' · ') ||
                        'Plugin'}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className={`plugin-remove ${armed === plugin.id ? 'is-armed' : ''}`}
                  aria-label={
                    armed === plugin.id ? `Confirm remove ${plugin.name}` : `Remove ${plugin.name}`
                  }
                  title={armed === plugin.id ? 'Click again to remove' : 'Remove plugin'}
                  disabled={removing === plugin.id}
                  onClick={() => remove(plugin)}
                >
                  {armed === plugin.id ? <span>Remove</span> : <TrashIcon />}
                </button>
              </div>
            ))
          : null}
      </div>
      <button type="button" className="browse-plugins-button" onClick={onBrowse}>
        <span>Browse plugins</span>
        <span aria-hidden="true">↗</span>
      </button>
    </div>
  );
}

function persistLastThreadId(threadId: string | null): void {
  if (threadId) {
    window.localStorage.setItem(lastThreadStorageKey, threadId);
  } else {
    window.localStorage.removeItem(lastThreadStorageKey);
  }
}

function threadTitle(thread: Thread): string {
  return stripSkillMarkerFromTitle(thread.name || thread.preview || 'New Chat');
}

function stripSkillMarkerFromTitle(title: string): string {
  return title.replace(/^\$artifact-first-web-research\s*/i, '') || 'New Chat';
}

function workspaceName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

// Compact recency label for a thread row: "now", "5m", "3h" within a day, then
// "Yesterday", a weekday within the week, and a short date beyond that. Keeps
// rows scannable instead of repeating a full "Jul 9, 3:14 PM" on every line.
function relativeThreadTime(seconds: number): string {
  const then = seconds * 1000;
  const diff = Date.now() - then;
  if (diff < 45_000) {
    return 'now';
  }
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) {
    return `${hours}h`;
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  if (then >= startOfToday.getTime() - dayMs) {
    return 'Yesterday';
  }
  if (then >= startOfToday.getTime() - 6 * dayMs) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(then);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(then);
}
