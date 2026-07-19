import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ChatAttachment } from '../../shared/ipc';
import type { PluginSummary } from '../../shared/session-protocol';
import { Composer } from './Composer';
import { ContextPill, UnsplitIcon } from './ChatControls';
import { ChatItemView, TaskActivityCard } from './ChatTranscript';
import { ThreadScroll } from './ThreadScroll';
import { TraceModal } from './TraceModal';
import { buildTurnTrace, isTurnTrace, type TurnTrace } from './trace';
import {
  FileReviewContext,
  TurnTail,
  type FileReviewActions,
  type ItemMeta,
  type WorkItem,
} from './TaskActivity';
import { ReviewBar, type ReviewChange } from './ReviewBar';
import { buildRows } from './transcript-model';
import { SessionStore, emptySessionState } from './session-store';
import type { MainChatTab } from './main-chat-tabs';
import type { SplitDropZone } from './chat-split';

// Stable fallback snapshot for panes whose tab has no session yet —
// useSyncExternalStore needs referential stability across reads.
const emptyPaneSessionState = emptySessionState();

function MainChatGlyph(): React.JSX.Element {
  return (
    <svg className="main-chat-tab-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4.75A1.75 1.75 0 0 1 5.75 3h4.5A1.75 1.75 0 0 1 12 4.75v3.5A1.75 1.75 0 0 1 10.25 10H7l-2.4 2v-2.15A1.75 1.75 0 0 1 4 8.5V4.75Z" />
    </svg>
  );
}

