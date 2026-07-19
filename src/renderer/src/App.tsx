import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { discardComposerDraft } from './Composer';
import { ChatPane } from './ChatPane';
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
import type { Turn } from '../../shared/session-protocol';
import { summarizeTurnDiff } from './diff';
import { buildTurnTrace } from './trace';
import {
  modelCallAttributionForItem,
  reduceTurnTelemetry,
} from './turn-telemetry';
import { type ItemMeta, type TurnMeta, type TurnPlanItem } from './TaskActivity';
import { stripMentionContext } from './mention-model';
import { stripAutomaticSkillMarker, stripInjectedMemory } from './ChatTranscript';
import { completedMemoryTurns } from './memory-turns';
import type { ChatAttachment } from '../../shared/ipc';
import { isWorkItem, upsertMany, type ChatItem, type SystemItem } from './transcript-model';
import {
  isImmediateItemNotification,
  isItemNotification,
  reduceItemNotificationItems,
  reduceItemNotificationMeta,
  type ItemNotification,
} from './item-notifications';
import { reduceResearchProgressMeta } from './activity-model';
import { BrowserPane } from './BrowserPane';
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
import {
  defaultThreadTitle,
  cloneGoal,
  hasObservedTerminalTurn,
  isRecoverableTurnError,
  isTerminalTurnStatus,
  modelAcceptsImages,
  provisionalThreadTitle,
  relativeThreadTime,
  resolveThreadTitle,
  threadTitle,
} from './app-helpers';
import { useAgentSessions } from './useAgentSessions';
import { shouldHandleChatSplitShortcut } from './keyboard-shortcuts';
import {
  buildDeclinedInjection,
  buildExecutionInjection,
  buildPlanBriefing,
  buildRestateInjection,
  isNoPlan,
  lastAgentMessageText,
  latestAssistantText,
  noPlanReason,
  pickIntakeReviewer,
  reviewerDisplayLabel,
  stripIntakeInjections,
  type IntakeState,
} from './main-chat-intake';
import {
  buildSteerMessage,
  buildWatchdogBriefing,
  newWatchdogTurnState,
  nextWatchdogDelayMs,
  parseWatchdogVerdict,
  watchdogCheckDue,
  type WatchdogTurnState,
} from './main-chat-watchdog';
import {
  continueLoop,
  decideLoopContinuation,
  loopConvergedMessage,
  loopRoundMessage,
  loopStopMessage,
  startLoop,
  type LoopDecision,
  type LoopState,
} from './audit-loop-controller';
import { outOfWorkspacePaths } from './workspace-containment';
import { defaultReviewerModel, latestAuditReport } from './agent-session-model';
import {
  buildOptimisticUserMessage,
  hasAuthoritativeUserMessage,
  stripOptimisticUserMessage,
} from './optimistic-user-message';
import {
  closeMainChatTab,
  createMainChatTab,
  maxMainChatTabs,
  needsMainChatTabHydration,
  parseMainChatTabState,
  reorderMainChatTabs,
  serializeMainChatTabState,
  tabForThread,
  type BrowserMiddleSide,
  type MainChatTab,
  type MainChatTabState,
} from './main-chat-tabs';
import {
  alwaysKeepAllStorageKey,
  isAlwaysKeepAllStored,
  storedAlwaysKeepAllValue,
} from './review-preference';
import {
  adjacentSplitPaneKey,
  canSplitPaneAt,
  canSplitPaneForDrop,
  countSplitPanes,
  insertSplitPane,
  parseChatSplitLayout,
  reconcileChatSplitLayout,
  removeSplitPane,
  replaceSplitPane,
  serializeChatSplitLayout,
  splitHasPane,
  splitPaneKeys,
  updateSplitRatio,
  type SplitDropZone,
  type SplitNode,
} from './chat-split';
import {
  browserMiddleChatLayout,
  parseBrowserMiddleColumnWidths,
  parseWorkspaceLayoutMode,
  serializeBrowserMiddleColumnWidths,
  showChatAtFullHeight,
  type BrowserMiddleActiveTabKeys,
  type BrowserMiddleTabKeys,
  type BrowserMiddleColumnWidths,
  type WorkspaceLayoutMode,
} from './workspace-layout';

const minChatWidth = 280;
const minBrowserMiddleChatWidth = 220;
const minBrowserWidth = 420;
const dividerWidth = 8;
const lastThreadStorageKey = 'codexdesktop.lastThreadId';
const mainChatTabsStorageKey = 'codexdesktop.mainChatTabs.v1';
const chatSplitStorageKey = 'codexdesktop.chatSplit.v1';
const workspaceLayoutStorageKey = 'codexdesktop.workspaceLayout.v1';
const browserMiddleColumnWidthsStorageKey = 'codexdesktop.browserMiddleColumnWidths.v1';
const browserMiddleActiveTabsStorageKey = 'codexdesktop.browserMiddleActiveTabs.v1';
const agentDockStorageKey = 'codexdesktop.agentDock.v1';
const modelStorageKey = 'codexdesktop.model';
const reasoningEffortStorageKey = 'codexdesktop.reasoningEffort';
const fastModeStorageKey = 'codexdesktop.fastMode';

const titlebarTimeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const titlebarDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

const titlebarAccessibleFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'full',
  timeStyle: 'short',
});

// Turn failures the app can recover from by retrying/continuing on the same
// thread: capacity problems on the provider side, not problems with the
// request itself (auth, context window, budget, policy).
const maxAutoRecoveryAttempts = 3;
const autoRecoveryDelayMs = 10_000;
const autoRecoveryPrompt =
  'The previous turn was cut short by a model availability error. Continue the task from where you left off.';

type AutoRecoveryState = {
  threadId: string;
  attempts: number;
  // Turn ids already handled, so the `error` notification and the
  // `turn/completed` failure for the same turn schedule only one recovery.
  handledTurnIds: Set<string>;
  timer: number | null;
};

type PendingThreadStartOwner = { kind: 'main'; key: string } | { kind: 'agent'; key: string };

function browserMiddleTabKeys(tabs: readonly MainChatTab[]): BrowserMiddleTabKeys {
  return {
    left: tabs
      .filter((tab) => tab.browserMiddleSide === 'left')
      .map((tab) => tab.key),
    right: tabs
      .filter((tab) => tab.browserMiddleSide === 'right')
      .map((tab) => tab.key),
  };
}

function parseBrowserMiddleActiveTabKeys(raw: string | null): BrowserMiddleActiveTabKeys {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return { left: null, right: null };
    const candidate = parsed as { left?: unknown; right?: unknown };
    return {
      left: typeof candidate.left === 'string' && candidate.left ? candidate.left : null,
      right: typeof candidate.right === 'string' && candidate.right ? candidate.right : null,
    };
  } catch {
    return { left: null, right: null };
  }
}

function reconcileBrowserMiddleActiveTabKeys(
  current: BrowserMiddleActiveTabKeys,
  tabs: readonly MainChatTab[],
  activeKey: string,
): BrowserMiddleActiveTabKeys {
  const bySide = browserMiddleTabKeys(tabs);
  const next: BrowserMiddleActiveTabKeys = {
    left: bySide.left.includes(current.left ?? '') ? current.left : bySide.left[0] ?? null,
    right: bySide.right.includes(current.right ?? '') ? current.right : bySide.right[0] ?? null,
  };
  const active = tabs.find((tab) => tab.key === activeKey);
  if (active?.browserMiddleSide) next[active.browserMiddleSide] = active.key;
  return next;
}

