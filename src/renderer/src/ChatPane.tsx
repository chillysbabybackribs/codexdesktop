import { type PointerEvent, useMemo, useState } from 'react';
import type { ChatAttachment } from '../../shared/ipc';
import type {
  Model,
  PluginSummary,
  ReasoningEffort,
  Thread,
  ThreadGoal,
  ThreadGoalStatus,
} from '../../shared/session-protocol';
import { AgentColumn, AgentTabStrip, type AgentSession } from './AgentDock';
import { NewAgentIcon } from './Composer';
import { ChatPaneView } from './ChatPaneView';
import { SettingsModal, WorkspacePill } from './ChatControls';
import { MainChatTabStrip } from './MainChatTabStrip';
import { EffortSelector, ModelSelector } from './ModelPill';
import { PluginBrowserView } from './PluginBrowser';
import { type ItemMeta } from './TaskActivity';
import { liveTurnGlance } from './audit-trigger';
import { agentSessionsForMainChatTab } from './agent-session-model';
import type { MainChatTab } from './main-chat-tabs';
import { SessionStore } from './session-store';
import type { ChatItem } from './transcript-model';
import {
  countSplitPanes,
  type SplitDirection,
  type SplitDropZone,
  type SplitNode,
} from './chat-split';

export function ChatPane({
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
  splitLayout,
  onDropTabOnPane,
  onCloseSplitPane,
  onSetSplitRatio,
  canSplitForDrop,
  onSplitActivePane,
  canSplitActivePane,
  items,
  itemMeta,
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
  splitLayout: SplitNode;
  onDropTabOnPane: (sourceKey: string, targetKey: string, zone: SplitDropZone) => void;
  onCloseSplitPane: (tabKey: string) => void;
  onSetSplitRatio: (path: string, ratio: number) => void;
  canSplitForDrop: (targetKey: string, sourceKey: string) => boolean;
  onSplitActivePane: (direction: 'right' | 'down') => boolean;
  canSplitActivePane: boolean;
  items: ChatItem[];
  itemMeta: Record<string, ItemMeta>;
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
  onLoadOlderHistory: (tabKey: string, threadId: string) => void;
}): React.JSX.Element {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPluginBrowserOpen, setIsPluginBrowserOpen] = useState(false);
  const [installedPlugins, setInstalledPlugins] = useState<PluginSummary[]>([]);
  // Which region the user is working in: the main chat (default) or the agent
  // column. Drives the dim/unfocus treatment on agent windows via CSS.
  const [isMainFocused, setIsMainFocused] = useState(true);
  // Live pane drop target while a chat tab is dragged over the split surface.
  const [paneDropTarget, setPaneDropTarget] = useState<{
    tabKey: string;
    zone: SplitDropZone;
  } | null>(null);

  // Live glance at the in-flight turn for auditor dock cards ("watching" POV).
  // Cheap passes over state this pane already re-renders on.
  const liveMainTurn = useMemo(
    () => (activeTurnId ? liveTurnGlance(items, itemMeta, activeTurnId) : null),
    [items, itemMeta, activeTurnId],
  );

  const activeAgentSessions = agentSessionsForMainChatTab(agentSessions, activeMainChatTabKey);
  const openAgentSessions = activeAgentSessions.filter((session) =>
    openAgentKeys.includes(session.key),
  );
  const selectedActiveAgentKey = openAgentSessions.some((session) => session.key === selectedAgentKey)
    ? selectedAgentKey
    : openAgentSessions[0]?.key ?? null;

  const openPluginBrowser = (): void => {
    setIsSettingsOpen(false);
    setIsPluginBrowserOpen(true);
  };

  const closePluginBrowser = (): void => {
    setIsPluginBrowserOpen(false);
    requestAnimationFrame(() => {
      const scoped = document.querySelector<HTMLTextAreaElement>(
        `[data-split-pane-key="${CSS.escape(activeMainChatTabKey)}"] .composer textarea`,
      );
      (scoped ?? document.querySelector<HTMLTextAreaElement>('.composer textarea'))?.focus();
    });
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

  // Any interaction inside a background pane focuses it — the split-surface
  // equivalent of clicking that chat's tab. updateMainChatTabs applies
  // eagerly, so by the time the actual click handler runs, "active" already
  // means this pane.
  const focusPaneFromEvent = (target: EventTarget | null): void => {
    if (!(target instanceof HTMLElement)) return;
    const key = target.closest<HTMLElement>('[data-split-pane-key]')?.dataset.splitPaneKey;
    if (key && key !== activeMainChatTabKey) void onSelectMainChatTab(key);
  };

  const beginSplitRatioDrag = (
    event: PointerEvent<HTMLDivElement>,
    path: string,
    direction: SplitDirection,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const handleMove = (moveEvent: globalThis.PointerEvent): void => {
      const ratio =
        direction === 'row'
          ? (moveEvent.clientX - rect.left) / Math.max(1, rect.width)
          : (moveEvent.clientY - rect.top) / Math.max(1, rect.height);
      onSetSplitRatio(path, ratio);
    };
    const finish = (): void => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  };

  const multiPane = countSplitPanes(splitLayout) > 1;

  // The agent column belongs to the focused workspace. Model selection does
  // not: each visible chat owns a model and reasoning choice, so its composer
  // must retain that control even when it is not the focused pane.
  const activeAgentColumn = openAgentSessions.length ? (
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
  ) : null;

  const selectPaneModel = async (key: string, model: string): Promise<void> => {
    if (!(await onSelectMainChatTab(key))) return;
    onSelectModel(model);
  };

  const selectPaneModelEffort = async (
    key: string,
    model: string,
    effort: ReasoningEffort,
  ): Promise<void> => {
    if (!(await onSelectMainChatTab(key))) return;
    onSelectModelEffort(model, effort);
  };

  const paneComposerModelContext = (tabKey: string, tab: MainChatTab | null) =>
    models.length ? (
      <div className="composer-context composer-model-context">
        <div className="model-controls">
          <ModelSelector
            models={models}
            selectedModel={tab?.model ?? null}
            onSelectModel={(model) => void selectPaneModel(tabKey, model)}
            fastMode={fastMode}
            onToggleFastMode={onSetFastMode}
          />
          <EffortSelector
            models={models}
            selectedModel={tab?.model ?? null}
            selectedEffort={
              (tab?.reasoningEffort as ReasoningEffort | null | undefined) ?? null
            }
            onSelectEffort={(model, effort) =>
              void selectPaneModelEffort(tabKey, model, effort)
            }
          />
        </div>
      </div>
    ) : null;

  // Composer controls belong to the visible pane, not the focused pane. Keeping
  // this tree stable prevents focus changes from changing the lower composer
  // strip, while still routing agent actions to the correct chat.
  const paneComposerFooterContext = (tabKey: string) => {
    const paneAgentSessions = agentSessionsForMainChatTab(agentSessions, tabKey);

    return (
      <div className="composer-context">
        <WorkspacePill workspace={workspace} onPickWorkspace={onPickWorkspace} />
        <AgentTabStrip
          sessions={paneAgentSessions}
          openKeys={openAgentKeys}
          onFocus={(agentKey) => {
            void onSelectMainChatTab(tabKey).then((selected) => {
              if (selected) focusAgent(agentKey);
            });
          }}
        />
        <button
          type="button"
          className="composer-new-agent-button"
          aria-label="New agent"
          title="New agent"
          onClick={() => onNewAgent(tabKey)}
        >
          <NewAgentIcon />
        </button>
      </div>
    );
  };

  /* The focused pane also carries the workspace-level reviewer column. */
  const activeDockExtras = {
    agentColumn: activeAgentColumn,
  };

  const renderSplitNode = (node: SplitNode, path: string): React.JSX.Element => {
    if (node.kind === 'pane') {
      const tab = mainChatTabs.find((candidate) => candidate.key === node.tabKey) ?? null;
      const isActivePane = node.tabKey === activeMainChatTabKey;
      return (
        <ChatPaneView
          key={node.tabKey}
          tabKey={node.tabKey}
          tab={tab}
          isActive={isActivePane}
          showHeader={multiPane}
          dropZone={paneDropTarget?.tabKey === node.tabKey ? paneDropTarget.zone : null}
          sessionStore={agentSessionStore}
          workspace={workspace}
          models={models}
          codexStatus={status}
          isRestoring={isRestoring}
          isBusy={isBusy}
          mainChatTabsDisabled={mainChatTabsDisabled}
          turnCheckpoints={turnCheckpoints}
          turnReviews={turnReviews}
          undoneFiles={undoneFiles}
          alwaysKeepAll={alwaysKeepAll}
          onKeepTurn={onKeepTurn}
          onSetAlwaysKeepAll={onSetAlwaysKeepAll}
          onUndoTurnAll={onUndoTurnAll}
          onUndoFile={onUndoFile}
          onRevertTurn={onRevertTurn}
          installedPlugins={installedPlugins}
          onInstalledPluginsChange={setInstalledPlugins}
          onBrowsePlugins={openPluginBrowser}
          onSend={onSend}
          onSteer={onSteer}
          onStop={onStop}
          onNewThread={onNewThread}
          onCompactThread={onCompactThread}
          onSelectPane={onSelectMainChatTab}
          onCloseSplitPane={onCloseSplitPane}
          onLoadOlderHistory={onLoadOlderHistory}
          dockExtras={{
            agentColumn: isActivePane ? activeDockExtras.agentColumn : null,
            composerHeaderContext: paneComposerModelContext(node.tabKey, tab),
            composerFooterContext: paneComposerFooterContext(node.tabKey),
          }}
        />
      );
    }
    const style =
      node.direction === 'row'
        ? {
            gridTemplateColumns: `minmax(160px, ${node.ratio}fr) 5px minmax(160px, ${
              1 - node.ratio
            }fr)`,
          }
        : {
            gridTemplateRows: `minmax(120px, ${node.ratio}fr) 5px minmax(120px, ${
              1 - node.ratio
            }fr)`,
          };
    return (
      <div key={path || 'root'} className={`chat-split is-${node.direction}`} style={style}>
        {renderSplitNode(node.first, `${path}f`)}
        <div
          className="chat-split-divider"
          role="separator"
          aria-orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
          onPointerDown={(event) => beginSplitRatioDrag(event, path, node.direction)}
        />
        {renderSplitNode(node.second, `${path}s`)}
      </div>
    );
  };

  return (
    <section
      id="main-chat-pane"
      className={`chat-pane ${isPluginBrowserOpen ? 'is-plugin-browser' : hasThreadContent ? 'is-thread' : 'is-empty'} ${isRestoring ? 'is-hydrating' : ''} ${
        !isPluginBrowserOpen && openAgentSessions.length ? 'has-agents' : ''
      } ${isMainFocused ? 'is-main-focused' : ''}`}
      aria-busy={isRestoring}
      onPointerDownCapture={(event) => {
        updateFocusRegion(event.target);
        focusPaneFromEvent(event.target);
      }}
      onFocusCapture={(event) => {
        updateFocusRegion(event.target);
        focusPaneFromEvent(event.target);
      }}
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
          onPaneDragUpdate={setPaneDropTarget}
          onDropOnPane={onDropTabOnPane}
          canSplitForDrop={canSplitForDrop}
          onSplitActivePane={onSplitActivePane}
          canSplitActivePane={canSplitActivePane}
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

        <div className="chat-split-root">{renderSplitNode(splitLayout, '')}</div>

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
      </div>
    </section>
  );
}