// One tile of the chat split surface: a complete chat — transcript, review
// affordances, trace modal, and its own composer — bound to a single tab key
// and rendered from that key's slot in the session store (the same slot the
// background notification path already keeps live). The focused pane also
// hosts the workspace-wide dock extras: the agent column and the composer
// context row.
export function ChatPaneView({
  tabKey,
  tab,
  isActive,
  showHeader,
  dropZone,
  sessionStore,
  workspace,
  codexStatus,
  isRestoring,
  isBusy,
  mainChatTabsDisabled,
  turnCheckpoints,
  turnReviews,
  undoneFiles,
  alwaysKeepAll,
  onKeepTurn,
  onSetAlwaysKeepAll,
  onUndoTurnAll,
  onUndoFile,
  onRevertTurn,
  installedPlugins,
  onInstalledPluginsChange,
  onBrowsePlugins,
  onSend,
  onSteer,
  onStop,
  onNewThread,
  onCompactThread,
  onNewAgent,
  onSelectPane,
  onCloseSplitPane,
  onLoadOlderHistory,
  dockExtras,
}: {
  tabKey: string;
  tab: MainChatTab | null;
  isActive: boolean;
  showHeader: boolean;
  dropZone: SplitDropZone | null;
  sessionStore: SessionStore;
  workspace: string | null;
  codexStatus: string;
  isRestoring: boolean;
  isBusy: boolean;
  mainChatTabsDisabled: boolean;
  turnCheckpoints: Record<string, string>;
  turnReviews: Record<string, 'kept' | 'undone'>;
  undoneFiles: Record<string, string[]>;
  alwaysKeepAll: boolean;
  onKeepTurn: (turnId: string) => void;
  onSetAlwaysKeepAll: (enabled: boolean) => void;
  onUndoTurnAll: (turnId: string) => Promise<void>;
  onUndoFile: (turnId: string, path: string) => Promise<void>;
  onRevertTurn: (turnId: string) => void;
  installedPlugins: PluginSummary[];
  onInstalledPluginsChange: (plugins: PluginSummary[]) => void;
  onBrowsePlugins: () => void;
  onSend: (text: string, attachments?: ChatAttachment[]) => Promise<boolean>;
  onSteer: (text: string) => Promise<boolean>;
  onStop: () => Promise<void>;
  onNewThread: () => void;
  onCompactThread: () => Promise<void>;
  onNewAgent: () => void;
  onSelectPane: (key: string) => Promise<boolean>;
  onCloseSplitPane: (tabKey: string) => void;
  onLoadOlderHistory: (tabKey: string, threadId: string) => void;
  dockExtras: { agentColumn: React.ReactNode; composerContext: React.ReactNode } | null;
}): React.JSX.Element {
  const subscribeToPane = useCallback(
    (onStoreChange: () => void) => sessionStore.subscribe(tabKey, onStoreChange),
    [sessionStore, tabKey],
  );
  const readPaneSession = useCallback(
    () => sessionStore.peek(tabKey) ?? emptyPaneSessionState,
    [sessionStore, tabKey],
  );
  const session = useSyncExternalStore(subscribeToPane, readPaneSession);
  const items = session.items;
  const itemMeta = session.itemMeta;
  const turnMeta = session.turnMeta;
  const paneTurnId = session.turnId;
  const paneThreadId = session.threadId;
  const hasContent = items.length > 0;

  const [traceTurnId, setTraceTurnId] = useState<string | null>(null);
  const [storedTrace, setStoredTrace] = useState<TurnTrace | null>(null);
  const traceLoadGenerationRef = useRef(0);

  const { rows, turnWork } = useMemo(
    () => buildRows(items, itemMeta, paneTurnId),
    [items, itemMeta, paneTurnId],
  );

  // Interactions in a background pane focus it first — the action handlers
  // all target the active tab. The pointer-down capture in ChatPane already
  // focused this pane synchronously for clicks; this await is the safety net
  // for keyboard-driven paths and a focus attempt that got locked out.
  const runFocused = async (action: () => void | Promise<void>): Promise<boolean> => {
    if (!isActive && !(await onSelectPane(tabKey))) return false;
    await action();
    return true;
  };

  // Review target: the newest settled turn that edited files, still
  // unreviewed and revertible. Focused pane only — Keep/Undo act on the
  // active tab's checkpoints.
  const reviewTarget = useMemo((): { turnId: string; changes: ReviewChange[] } | null => {
    if (!isActive || paneTurnId) return null;
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
  }, [isActive, rows, turnWork, paneTurnId, turnReviews, turnCheckpoints]);

  // Context for per-file Undo on diff cards. Identity is stable across
  // streaming renders (deps change on turn boundaries and review actions
  // only), so memoized cards are not re-rendered per delta.
  const fileReview = useMemo(
    (): FileReviewActions => ({
      canUndo: (turnId) =>
        Boolean(
          turnId &&
            turnId !== paneTurnId &&
            turnCheckpoints[turnId] &&
            turnReviews[turnId] !== 'undone',
        ),
      isUndone: (turnId, path) =>
        Boolean(
          turnId && (turnReviews[turnId] === 'undone' || undoneFiles[turnId]?.includes(path)),
        ),
      undoFile: (turnId, path) => {
        void (async () => {
          if (isActive || (await onSelectPane(tabKey))) await onUndoFile(turnId, path);
        })();
      },
    }),
    [
      paneTurnId,
      turnCheckpoints,
      turnReviews,
      undoneFiles,
      onUndoFile,
      isActive,
      onSelectPane,
      tabKey,
    ],
  );

  const currentTrace = useMemo(
    () =>
      traceTurnId
        ? buildTurnTrace({
            threadId: paneThreadId,
            threadTitle: session.title,
            turnId: traceTurnId,
            model: tab?.model ?? null,
            workspace,
            items,
            itemMeta,
            meta: turnMeta[traceTurnId],
          })
        : null,
    [traceTurnId, paneThreadId, session.title, tab?.model, workspace, items, itemMeta, turnMeta],
  );
  const trace = storedTrace?.turn.id === traceTurnId ? storedTrace : currentTrace;

  function openTrace(turnId: string): void {
    const generation = ++traceLoadGenerationRef.current;
    setTraceTurnId(turnId);
    setStoredTrace(null);

    if (!paneThreadId || turnMeta[turnId]?.origin !== 'restored') return;

    void window.api.trace.load({ threadId: paneThreadId, turnId }).then(
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
  }, [paneThreadId]);

  // True while the live turn's newest item is an assistant message still
  // receiving deltas — drives the "Writing" tail label and message caret.
  const streamingMessageId = useMemo(() => {
    if (!paneTurnId) {
      return null;
    }
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item.type === 'system' || itemMeta[item.id]?.turnId !== paneTurnId) {
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
  }, [items, itemMeta, paneTurnId]);

  const paneStatus = tab?.status ?? (paneTurnId ? 'working' : 'idle');
  const paneTitle = tab?.title ?? 'Chat';

  return (
    <section
      className={`chat-pane-view ${hasContent ? 'is-thread' : 'is-empty'} ${
        isActive ? 'is-focused' : ''
      } ${showHeader ? 'has-header' : ''}`}
      data-split-pane-key={tabKey}
      aria-label={paneTitle}
    >
      {showHeader ? (
        <header className="chat-pane-view-header">
          <MainChatGlyph />
          <span className="chat-pane-view-title" title={paneTitle}>
            {paneTitle}
          </span>
          {paneStatus === 'working' ? (
            <span className="main-chat-tab-spinner" aria-label="Running" />
          ) : paneStatus === 'attention' ? (
            <span className="main-chat-tab-attention" aria-label="Awaiting your attention" />
          ) : null}
          <span className="chat-pane-view-header-spacer" />
          <button
            type="button"
            className="chat-pane-view-unsplit"
            aria-label={`Close split for ${paneTitle}`}
            title="Close split — the chat stays open as a tab"
            onClick={() => onCloseSplitPane(tabKey)}
          >
            <UnsplitIcon />
          </button>
        </header>
      ) : null}
      <FileReviewContext.Provider value={fileReview}>
        <ThreadScroll
          id={`main-chat-panel-${tabKey}`}
          labelledBy={`main-chat-tab-${tabKey}`}
          scrollKey={tabKey}
          resetKey={paneThreadId}
          activeTurnId={paneTurnId}
          dependencies={[items, itemMeta, paneTurnId]}
          onReachStart={
            isActive && paneThreadId ? () => onLoadOlderHistory(tabKey, paneThreadId) : undefined
          }
        >
          {isActive && isRestoring ? (
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
                  live={Boolean(paneTurnId) && row.turnId === paneTurnId}
                  workspace={workspace}
                />
              );
            }
            if (row.kind === 'tail') {
              return (
                <TurnTail
                  key={row.id}
                  live={row.turnId === paneTurnId}
                  items={turnWork.get(row.turnId) ?? []}
                  itemMeta={itemMeta}
                  meta={turnMeta[row.turnId]}
                  streamingMessage={Boolean(streamingMessageId) && row.turnId === paneTurnId}
                  onOpenTrace={() => openTrace(row.turnId)}
                  onRevert={
                    turnCheckpoints[row.turnId]
                      ? () => void runFocused(() => onRevertTurn(row.turnId))
                      : undefined
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
        className={`composer-dock ${hasContent ? 'is-docked' : 'is-centered'} ${
          dockExtras?.agentColumn ? 'has-agents' : ''
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
        {dockExtras?.agentColumn}
        {dockExtras?.composerContext}
        <Composer
          draftKey={tabKey}
          docked={hasContent}
          workspace={workspace}
          installedPlugins={installedPlugins}
          onInstalledPluginsChange={onInstalledPluginsChange}
          onBrowsePlugins={onBrowsePlugins}
          isLoading={isActive && (isRestoring || (isBusy && !paneTurnId))}
          isTurnActive={Boolean(paneTurnId)}
          status={
            isActive
              ? isRestoring
                ? 'Restoring conversation'
                : paneTurnId
                  ? 'Working'
                  : codexStatus
              : paneTurnId
                ? 'Working'
                : 'idle'
          }
          onSend={async (text, attachments) => {
            if (!isActive && !(await onSelectPane(tabKey))) return false;
            return onSend(text, attachments);
          }}
          onSteer={async (text) => {
            if (!isActive && !(await onSelectPane(tabKey))) return false;
            return onSteer(text);
          }}
          onStop={async () => {
            await runFocused(onStop);
          }}
          onNewThread={() => void runFocused(onNewThread)}
          onNewAgent={() => void runFocused(onNewAgent)}
          footerTrailing={
            <ContextPill
              usage={session.contextUsage}
              disabled={Boolean(paneTurnId) || mainChatTabsDisabled}
              compacting={session.isCompacting}
              onCompact={async () => {
                await runFocused(onCompactThread);
              }}
            />
          }
        />
      </div>
      {dropZone ? (
        <div className={`chat-split-drop-overlay is-${dropZone}`} aria-hidden="true" />
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
    </section>
  );
}