function ensureBrowserMiddleTabAssignments(state: MainChatTabState): MainChatTabState {
  let tabs = state.tabs;
  const createCompanion = (side: BrowserMiddleSide): void => {
    const template = tabs.find((tab) => tab.key === state.activeKey) ?? tabs[0];
    tabs = [
      ...tabs,
      createMainChatTab(
        crypto.randomUUID(),
        null,
        'New Chat',
        template?.model ?? null,
        template?.reasoningEffort ?? null,
        side,
        template?.workspace ?? null,
      ),
    ];
  };
  const assign = (key: string, side: BrowserMiddleSide): void => {
    const index = tabs.findIndex((tab) => tab.key === key);
    if (index < 0 || tabs[index].browserMiddleSide === side) return;
    if (tabs === state.tabs) tabs = [...tabs];
    tabs[index] = { ...tabs[index], browserMiddleSide: side };
  };

  const pickUnassigned = (preferActive: boolean): MainChatTab | null =>
    (preferActive
      ? tabs.find((tab) => tab.key === state.activeKey && tab.browserMiddleSide === null)
      : null) ?? tabs.find((tab) => tab.browserMiddleSide === null) ?? null;

  if (!tabs.some((tab) => tab.browserMiddleSide === 'left')) {
    const target = pickUnassigned(true);
    if (target) assign(target.key, 'left');
    else createCompanion('left');
  }
  if (!tabs.some((tab) => tab.browserMiddleSide === 'right')) {
    const target = pickUnassigned(false);
    if (target) {
      assign(target.key, 'right');
    } else {
      createCompanion('right');
    }
  }

  let bySide = browserMiddleTabKeys(tabs);
  for (const tab of tabs.filter((candidate) => candidate.browserMiddleSide === null)) {
    const side: BrowserMiddleSide = bySide.left.length <= bySide.right.length ? 'left' : 'right';
    assign(tab.key, side);
    bySide = browserMiddleTabKeys(tabs);
  }

  return tabs === state.tabs ? state : { ...state, tabs };
}

// The per-session render model now lives in session-store.ts (Phase 2); a
// main-chat "snapshot" is simply a session state held under the tab's key.
type MainChatSnapshot = SessionRenderState;

export default function App(): React.JSX.Element {
  const initialWorkspaceLayoutMode = parseWorkspaceLayoutMode(
    window.localStorage.getItem(workspaceLayoutStorageKey),
  );
  const [split, setSplit] = useState(() => {
    const stored = Number(window.localStorage.getItem('codexdesktop.split'));
    return Number.isFinite(stored) && stored > 20 && stored < 70 ? stored : 37;
  });
  const [mainChatTabState, setMainChatTabState] = useState<MainChatTabState>(() => {
    const parsed = parseMainChatTabState(
      window.localStorage.getItem(mainChatTabsStorageKey),
      window.localStorage.getItem(lastThreadStorageKey),
      () => crypto.randomUUID(),
      {
        // One-time migration source for tab state saved before model choices
        // and workspace selection were isolated per chat.
        model: window.localStorage.getItem(modelStorageKey),
        reasoningEffort: window.localStorage.getItem(reasoningEffortStorageKey),
        workspace: window.localStorage.getItem('codexdesktop.workspace'),
      },
    );
    return initialWorkspaceLayoutMode === 'browser-middle'
      ? ensureBrowserMiddleTabAssignments(parsed)
      : parsed;
  });
  const mainChatTabs = mainChatTabState.tabs;
  const activeMainChatTabKey = mainChatTabState.activeKey;
  const initialMainChatTab =
    mainChatTabs.find((tab) => tab.key === activeMainChatTabKey) ?? mainChatTabs[0];
  // Which open chats are on screen and how they tile (single, side-by-side,
  // stacked, quadrants). Every pane key is an open tab key; the active tab is
  // always one of the visible panes.
  const [chatSplitLayout, setChatSplitLayoutState] = useState<SplitNode>(() =>
    parseChatSplitLayout(
      window.localStorage.getItem(chatSplitStorageKey),
      mainChatTabState.tabs.map((tab) => tab.key),
      mainChatTabState.activeKey,
    ),
  );
  const chatSplitLayoutRef = useRef(chatSplitLayout);
  const [workspaceLayoutMode, setWorkspaceLayoutMode] = useState<WorkspaceLayoutMode>(() =>
    initialWorkspaceLayoutMode,
  );
  const [browserMiddleActiveTabKeys, setBrowserMiddleActiveTabKeys] =
    useState<BrowserMiddleActiveTabKeys>(() =>
      reconcileBrowserMiddleActiveTabKeys(
        parseBrowserMiddleActiveTabKeys(
          window.localStorage.getItem(browserMiddleActiveTabsStorageKey),
        ),
        mainChatTabState.tabs,
        mainChatTabState.activeKey,
      ),
    );
  const [browserMiddleColumnWidths, setBrowserMiddleColumnWidths] =
    useState<BrowserMiddleColumnWidths>(() =>
      parseBrowserMiddleColumnWidths(
        window.localStorage.getItem(browserMiddleColumnWidthsStorageKey),
      ),
    );
  // The pane that most recently held the active tab — where a newly selected
  // hidden tab should appear, mirroring how a single pane swaps content.
  const focusedPaneTabKeyRef = useRef(mainChatTabState.activeKey);
  const [isGoalUpdating, setIsGoalUpdating] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const [reconcilingMainChatTabKey, setReconcilingMainChatTabKey] = useState<string | null>(null);
  const [codexStatus, setCodexStatus] = useState('idle');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadsNextCursor, setThreadsNextCursor] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const workspace = initialMainChatTab.workspace;
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
  const [browserState, setBrowserState] = useState<BrowserState>({ tabs: [], activeTabId: null, vpn: { state: 'off', bootstrapProgress: 0, detail: null } });
  const [viewBounds, setViewBounds] = useState<BrowserBounds | null>(null);
  // Browser-fullscreen hides the chat pane and divider so the browser fills
  // the workspace. Renderer-only: the native view follows via the normal
  // host-measurement pipeline (ResizeObserver -> setBounds).
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(false);
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
    handleSpawnedAgent,
    handleOpenAgent,
    handleMinimizeAgent,
    handleSetAgentRole,
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
  const auditContextByAuditorRef = useRef<Map<string, { threadId: string | null; auditedTurnWasFeedback: boolean; changedFileCount: number | null }>>(new Map());
  // Loop-to-done ledger per auditor: rounds dispatched + the last flag's
  // signature (audit-loop-controller.ts). Transient by design — a reload
  // mid-loop stops the loop rather than resuming blind.
  const auditLoopRef = useRef<Map<string, LoopState>>(new Map());
  const pendingAuditFeedbackRef = useRef(false);
  const userRequestedTurnIdRef = useRef<string | null>(null);
  const optimisticUserMessageIdRef = useRef<string | null>(null);
  const selectedReasoningEffortRef = useRef<ReasoningEffort | null>(selectedReasoningEffort);
  const fastModeRef = useRef(fastMode);
  // This ref is only the focused tab's display value. All asynchronous work
  // must resolve its owning tab or thread explicitly (see helpers below).
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
  const browserMiddleActiveTabKeysRef = useRef(browserMiddleActiveTabKeys);
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

  // Covers a thread that began before this renderer loaded (for example after
  // a hot reload or resume). A submitted chat should never wait for the
  // server's eventual title-generation pass just to stop reading "New Chat".
  useEffect(() => {
    const tabKey = activeMainChatTabKeyRef.current;
    const tab = mainChatTabStateRef.current.tabs.find((candidate) => candidate.key === tabKey);
    if (!tab?.threadId || tab.title !== defaultThreadTitle) return;

    const firstUserMessage = items.find(
      (item): item is Extract<ThreadItem, { type: 'userMessage' }> => item.type === 'userMessage',
    );
    const prompt = firstUserMessage?.content
      .filter((content) => content.type === 'text')
      .map((content) => stripIntakeInjections(stripMentionContext(stripAutomaticSkillMarker(stripInjectedMemory(content.text)))))
      .join('\n')
      .trim() ?? '';
    const title = provisionalThreadTitle(prompt);
    if (title === defaultThreadTitle) return;

    patchMainChatTab(tabKey, (current) => ({ ...current, title }));
    activeThreadTitleRef.current = title;
    setActiveThreadTitle(title);
  }, [activeMainChatTabKey, activeThreadId, activeThreadTitle, items]);

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
    chatSplitLayoutRef.current = chatSplitLayout;
    // Debounced: ratio drags update the layout once per pointer move.
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(chatSplitStorageKey, serializeChatSplitLayout(chatSplitLayout));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [chatSplitLayout]);

  useEffect(() => {
    window.localStorage.setItem(workspaceLayoutStorageKey, workspaceLayoutMode);
  }, [workspaceLayoutMode]);

  useEffect(() => {
    window.localStorage.setItem(
      browserMiddleColumnWidthsStorageKey,
      serializeBrowserMiddleColumnWidths(browserMiddleColumnWidths),
    );
  }, [browserMiddleColumnWidths]);

  useEffect(() => {
    browserMiddleActiveTabKeysRef.current = browserMiddleActiveTabKeys;
    window.localStorage.setItem(
      browserMiddleActiveTabsStorageKey,
      JSON.stringify(browserMiddleActiveTabKeys),
    );
  }, [browserMiddleActiveTabKeys]);

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

  function updateChatSplitLayout(update: (layout: SplitNode) => SplitNode): void {
    // Eager against the ref, like updateMainChatTabs: drop handlers read the
    // layout back synchronously right after writing it.
    const next = update(chatSplitLayoutRef.current);
    if (next === chatSplitLayoutRef.current) return;
    chatSplitLayoutRef.current = next;
    setChatSplitLayoutState(next);
  }

  function updateMainChatTabs(update: (state: MainChatTabState) => MainChatTabState): void {
    // Applied eagerly against the ref (the always-current source) so
    // activeMainChatTabKeyRef is correct the moment this returns — active-
    // session writes that follow in the same handler must target the new key,
    // not wait for React to run a queued updater.
    const next = update(mainChatTabStateRef.current);
    mainChatTabStateRef.current = next;
    activeMainChatTabKeyRef.current = next.activeKey;
    setMainChatTabState(next);
    const nextBrowserMiddleActiveTabKeys = reconcileBrowserMiddleActiveTabKeys(
      browserMiddleActiveTabKeysRef.current,
      next.tabs,
      next.activeKey,
    );
    if (
      nextBrowserMiddleActiveTabKeys.left !== browserMiddleActiveTabKeysRef.current.left ||
      nextBrowserMiddleActiveTabKeys.right !== browserMiddleActiveTabKeysRef.current.right
    ) {
      browserMiddleActiveTabKeysRef.current = nextBrowserMiddleActiveTabKeys;
      setBrowserMiddleActiveTabKeys(nextBrowserMiddleActiveTabKeys);
    }
    // Every tab mutation flows through here, so this is the single place the
    // split layout is forced back to its invariants. In the browser-centered
    // workspace each branch belongs to one side; applying the ordinary
    // active-pane replacement there could move a left tab into the right raw
    // branch (and make the next left-side split target the wrong tree).
    const reconciled =
      workspaceLayoutMode === 'browser-middle'
        ? browserMiddleChatLayout(
            chatSplitLayoutRef.current,
            browserMiddleTabKeys(next.tabs),
            nextBrowserMiddleActiveTabKeys,
          )
        : reconcileChatSplitLayout(
            chatSplitLayoutRef.current,
            next.tabs.map((tab) => tab.key),
            next.activeKey,
            focusedPaneTabKeyRef.current,
          );
    if (reconciled !== chatSplitLayoutRef.current) {
      chatSplitLayoutRef.current = reconciled;
      setChatSplitLayoutState(reconciled);
    }
    focusedPaneTabKeyRef.current = next.activeKey;
  }

  function patchMainChatTab(key: string, update: (tab: MainChatTab) => MainChatTab): void {
    updateMainChatTabs((state) => ({
      ...state,
      tabs: state.tabs.map((tab) => (tab.key === key ? update(tab) : tab)),
    }));
  }

  function workspaceForMainChatTab(tabKey: string): string | null {
    return mainChatTabStateRef.current.tabs.find((tab) => tab.key === tabKey)?.workspace ?? null;
  }

  function workspaceForThread(threadId: string): string | null {
    return mainChatTabForThread(threadId)?.workspace ?? null;
  }

  function handleReorderMainChatTabs(
    sourceKey: string,
    targetKey: string,
    placement: 'before' | 'after',
  ): void {
    updateMainChatTabs((state) => reorderMainChatTabs(state, sourceKey, targetKey, placement));
  }

  // With several composers mounted (one per pane), "focus the composer" must
  // target the active pane's textarea, not the first one in DOM order.
  function focusActiveComposer(): void {
    requestAnimationFrame(() => {
      const key = activeMainChatTabKeyRef.current;
      const scoped = document.querySelector<HTMLTextAreaElement>(
        `[data-split-pane-key="${CSS.escape(key)}"] .composer textarea`,
      );
      (scoped ?? document.querySelector<HTMLTextAreaElement>('.composer textarea'))?.focus();
    });
  }

  function handleDropTabOnSplitPane(
    sourceKey: string,
    targetKey: string,
    zone: SplitDropZone,
  ): void {
    if (isMainChatTransitionLocked()) return;
    if (!mainChatTabStateRef.current.tabs.some((tab) => tab.key === sourceKey)) return;
    updateChatSplitLayout((layout) =>
      zone === 'center'
        ? replaceSplitPane(layout, targetKey, sourceKey)
        : insertSplitPane(layout, targetKey, sourceKey, zone),
    );
    // The dropped chat is where the user's attention goes; selecting it also
    // runs hydration for a tab that never had the focused path. Select sees
    // the source already visible, so the layout it just landed in stays put.
    void handleSelectMainChatTab(sourceKey);
  }

  function handleCloseSplitPane(tabKey: string): void {
    const layout = chatSplitLayoutRef.current;
    if (countSplitPanes(layout) <= 1 || !splitHasPane(layout, tabKey)) return;
    if (tabKey !== activeMainChatTabKeyRef.current) {
      updateChatSplitLayout((current) => removeSplitPane(current, tabKey));
      return;
    }
    // Closing the focused pane: hand focus to its split sibling first so the
    // active tab never points at a hidden chat. A locked transition (send or
    // hydration in flight) aborts the close instead of breaking the invariant.
    const sibling = adjacentSplitPaneKey(layout, tabKey);
    if (!sibling) return;
    void (async () => {
      if (await handleSelectMainChatTab(sibling)) {
        updateChatSplitLayout((current) => removeSplitPane(current, tabKey));
      }
    })();
  }

  function handleSetSplitRatio(path: string, ratio: number): void {
    updateChatSplitLayout((layout) => updateSplitRatio(layout, path, ratio));
  }

  function toggleBrowserMiddleLayout(): void {
    if (isMainChatTransitionLocked()) return;

    if (workspaceLayoutMode === 'browser-middle') {
      setWorkspaceLayoutMode('chat-browser');
      return;
    }

    // Browser-centered workspaces own two independent tab collections. Older
    // saved tab state had no side assignment, so normalize it at the boundary
    // and seed the missing side with a real fresh chat when necessary.
    const normalized = ensureBrowserMiddleTabAssignments(mainChatTabStateRef.current);
    if (normalized !== mainChatTabStateRef.current) {
      updateMainChatTabs(() => normalized);
    }

    updateChatSplitLayout((layout) =>
      browserMiddleChatLayout(
        layout,
        browserMiddleTabKeys(mainChatTabStateRef.current.tabs),
        browserMiddleActiveTabKeysRef.current,
      ),
    );
    setWorkspaceLayoutMode('browser-middle');
  }

  // Split the focused pane and open a fresh chat in the new half — the
  // no-drag path to a 2x2 grid: Split right, then Split down on each column.
  function handleSplitActivePane(
    targetKey: string,
    direction: 'right' | 'down',
  ): boolean {
    if (isMainChatTransitionLocked()) return false;
    if (mainChatTabStateRef.current.tabs.length >= maxMainChatTabs) return false;
    const focusedKey = targetKey;
    if (!canSplitPaneAt(chatSplitLayoutRef.current, focusedKey)) return false;
    flushActiveMainChatSession();
    cancelAutoRecovery();
    const tab = createMainChatTab(
      crypto.randomUUID(),
      null,
      'New Chat',
      selectedModelRef.current,
      selectedReasoningEffortRef.current,
      mainChatTabStateRef.current.tabs.find((candidate) => candidate.key === focusedKey)
        ?.browserMiddleSide ?? null,
      workspaceForMainChatTab(focusedKey),
    );
    // The pane is placed before its tab exists (raw layout op, no validation);
    // the tab update right after adds the tab and focuses it, so its
    // reconcile already sees a fully valid layout and keeps it.
    updateChatSplitLayout((layout) =>
      insertSplitPane(layout, focusedKey, tab.key, direction === 'right' ? 'right' : 'bottom'),
    );
    updateMainChatTabs((state) => ({ tabs: [...state.tabs, tab], activeKey: tab.key }));
    focusMainChatTab(tab);
    persistLastThreadId(null);
    focusActiveComposer();
    return true;
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
    workspaceRef.current = tab.workspace;
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

      if (event.type === 'agentSpawned') {
        // Resolve which main-chat tab owns the spawning thread so the worker
        // docks in the right chat: a main tab spawned it → that tab; a dock
        // agent spawned it → that agent's owning tab; otherwise the active tab.
        const parentThreadId = event.parentThreadId;
        const owningTabKey =
          (parentThreadId ? mainChatTabForThread(parentThreadId)?.key : null) ??
          (parentThreadId ? backgroundSessionForThread(parentThreadId)?.mainChatTabKey : null) ??
          activeMainChatTabKeyRef.current;
        const parentAgentKey = parentThreadId
          ? (backgroundSessionForThread(parentThreadId)?.key ?? null)
          : null;
        handleSpawnedAgent({
          agentKey: event.agentKey,
          parentAgentKey,
          mainChatTabKey: owningTabKey,
          title: event.title,
          model: event.model,
        });
        return;
      }

      // A tagged child notification carries the spawning worker's agentKey. The
      // worker session was created with a null threadId (the orchestrator
      // announced it before its turn started), so bind the real child threadId
      // the first time we see it — from then on the ordinary threadId routing
      // in handleCodexNotification reaches the worker.
      if (event.agentKey) {
        const childThreadId = (event.notification as { params?: { threadId?: string } } | undefined)
          ?.params?.threadId;
        if (childThreadId) {
          const worker = agentSessionsRef.current.find((session) => session.key === event.agentKey);
          if (worker && worker.threadId !== childThreadId) {
            patchAgentSession(event.agentKey, (session) => ({ ...session, threadId: childThreadId }));
          }
        }
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

  const toggleBrowserFullscreen = useCallback(() => {
    setIsBrowserFullscreen((current) => !current);
  }, []);

  useEffect(() => {
    updateBrowserBounds(true);
  }, [
    split,
    workspaceLayoutMode,
    browserMiddleColumnWidths,
    isBrowserFullscreen,
    updateBrowserBounds,
  ]);

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

  const handleBrowserMiddleDividerPointerDown = (
    event: PointerEvent<HTMLDivElement>,
    side: keyof BrowserMiddleColumnWidths,
  ): void => {
    const app = appRef.current;
    if (!app) return;

    isDraggingDividerRef.current = true;
    void window.api.browser.beginDividerDrag();
    event.currentTarget.setPointerCapture(event.pointerId);

    const appRect = app.getBoundingClientRect();
    const maxSideWidth =
      appRect.width - minBrowserWidth - minBrowserMiddleChatWidth - dividerWidth * 2;
    let latestWidths = browserMiddleColumnWidths;

    const handleMove = (moveEvent: globalThis.PointerEvent): void => {
      const rawWidth =
        side === 'left'
          ? moveEvent.clientX - appRect.left
          : appRect.right - moveEvent.clientX;
      const clamped = Math.min(
        Math.max(rawWidth, minBrowserMiddleChatWidth),
        Math.max(minBrowserMiddleChatWidth, maxSideWidth),
      );
      latestWidths = { ...latestWidths, [side]: (clamped / appRect.width) * 100 };
      setBrowserMiddleColumnWidths(latestWidths);
    };

    let dragFinished = false;
    const finishDrag = (): void => {
      if (dragFinished) return;
      dragFinished = true;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      window.localStorage.setItem(
        browserMiddleColumnWidthsStorageKey,
        serializeBrowserMiddleColumnWidths(latestWidths),
      );
      isDraggingDividerRef.current = false;
      const latestBounds = measureBrowserBounds() ?? pendingBoundsRef.current;
      if (latestBounds) void window.api.browser.endDividerDrag(latestBounds);
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
    const threadId = activeThreadIdRef.current;
    const existingTab = mainChatTabStateRef.current.tabs.find((tab) => tab.key === targetTabKey);
    const priorTitle = existingTab?.title ?? defaultThreadTitle;
    const provisionalTitle = threadId
      ? null
      : provisionalThreadTitle(trimmed || attachments[0]?.name || '');
    const appliedProvisionalTitle =
      Boolean(
        provisionalTitle &&
          provisionalTitle !== defaultThreadTitle &&
          priorTitle === defaultThreadTitle,
      );
    if (appliedProvisionalTitle && provisionalTitle) {
      patchMainChatTab(targetTabKey, (tab) => ({ ...tab, title: provisionalTitle }));
      activeThreadTitleRef.current = provisionalTitle;
      setActiveThreadTitle(provisionalTitle);
    }
    const optimisticId = `optimistic-user-${crypto.randomUUID()}`;
    optimisticUserMessageIdRef.current = optimisticId;
    setItems((current) => [
      ...current,
      buildOptimisticUserMessage(optimisticId, trimmed, attachments),
    ]);

    // Conversational intake (docs/prompt-intake-2026-07-19.md): with a
    // Reviewer docked, a fresh thread's first send becomes a restatement turn;
    // the user's natural-language confirmation then fetches the reviewer's
    // plan before the doer starts. The transcript shows only the user's words.
    let outgoingText = trimmed;
    let startedIntakeRestatement = false;
    const intakeState = mainChatIntakeRef.current.get(targetTabKey);
    const intakeReviewer = pickIntakeReviewer(agentSessionsRef.current, targetTabKey);
    if (intakeState && intakeState.threadId !== threadId) {
      // The pending protocol belongs to a different conversation (thread
      // switched around the bind) — drop it and send normally.
      mainChatIntakeRef.current.delete(targetTabKey);
    } else if (!intakeState && !threadId && intakeReviewer) {
      outgoingText = `${trimmed}${buildRestateInjection(reviewerDisplayLabel(intakeReviewer, models))}`;
      mainChatIntakeRef.current.set(targetTabKey, {
        phase: 'awaitingConfirmation',
        threadId: null,
        original: trimmed,
      });
      startedIntakeRestatement = true;
    } else if (intakeState?.phase === 'awaitingConfirmation') {
      intakeState.phase = 'planning';
      let plan: string | null = null;
      if (intakeReviewer) {
        const briefing = buildPlanBriefing({
          original: intakeState.original,
          restatement: lastAgentMessageText(itemsRef.current) ?? '(restatement unavailable)',
          reply: trimmed,
          doerLabel:
            models.find((model) => model.id === selectedModel)?.displayName ??
            selectedModel ??
            'the main-chat model',
        });
        try {
          const baselineMessageCount = intakeReviewer.messages.length;
          if (await handleAgentSend(intakeReviewer.key, briefing, [])) {
            plan = await awaitReviewerPlan(intakeReviewer.key, baselineMessageCount);
          }
        } catch {
          plan = null;
        }
      }
      if (plan && isNoPlan(plan)) {
        // Not a go: stay in the protocol and let the doer answer normally.
        intakeState.phase = 'awaitingConfirmation';
        outgoingText = `${trimmed}${buildDeclinedInjection(noPlanReason(plan))}`;
      } else {
        mainChatIntakeRef.current.delete(targetTabKey);
        if (!plan) {
          addSystemItem('Reviewer plan unavailable — starting without it.', 'warning');
        }
        outgoingText = `${trimmed}${buildExecutionInjection(plan, reviewerDisplayLabel(intakeReviewer, models))}`;
      }
    }

    try {
      if (!threadId) {
        mainThreadStartsInFlightRef.current.add(targetTabKey);
        pendingThreadStartOwnersRef.current.push({ kind: 'main', key: targetTabKey });
      }

      const response = await window.api.session.sendMessage({
        threadId,
        text: outgoingText,
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
      // Notifications and invoke responses travel over separate Electron
      // channels. A very fast turn can therefore complete before this awaited
      // start response resumes. The terminal notification is authoritative:
      // never resurrect that turn as working after its completion UI painted.
      const responseSnapshot = sessionStoreRef.current.peek(targetTabKey);
      const terminalAlreadyObserved = hasObservedTerminalTurn(
        responseSnapshot?.turnMeta ?? {},
        response.turn.id,
      );
      const targetIsActive = activeMainChatTabKeyRef.current === targetTabKey;
      patchMainChatTab(targetTabKey, (tab) => ({
        ...tab,
        threadId: response.threadId,
        // The completion handler already chose idle vs attention based on
        // whether this tab was focused when it finished. Preserve that exact
        // settled presentation if the invoke response arrives afterward.
        status: terminalAlreadyObserved ? tab.status : 'working',
        turnId: terminalAlreadyObserved ? null : response.turn.id,
      }));
      if (startedIntakeRestatement) {
        // Bind the protocol to the thread the restatement turn created so a
        // later thread switch invalidates it cleanly.
        const intake = mainChatIntakeRef.current.get(targetTabKey);
        if (intake) intake.threadId = response.threadId;
      }
      if (!targetIsActive) {
        const snapshot = responseSnapshot;
        if (snapshot) {
          sessionStoreRef.current.set(targetTabKey, {
            ...snapshot,
            threadId: response.threadId,
            turnId: terminalAlreadyObserved ? null : response.turn.id,
            reasoningEffort: response.reasoningEffort,
          });
        }
        return true;
      }
      watchThreadIdRef.current = response.threadId;
      activeThreadIdRef.current = response.threadId;
      setActiveThreadId(response.threadId);
      persistLastThreadId(response.threadId);
      const turnAlreadyObserved =
        terminalAlreadyObserved || activeTurnIdRef.current === response.turn.id;
      if (!turnAlreadyObserved) userRequestedTurnIdRef.current = response.turn.id;
      if (!terminalAlreadyObserved) {
        setActiveTurnId(response.turn.id);
        activeTurnIdRef.current = response.turn.id;
      }
      setActiveReasoningEffort(response.reasoningEffort);
      activeReasoningEffortRef.current = response.reasoningEffort;
      const goalSnapshot = cloneGoal(activeGoalRef.current);
      noteTurn(response.turn.id, {
        ...(terminalAlreadyObserved ? {} : { status: 'inProgress' as const }),
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
      if (appliedProvisionalTitle && provisionalTitle) {
        const tab = mainChatTabStateRef.current.tabs.find((candidate) => candidate.key === targetTabKey);
        if (tab?.threadId === null && tab.title === provisionalTitle) {
          patchMainChatTab(targetTabKey, (current) => ({ ...current, title: priorTitle }));
          if (activeMainChatTabKeyRef.current === targetTabKey) {
            activeThreadTitleRef.current = priorTitle;
            setActiveThreadTitle(priorTitle);
          }
        }
      }
      if (startedIntakeRestatement) mainChatIntakeRef.current.delete(targetTabKey);
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
      ...createMainChatTab(tab.key, null, 'New Chat', tab.model, tab.reasoningEffort, null, tab.workspace),
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

  const handleNewMainChatTab = (requestedSide: BrowserMiddleSide | null = null): boolean => {
    if (isMainChatTransitionLocked() || mainChatTabStateRef.current.tabs.length >= maxMainChatTabs)
      return false;
    flushActiveMainChatSession();
    cancelAutoRecovery();
    const active = mainChatTabStateRef.current.tabs.find(
      (tab) => tab.key === activeMainChatTabKeyRef.current,
    );
    const browserMiddleSide =
      workspaceLayoutMode === 'browser-middle'
        ? requestedSide ?? active?.browserMiddleSide ?? 'left'
        : null;
    const tab = createMainChatTab(
      crypto.randomUUID(),
      null,
      'New Chat',
      selectedModelRef.current,
      selectedReasoningEffortRef.current,
      browserMiddleSide,
      active?.workspace ?? null,
    );
    // New-tab creation is intentionally not a split command. The fresh chat
    // owns the full chat height; users can drag tabs onto pane edges when they
    // want a horizontal or vertical split.
    updateChatSplitLayout((layout) => showChatAtFullHeight(layout, tab.key, browserMiddleSide));
    updateMainChatTabs((state) => ({ tabs: [...state.tabs, tab], activeKey: tab.key }));
    focusMainChatTab(tab);
    persistLastThreadId(null);
    focusActiveComposer();
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
    focusActiveComposer();
    return true;
  };

  const handleCloseMainChatTab = async (key: string): Promise<void> => {
    if (isMainChatTransitionLocked()) return;
    const current = mainChatTabStateRef.current;
    const closing = current.tabs.find((tab) => tab.key === key);
    if (!closing || closing.status === 'working') return;
    const wasActive = current.activeKey === key;
    if (wasActive) flushActiveMainChatSession();

    // Each centered column must remain independently usable. Closing its last
    // tab clears that slot into a fresh chat instead of silently deleting the
    // entire right or left collection.
    if (
      workspaceLayoutMode === 'browser-middle' &&
      closing.browserMiddleSide &&
      current.tabs.filter((tab) => tab.browserMiddleSide === closing.browserMiddleSide).length === 1
    ) {
      const replacement = createMainChatTab(
        closing.key,
        null,
        'New Chat',
        closing.model,
        closing.reasoningEffort,
        closing.browserMiddleSide,
        closing.workspace,
      );
      sessionStoreRef.current.remove(key);
      resumeFailuresByTabRef.current.delete(key);
      discardComposerDraft(key);
      updateMainChatTabs((state) => ({
        ...state,
        tabs: state.tabs.map((tab) => (tab.key === key ? replacement : tab)),
      }));
      if (closing.threadId) unsubscribeDetachedMainThread(closing.threadId);
      if (wasActive) {
        cancelAutoRecovery();
        focusMainChatTab(replacement);
        persistLastThreadId(null);
        focusActiveComposer();
      }
      return;
    }

    let next = closeMainChatTab(current, key, () => crypto.randomUUID());
    // Closing a chat that is on screen in a split: focus stays in the split
    // (its spatial sibling) instead of jumping to a hidden neighbor tab. The
    // pane itself collapses via the reconcile inside updateMainChatTabs.
    const layout = chatSplitLayoutRef.current;
    if (wasActive && countSplitPanes(layout) > 1 && splitHasPane(layout, key)) {
      const sibling = adjacentSplitPaneKey(layout, key);
      const fallback = splitPaneKeys(removeSplitPane(layout, key))[0];
      const preferred = [sibling, fallback].find(
        (candidate): candidate is string =>
          Boolean(candidate) && next.tabs.some((tab) => tab.key === candidate),
      );
      if (preferred) next = { ...next, activeKey: preferred };
    }
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
    const existing = mainChatTabForThread(threadId);
    if (existing) {
      return handleSelectMainChatTab(existing.key);
    }

    const previousState = mainChatTabStateRef.current;
    const current = previousState.tabs.find((tab) => tab.key === activeMainChatTabKeyRef.current);
    const browserMiddleSide =
      workspaceLayoutMode === 'browser-middle' ? current?.browserMiddleSide ?? 'left' : null;
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
          browserMiddleSide,
          current?.workspace ?? null,
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
    const tabKey = activeMainChatTabKeyRef.current;
    const tab = mainChatTabStateRef.current.tabs.find((candidate) => candidate.key === tabKey);
    if (tab?.threadId) {
      addSystemItem(
        'This chat is already bound to its working directory. Start a new chat to work in a different folder.',
        'warning',
      );
      return;
    }
    try {
      const picked = await window.api.workspace.pick();

      if (picked) {
        patchMainChatTab(tabKey, (current) => ({ ...current, workspace: picked }));
        workspaceRef.current = picked;
      }
    } catch (error) {
      addSystemItem(`Workspace selection failed: ${(error as Error).message}`, 'error');
    }
  };

  async function ensureThreadForGoal(): Promise<string> {
    const existingThreadId = activeThreadIdRef.current;
    if (existingThreadId) return existingThreadId;

    const started = await window.api.session.startThread({
      cwd: workspaceForMainChatTab(activeMainChatTabKeyRef.current),
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
      workspace: started.thread.cwd ?? tab.workspace,
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

      // Ctrl+\ splits the focused pane to the right; Ctrl+Shift+\ splits it
      // downward. Require the physical key and ignore editor-owned events so
      // a composer submit can never be misread as a workspace split command.
      if (shouldHandleChatSplitShortcut(event)) {
        event.preventDefault();
        handleSplitActivePane(
          activeMainChatTabKeyRef.current,
          event.key === '|' || event.shiftKey ? 'down' : 'right',
        );
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
        focusActiveComposer();
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
    isTurnTerminal: (key, turnId) =>
      hasObservedTerminalTurn(sessionStoreRef.current.peek(key)?.turnMeta ?? {}, turnId),
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
    isTurnTerminal: (key, turnId) =>
      hasObservedTerminalTurn(sessionStoreRef.current.peek(key)?.turnMeta ?? {}, turnId),
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
          const existingTitle = mainChatTabStateRef.current.tabs.find(
            (tab) => tab.key === pendingOwner.key,
          )?.title ?? defaultThreadTitle;
          const startedTitle = resolveThreadTitle(
            threadTitle(notification.params.thread),
            existingTitle,
          );
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
        const existingTitle = mainChatTabStateRef.current.tabs.find(
          (tab) => tab.key === activeMainChatTabKeyRef.current,
        )?.title ?? defaultThreadTitle;
        const startedTitle = resolveThreadTitle(threadTitle(notification.params.thread), existingTitle);
        activeThreadTitleRef.current = startedTitle;
        setActiveThreadTitle(activeThreadTitleRef.current);
        patchMainChatTab(activeMainChatTabKeyRef.current, (tab) => ({
          ...tab,
          threadId: notification.params.thread.id,
          title: startedTitle,
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
          {
            // Containment backstop: work that landed outside the workspace
            // escaped checkpoints, Keep/Undo, and audit diff grounding — say
            // so in the transcript (a warning, never a gate).
            const commands: string[] = [];
            const editedPaths: string[] = [];
            for (const item of itemsRef.current) {
              if (itemMetaRef.current[item.id]?.turnId !== turn.id) continue;
              if (item.type === 'commandExecution') commands.push(item.command);
              else if (item.type === 'fileChange')
                editedPaths.push(...item.changes.map((change) => change.path));
            }
            const outside = outOfWorkspacePaths({
              commands,
              filePaths: editedPaths,
              workspace: workspaceRef.current,
            });
            if (outside.length) {
              addSystemItem(
                `This turn touched paths outside the workspace (${outside.join(', ')}) — anything created there is not covered by checkpoints or Keep/Undo.`,
                'warning',
              );
            }
          }
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
              title: resolveThreadTitle(threadTitle(resumed.thread), current.title),
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

    const currentTitle = mainChatTabStateRef.current.tabs.find(
      (tab) => tab.key === activeMainChatTabKeyRef.current,
    )?.title ?? defaultThreadTitle;
    const nextTitle = resolveThreadTitle(threadTitle(thread), currentTitle);
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

  // Conversational intake state per main-chat tab (protocol in
  // main-chat-intake.ts). Transient by design: a reload mid-protocol simply
  // sends the next message normally.
  const mainChatIntakeRef = useRef(new Map<string, IntakeState>());

  // A thread switch or reset invalidates a pending intake for the active tab —
  // the confirmation would target a conversation no longer on screen.
  useEffect(() => {
    const state = mainChatIntakeRef.current.get(activeMainChatTabKey);
    if (state && state.threadId !== null && state.threadId !== activeThreadId) {
      mainChatIntakeRef.current.delete(activeMainChatTabKey);
    }
  }, [activeThreadId, activeMainChatTabKey]);

  // Wait for the paired reviewer to answer the briefing just sent. Polls the
  // sessions ref (bounded, 500ms) instead of adding subscription plumbing;
  // resolves null on timeout or reset so the main chat can never be bricked
  // by its reviewer. `afterMessageCount` is the reviewer's message count from
  // BEFORE the briefing was sent — acceptance requires growth past it, so a
  // previously completed exchange (status still 'done', old reply on top) can
  // never be mistaken for the new answer.
  async function awaitReviewerPlan(
    reviewerKey: string,
    afterMessageCount: number,
    timeoutMs = 120_000,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let sawWorking = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      const reviewer = agentSessionsRef.current.find((session) => session.key === reviewerKey);
      if (!reviewer) return null;
      if (reviewer.status === 'working') {
        sawWorking = true;
        continue;
      }
      if (reviewer.messages.length > afterMessageCount && reviewer.status === 'done') {
        const text = latestAssistantText(reviewer.messages);
        if (text !== null) return text;
        continue; // completion raced ahead of the message reduce — keep polling
      }
      if (sawWorking && reviewer.status === 'idle') return null; // reset out from under us
    }
    return null;
  }

  // The user's request for a turn, display-stripped — shared by the completion
  // audit briefing and the mid-turn watchdog briefing.
  function turnUserRequestText(turnId: string): string {
    const userItem = itemsRef.current.find(
      (item) => item.type === 'userMessage' && itemMetaRef.current[item.id]?.turnId === turnId,
    );
    if (!userItem || userItem.type !== 'userMessage') return '(request text unavailable)';
    return (
      userItem.content
        .filter((content) => content.type === 'text')
        .map((content) => stripIntakeInjections(stripMentionContext(stripAutomaticSkillMarker(stripInjectedMemory(content.text)))))
        .join('\n')
        .trim() || '(request text unavailable)'
    );
  }

  // Mid-turn watchdog (main-chat-watchdog.ts): sparse trajectory checks on the
  // paired reviewer while a long main-chat turn runs. Silence-by-default — an
  // ON-TRACK reply is dropped; a STEER reply lands in the running turn through
  // the steer channel. Short turns never qualify, so quick tasks pay nothing.
  const watchdogRef = useRef(new Map<string, WatchdogTurnState>());
  const watchdogTickRef = useRef<() => void>(() => {});
  watchdogTickRef.current = () => void maybeRunWatchdogCheck();
  useEffect(() => {
    const timer = window.setInterval(() => watchdogTickRef.current(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  async function maybeRunWatchdogCheck(): Promise<void> {
    const tabKey = activeMainChatTabKeyRef.current;
    const turnId = activeTurnIdRef.current;
    const states = watchdogRef.current;
    if (!turnId) {
      states.delete(tabKey);
      return;
    }
    // Intake protocol turns are conversation, not work.
    if (mainChatIntakeRef.current.has(tabKey)) return;
    let state = states.get(tabKey);
    if (!state || state.turnId !== turnId) {
      const startedAtMs = turnMetaRef.current[turnId]?.startedAtMs ?? Date.now();
      state = newWatchdogTurnState(turnId, startedAtMs);
      states.set(tabKey, state);
    }
    const steps = turnStepLines(itemsRef.current, itemMetaRef.current, turnId);
    if (!watchdogCheckDue(state, Date.now(), steps.length)) return;
    const reviewer = pickIntakeReviewer(agentSessionsRef.current, tabKey);
    // No paired reviewer, or busy on something else → try again next tick.
    if (!reviewer || reviewer.status === 'working') return;

    state.inFlight = true;
    state.checksSent += 1;
    state.nextCheckAtMs = Date.now() + nextWatchdogDelayMs(state.checksSent);
    try {
      const startedAtMs = turnMetaRef.current[turnId]?.startedAtMs ?? Date.now();
      const briefing = buildWatchdogBriefing({
        userText: turnUserRequestText(turnId),
        steps,
        elapsedMinutes: Math.max(1, Math.round((Date.now() - startedAtMs) / 60_000)),
        checkNumber: state.checksSent,
        doerLabel:
          models.find((model) => model.id === selectedModel)?.displayName ??
          selectedModel ??
          'the main-chat model',
      });
      const baselineMessageCount = reviewer.messages.length;
      if (!(await handleAgentSend(reviewer.key, briefing, []))) return;
      const reply = await awaitReviewerPlan(reviewer.key, baselineMessageCount, 90_000);
      // The turn may have finished while the check ran — never steer a dead
      // turn (the completion audit is about to cover it anyway).
      if (!reply || activeTurnIdRef.current !== turnId) return;
      const verdict = parseWatchdogVerdict(reply);
      if (verdict.verdict === 'steer') {
        const threadId = activeThreadIdRef.current;
        if (threadId) {
          await window.api.session
            .steerTurn({
              threadId,
              turnId,
              text: buildSteerMessage(reviewer.title, verdict.guidance),
            })
            .catch(() => {});
        }
      }
    } finally {
      state.inFlight = false;
    }
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
    // Intake protocol turns (restatement / declined-start replies) are not
    // work — the reviewer plans instead of auditing until the task starts.
    if (mainChatIntakeRef.current.has(activeTabKey)) return;
    // A watchdog check may be mid-flight on the reviewer as the turn ends;
    // busy auditors are normally skipped, but skipping HERE would trade the
    // end audit (the loop's verdict) for a trajectory check. Wait it out,
    // bounded.
    {
      const watchdog = watchdogRef.current.get(activeTabKey);
      if (watchdog?.inFlight) {
        const deadline = Date.now() + 90_000;
        while (watchdog.inFlight && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
      }
    }
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
    const userText = turnUserRequestText(turnId);
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
        // Ground truth for the controller's progress check. null = signal not
        // applicable: either detection was unavailable (non-git workspace) or
        // the turn was chat-style work (an answer with no file changes —
        // research/review tasks), where "changed no files" is normal, not
        // stagnation. The ceiling and repeated-flag checks still bound those
        // loops.
        changedFileCount:
          detectionUnavailable || (changed.length === 0 && Boolean(answerText))
            ? null
            : changed.length,
      });
      void handleAgentSend(auditor.key, prompt, [], { audit: auditSummary });
    }
  }

  // Audit feedback: when an auditor with "send findings to main chat" enabled
  // finishes an audit with VERDICT: flag, the report flows into the main chat
  // as a visible turn for the doer to act on. Gated (pure, tested): flag-only,
  // main idle, same thread — and fix-turn audits bounce again only under the
  // loop-to-done controller's policy (round ceiling, real progress, no
  // repeated flag). A pass on a fix turn converges the loop; every stop is
  // announced in the transcript.
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
    const verdict = parseAuditVerdict(report);
    if (verdict !== 'flag') {
      const loop = auditLoopRef.current.get(sessionKey);
      if (loop && verdict === 'pass' && context?.auditedTurnWasFeedback) {
        // The reviewer approved a fix round: the loop is done — say so.
        addSystemItem(loopConvergedMessage(loop.rounds), 'info');
      }
      auditLoopRef.current.delete(sessionKey);
      return;
    }
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
    // Loop-to-done controller: decide whether this fix-turn flag earns another
    // round before consulting the send gate.
    let loopDecision: LoopDecision | null = null;
    if (context.auditedTurnWasFeedback) {
      loopDecision = decideLoopContinuation({
        state: auditLoopRef.current.get(sessionKey) ?? null,
        fixTurnChangedFiles: context.changedFileCount,
        report,
      });
      if (loopDecision.kind === 'stop') {
        const rounds = auditLoopRef.current.get(sessionKey)?.rounds ?? 0;
        auditLoopRef.current.delete(sessionKey);
        addSystemItem(loopStopMessage(loopDecision.reason, rounds), 'warning');
        explainSkip(`Flagged — loop stopped (${loopDecision.reason}); click the flag to send`);
        return;
      }
    }
    if (
      !shouldSendAuditFeedback({
        verdict: 'flag',
        reportsToMain: session.reportsToMain,
        mainIdle: !activeTurnIdRef.current,
        sameThread: context.threadId !== null && context.threadId === activeThreadIdRef.current,
        auditedTurnWasFeedback: context.auditedTurnWasFeedback,
        loopMayContinue: loopDecision?.kind === 'continue',
      })
    ) {
      explainSkip(
        activeTurnIdRef.current
          ? 'Flagged — main chat was busy; click the flag to send'
          : 'Flagged — main chat moved on; click the flag to send',
      );
      return;
    }
    pendingAuditFeedbackRef.current = true;
    const sent = await handleSend(buildAuditFeedbackMessage({ agentTitle: session.title, report }));
    pendingAuditFeedbackRef.current = false;
    if (sent) {
      // Advance the ledger only on a dispatched round, and announce it.
      const previous = auditLoopRef.current.get(sessionKey);
      const next =
        context.auditedTurnWasFeedback && previous ? continueLoop(previous, report) : startLoop(report);
      auditLoopRef.current.set(sessionKey, next);
      addSystemItem(loopRoundMessage(next.rounds), 'info');
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

  // Phase 4 ledger: turnId -> checkpointId for every open chat. Split panes
  // stay mounted concurrently, so their review controls need the same
  // checkpoint view as the focused chat rather than a focus-dependent subset.
  const [turnCheckpoints, setTurnCheckpoints] = useState<Record<string, string>>({});
  const checkpointThreadIds = useMemo(
    () =>
      [...new Set(mainChatTabs.flatMap((tab) => (tab.threadId ? [tab.threadId] : [])))].sort(),
    [mainChatTabs],
  );
  useEffect(() => {
    if (!checkpointThreadIds.length) {
      setTurnCheckpoints({});
      return;
    }
    let stale = false;
    void Promise.all(
      checkpointThreadIds.map((threadId) => window.api.checkpoints.list(threadId).catch(() => [])),
    ).then((recordsByThread) => {
        if (stale) return;
        const byTurn: Record<string, string> = {};
        for (const records of recordsByThread) {
          for (const record of records) {
            if (record.turnId) byTurn[record.turnId] = record.id;
          }
        }
        setTurnCheckpoints(byTurn);
      });
    return () => {
      stale = true;
    };
  }, [checkpointThreadIds, activeTurnId]);

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

  const browserMiddleChats =
    workspaceLayoutMode === 'browser-middle'
      ? browserMiddleChatLayout(
          chatSplitLayout,
          browserMiddleTabKeys(mainChatTabs),
          browserMiddleActiveTabKeys,
        )
      : null;
  const browserMiddleColumns =
    browserMiddleChats?.kind === 'split' && browserMiddleChats.direction === 'row'
      ? browserMiddleChats
      : null;

  const renderChatPane = (
    layout: SplitNode,
    options: { id: string; pathPrefix: string; showTabBar: boolean; side: 'left' | 'right' | null },
  ): React.JSX.Element => {
    const paneTabs = options.side
      ? mainChatTabs.filter((tab) => tab.browserMiddleSide === options.side)
      : mainChatTabs;
    const headerActiveMainChatTabKey = options.side
      ? browserMiddleActiveTabKeys[options.side] ?? paneTabs[0]?.key ?? activeMainChatTabKey
      : activeMainChatTabKey;

    return (
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
      mainChatTabs={paneTabs}
      activeMainChatTabKey={activeMainChatTabKey}
      headerActiveMainChatTabKey={headerActiveMainChatTabKey}
      mainChatTabsDisabled={
        isSending || isGoalUpdating || isRestoring || Boolean(reconcilingMainChatTabKey)
      }
      onSelectMainChatTab={handleSelectMainChatTab}
      onReorderMainChatTabs={handleReorderMainChatTabs}
      onCloseMainChatTab={handleCloseMainChatTab}
      onNewMainChatTab={handleNewMainChatTab}
      paneId={options.id}
      showTabBar={options.showTabBar}
      browserMiddleSide={options.side}
      isBrowserMiddle={workspaceLayoutMode === 'browser-middle'}
      onToggleBrowserMiddle={toggleBrowserMiddleLayout}
      splitLayout={layout}
      onDropTabOnPane={handleDropTabOnSplitPane}
      onCloseSplitPane={handleCloseSplitPane}
      onSetSplitRatio={(path, ratio) => handleSetSplitRatio(`${options.pathPrefix}${path}`, ratio)}
      canSplitForDrop={(targetKey, sourceKey) =>
        canSplitPaneForDrop(chatSplitLayoutRef.current, targetKey, sourceKey)
      }
      onSplitActivePane={handleSplitActivePane}
      canSplitActivePane={
        canSplitPaneAt(chatSplitLayout, headerActiveMainChatTabKey) &&
        mainChatTabs.length < maxMainChatTabs
      }
      items={items}
      itemMeta={itemMeta}
      title={activeThreadTitle}
      status={codexStatus}
      isRestoring={isRestoring}
      threads={threads}
      activeThreadId={activeThreadId}
      activeTurnId={activeTurnId}
      activeGoal={activeGoal}
      isGoalUpdating={isGoalUpdating}
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
      onResumeThread={async (threadId) => {
        await handleResumeThread(threadId);
      }}
      onLoadMoreThreads={loadMoreThreads}
      onPickWorkspace={handlePickWorkspace}
      onSaveGoal={handleSaveGoal}
      onSetGoalStatus={handleSetGoalStatus}
      onClearGoal={handleClearGoal}
      onCompactThread={handleCompactThread}
      agentSessions={agentSessions}
      openAgentKeys={openAgentKeys}
      selectedAgentKey={selectedAgentKey}
      onSelectAgent={setSelectedAgentKey}
      onOpenAgent={handleOpenAgent}
      onMinimizeAgent={handleMinimizeAgent}
      onSetAgentRole={handleSetAgentRole}
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
      onLoadOlderHistory={(tabKey, threadId) => {
        void loadOlderThreadHistory(threadId, tabKey);
      }}
      />
    );
  };

  return (
    <div ref={appRef} className="app-shell">
      <TitleBar />
      <main
        className={`workspace ${isBrowserFullscreen ? 'is-browser-fullscreen' : ''} ${
          browserMiddleColumns ? 'is-browser-middle' : ''
        }`}
        style={{
          gridTemplateColumns: isBrowserFullscreen
            ? '1fr'
            : browserMiddleColumns
              ? `${browserMiddleColumnWidths.left}% ${dividerWidth}px minmax(${minBrowserWidth}px, 1fr) ${dividerWidth}px ${browserMiddleColumnWidths.right}%`
              : `${split}% ${dividerWidth}px 1fr`,
        }}
      >
        {!browserMiddleColumns ? (
          <>
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
          isBrowserMiddle={false}
          onToggleBrowserMiddle={toggleBrowserMiddleLayout}
          splitLayout={chatSplitLayout}
          onDropTabOnPane={handleDropTabOnSplitPane}
          onCloseSplitPane={handleCloseSplitPane}
          onSetSplitRatio={handleSetSplitRatio}
          canSplitForDrop={(targetKey, sourceKey) =>
            canSplitPaneForDrop(chatSplitLayoutRef.current, targetKey, sourceKey)
          }
          onSplitActivePane={handleSplitActivePane}
          canSplitActivePane={
            canSplitPaneAt(chatSplitLayout, activeMainChatTabKey) &&
            mainChatTabs.length < maxMainChatTabs
          }
          items={items}
          itemMeta={itemMeta}
          title={activeThreadTitle}
          status={codexStatus}
          isRestoring={isRestoring}
          threads={threads}
          activeThreadId={activeThreadId}
          activeTurnId={activeTurnId}
          activeGoal={activeGoal}
          isGoalUpdating={isGoalUpdating}
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
          onResumeThread={async (threadId) => {
            await handleResumeThread(threadId);
          }}
          onLoadMoreThreads={loadMoreThreads}
          onPickWorkspace={handlePickWorkspace}
          onSaveGoal={handleSaveGoal}
          onSetGoalStatus={handleSetGoalStatus}
          onClearGoal={handleClearGoal}
          onCompactThread={handleCompactThread}
          agentSessions={agentSessions}
          openAgentKeys={openAgentKeys}
          selectedAgentKey={selectedAgentKey}
          onSelectAgent={setSelectedAgentKey}
          onOpenAgent={handleOpenAgent}
          onMinimizeAgent={handleMinimizeAgent}
          onSetAgentRole={handleSetAgentRole}
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
          onLoadOlderHistory={(tabKey, threadId) => {
            void loadOlderThreadHistory(threadId, tabKey);
          }}
        />
        <div className="split-divider" onPointerDown={handleDividerPointerDown} />
        <BrowserPane
          state={browserState}
          activeTab={activeTab}
          viewHostRef={viewHostRef}
          viewBounds={viewBounds}
          isFullscreen={isBrowserFullscreen}
          onToggleFullscreen={toggleBrowserFullscreen}
        />
          </>
        ) : (
          <>
            {renderChatPane(browserMiddleColumns.first, {
              id: 'main-chat-pane-left',
              pathPrefix: 'f',
              showTabBar: true,
              side: 'left',
            })}
            <div
              className="split-divider"
              onPointerDown={(event) => handleBrowserMiddleDividerPointerDown(event, 'left')}
            />
            <BrowserPane
              state={browserState}
              activeTab={activeTab}
              viewHostRef={viewHostRef}
              viewBounds={viewBounds}
              isFullscreen={isBrowserFullscreen}
              onToggleFullscreen={toggleBrowserFullscreen}
            />
            <div
              className="split-divider"
              onPointerDown={(event) => handleBrowserMiddleDividerPointerDown(event, 'right')}
            />
            {renderChatPane(browserMiddleColumns.second, {
              id: 'main-chat-pane-right',
              pathPrefix: 's',
              showTabBar: true,
              side: 'right',
            })}
          </>
        )}
      </main>
    </div>
  );
}

function TitleBar(): React.JSX.Element {
  const isVerificationInstance = window.api.runtime.instanceRole === 'verification';
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timeoutId: number;

    const refreshClock = () => {
      const next = new Date();
      setNow(next);
      timeoutId = window.setTimeout(
        refreshClock,
        60_000 - (next.getSeconds() * 1_000 + next.getMilliseconds()) + 20,
      );
    };

    const current = new Date();
    timeoutId = window.setTimeout(
      refreshClock,
      60_000 - (current.getSeconds() * 1_000 + current.getMilliseconds()) + 20,
    );

    return () => window.clearTimeout(timeoutId);
  }, []);

  return (
    <header className={`titlebar ${isVerificationInstance ? 'is-verification' : ''}`}>
      <time
        className="titlebar-clock"
        dateTime={now.toISOString()}
        aria-label={titlebarAccessibleFormatter.format(now)}
      >
        <span className="titlebar-clock-time">{titlebarTimeFormatter.format(now)}</span>
        <span className="titlebar-clock-date">{titlebarDateFormatter.format(now)}</span>
      </time>
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


function persistLastThreadId(threadId: string | null): void {
  if (threadId) {
    window.localStorage.setItem(lastThreadStorageKey, threadId);
  } else {
    window.localStorage.removeItem(lastThreadStorageKey);
  }
}
