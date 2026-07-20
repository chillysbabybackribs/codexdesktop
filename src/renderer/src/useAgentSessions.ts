import { useEffect, useRef, useState } from 'react';
import type { ServerNotification } from '../../shared/session-protocol';
import type { TurnError } from '../../shared/session-protocol';
import type { ReasoningEffort } from '../../shared/session-protocol';
import {
  createReviewerSession,
  createWorkerSession,
  findAgentSessionByThread,
  reviewerTitle,
  serializeAgentDock,
  updateAgentSession,
  type AgentLiteMessage,
  type AgentSession,
} from './agent-session-model';
import { buildOptimisticUserMessage } from './optimistic-user-message';
import { upsertMany } from './transcript-model';
import {
  emptySessionState,
  reduceSessionNotification,
  type SessionRenderState,
  type SessionStore,
} from './session-store';
import { liteMessagesFromItems } from './agent-dock-restore';

export function useAgentSessions(
  storageKey: string,
  sessionStore: SessionStore,
  recovery: {
    schedule: (key: string, turnId: string, error: TurnError | null) => void;
    cancel: (key: string) => void;
  },
  // Cross-family reviewer default, computed against the CURRENT main-chat
  // model at the moment an agent is born or armed (never applied over an
  // explicit user choice). Returns null when only one provider is configured
  // — a null agent model follows the main chat's model.
  deriveReviewerModel: () => string | null,
): {
  agentSessions: AgentSession[];
  openAgentKeys: string[];
  selectedAgentKey: string | null;
  setOpenAgentKeys: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedAgentKey: React.Dispatch<React.SetStateAction<string | null>>;
  agentSessionsRef: React.MutableRefObject<AgentSession[]>;
  agentStartQueueRef: React.MutableRefObject<string[]>;
  agentCounterRef: React.MutableRefObject<number>;
  agentDockRestoredRef: React.MutableRefObject<boolean>;
  updateAgentSessions: (update: (sessions: AgentSession[]) => AgentSession[]) => void;
  patchAgentSession: (key: string, update: (session: AgentSession) => AgentSession) => void;
  appendAgentMessage: (key: string, message: AgentLiteMessage) => void;
  appendAgentMessageOnce: (key: string, message: AgentLiteMessage) => void;
  setAgentSessionRender: (key: string, state: SessionRenderState) => void;
  resetAgentSessionRender: (key: string, title: string) => void;
  removeAgentSessionRender: (key: string) => void;
  backgroundSessionForThread: (threadId: string) => AgentSession | null;
  handleAgentNotification: (session: AgentSession, notification: ServerNotification) => void;
  handleNewAgent: (mainChatTabKey: string) => void;
  handleSpawnedAgent: (spawn: {
    agentKey: string;
    parentAgentKey: string | null;
    mainChatTabKey: string | null;
    title: string;
    model: string | null;
  }) => void;
  handleOpenAgent: (key: string) => void;
  handleMinimizeAgent: (key: string) => void;
  handleToggleWatchAgent: (key: string) => void;
  handleToggleAuditAgent: (key: string) => void;
  handleToggleReportAgent: (key: string) => void;
  handleDecideSendPolicy: (key: string, policy: 'always' | 'keep') => void;
  handleSetAgentModel: (key: string, model: string, effort?: ReasoningEffort | null) => void;
} {
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [openAgentKeys, setOpenAgentKeys] = useState<string[]>([]);
  const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(null);
  const agentSessionsRef = useRef<AgentSession[]>([]);
  const agentDeltaBufferRef = useRef<Map<string, ServerNotification[]>>(new Map());
  const agentDeltaTimerRef = useRef<number | null>(null);
  const agentDockPersistTimerRef = useRef<number | null>(null);
  const lastAgentDockSnapshotRef = useRef<string | null>(null);
  const agentStartQueueRef = useRef<string[]>([]);
  const agentCounterRef = useRef(2);
  const agentDockRestoredRef = useRef(false);

  function updateAgentSessions(update: (sessions: AgentSession[]) => AgentSession[]): void {
    agentSessionsRef.current = update(agentSessionsRef.current);
    setAgentSessions(agentSessionsRef.current);
  }

  function patchAgentSession(key: string, update: (session: AgentSession) => AgentSession): void {
    let previous: AgentSession | null = null;
    let next: AgentSession | null = null;
    updateAgentSessions((sessions) =>
      updateAgentSession(sessions, key, (session) => {
        previous = session;
        next = update(session);
        return next;
      }),
    );
    if (!previous || !next) return;
    sessionStore.update(key, (state) => {
      const messagesChanged = previous!.messages !== next!.messages;
      return {
        ...state,
        threadId: next!.threadId,
        title: next!.title,
        turnId: next!.turnId,
        reasoningEffort: next!.reasoningEffort,
        contextUsage: next!.contextUsage,
        isCompacting: next!.isCompacting,
        ...(messagesChanged
          ? {
              items: next!.messages.map((message) =>
                message.role === 'user'
                  ? buildOptimisticUserMessage(message.id, message.text, message.attachments ?? [])
                  : {
                      type: 'agentMessage' as const,
                      id: message.id,
                      text: message.text,
                      phase: null,
                      memoryCitation: null,
                    },
              ),
            }
          : {}),
      };
    });
  }

  function syncAgentSession(key: string, status?: AgentSession['status']): void {
    const state = sessionStore.get(key);
    updateAgentSessions((sessions) =>
      updateAgentSession(sessions, key, (session) => ({
        ...session,
        threadId: state.threadId ?? session.threadId,
        turnId: state.turnId,
        status: status ?? (state.turnId ? 'working' : session.status),
        messages: liteMessagesFromItems(state.items),
        reasoningEffort: state.reasoningEffort ?? session.reasoningEffort,
        contextUsage: state.contextUsage,
        isCompacting: state.isCompacting,
      })),
    );
  }

  function appendAgentMessage(key: string, message: AgentLiteMessage, dedupe = false): void {
    sessionStore.update(key, (state) => {
      if (dedupe && state.items.some((item) => item.id === message.id)) return state;
      const item =
        message.role === 'user'
          ? buildOptimisticUserMessage(message.id, message.text, message.attachments ?? [])
          : {
              type: 'agentMessage' as const,
              id: message.id,
              text: message.text,
              phase: null,
              memoryCitation: null,
            };
      return { ...state, items: upsertMany(state.items, [item]) };
    });
    syncAgentSession(key);
  }

  function appendAgentMessageOnce(key: string, message: AgentLiteMessage): void {
    appendAgentMessage(key, message, true);
  }

  function setAgentSessionRender(key: string, state: SessionRenderState): void {
    sessionStore.set(key, state);
    syncAgentSession(key);
  }

  function resetAgentSessionRender(key: string, title: string): void {
    setAgentSessionRender(key, emptySessionState({ title }));
  }

  function removeAgentSessionRender(key: string): void {
    sessionStore.remove(key);
  }

  function backgroundSessionForThread(threadId: string): AgentSession | null {
    return findAgentSessionByThread(agentSessionsRef.current, threadId);
  }

  function applyAgentNotifications(key: string, notifications: ServerNotification[]): void {
    const session = agentSessionsRef.current.find((candidate) => candidate.key === key);
    if (!session) return;
    sessionStore.update(key, (state) =>
      notifications.reduce(
        (current, notification) =>
          reduceSessionNotification(current, notification, {
            atMs: Date.now(),
            fallbackModel: session.model,
            workspace: null,
          }),
        state,
      ),
    );
    const terminal = notifications.at(-1);
    syncAgentSession(
      key,
      terminal?.method === 'turn/started'
        ? 'working'
        : terminal?.method === 'turn/completed' ||
            (terminal?.method === 'error' && !terminal.params.willRetry)
          ? 'done'
          : undefined,
    );
  }

  function applyAgentNotification(key: string, notification: ServerNotification): void {
    applyAgentNotifications(key, [notification]);
  }

  function flushAgentDeltas(): void {
    if (agentDeltaTimerRef.current !== null) {
      window.cancelAnimationFrame(agentDeltaTimerRef.current);
      agentDeltaTimerRef.current = null;
    }
    const buffer = agentDeltaBufferRef.current;
    if (!buffer.size) return;
    agentDeltaBufferRef.current = new Map();
    for (const [key, notifications] of buffer) applyAgentNotifications(key, notifications);
  }

  function enqueueAgentDelta(key: string, notification: ServerNotification): void {
    let pending = agentDeltaBufferRef.current.get(key);
    if (!pending) {
      pending = [];
      agentDeltaBufferRef.current.set(key, pending);
    }
    pending.push(notification);
    if (agentDeltaTimerRef.current === null) {
      agentDeltaTimerRef.current = window.requestAnimationFrame(flushAgentDeltas);
    }
  }

  function handleAgentNotification(session: AgentSession, notification: ServerNotification): void {
    if (notification.method !== 'item/agentMessage/delta' && agentDeltaBufferRef.current.size > 0) {
      flushAgentDeltas();
    }

    if (notification.method === 'item/agentMessage/delta') {
      enqueueAgentDelta(session.key, notification);
      return;
    }

    applyAgentNotification(session.key, notification);
    switch (notification.method) {
      case 'turn/completed': {
        const turn = notification.params.turn;
        void window.api.notifications.backgroundTurn({
          threadId: notification.params.threadId,
          title: session.title || 'Background agent',
          status: turn.status === 'failed' ? 'failed' : 'completed',
          message: turn.error?.message ?? null,
        });
        if (turn.error?.message) {
          appendAgentMessageOnce(session.key, {
            id: `error-${turn.id}`,
            role: 'assistant',
            text: `⚠ ${turn.error.message}`,
          });
        }
        if (turn.status === 'failed') recovery.schedule(session.key, turn.id, turn.error);
        else recovery.cancel(session.key);
        return;
      }
      case 'error': {
        const { turnId, error, willRetry } = notification.params;
        if (willRetry) return;
        appendAgentMessageOnce(session.key, {
          id: `error-${turnId}`,
          role: 'assistant',
          text: `⚠ ${error.message}`,
        });
        recovery.schedule(session.key, turnId, error);
        return;
      }
      default:
        return;
    }
  }

  // Born a reviewer: a fresh dock agent opens straight into audit standby
  // with a cross-family model pre-derived — zero configuration. The counter
  // survives for restore compatibility but no longer names new agents.
  function handleNewAgent(mainChatTabKey: string): void {
    const key = crypto.randomUUID();
    const title = reviewerTitle(agentSessionsRef.current, mainChatTabKey);
    agentCounterRef.current++;
    updateAgentSessions((sessions) => [
      ...sessions,
      createReviewerSession(key, title, mainChatTabKey, deriveReviewerModel()),
    ]);
    sessionStore.set(key, emptySessionState({ title }));
    setOpenAgentKeys((current) => [...current, key]);
    setSelectedAgentKey(key);
  }

  // A subagent the model spawned via spawn_subagent. The orchestrator already
  // minted the agentKey in main and announced it here BEFORE any of the child's
  // turn events, so we create the session under that exact key — subsequent
  // tagged notifications (which carry the same agentKey / child threadId) then
  // route to it through the normal agent path. Idempotent: a duplicate
  // announcement (e.g. a resent event) is ignored.
  function handleSpawnedAgent(spawn: {
    agentKey: string;
    parentAgentKey: string | null;
    mainChatTabKey: string | null;
    title: string;
    model: string | null;
  }): void {
    if (agentSessionsRef.current.some((session) => session.key === spawn.agentKey)) return;
    updateAgentSessions((sessions) => [
      ...sessions,
      createWorkerSession(
        spawn.agentKey,
        spawn.title,
        spawn.mainChatTabKey,
        spawn.parentAgentKey ?? spawn.agentKey,
        null,
        spawn.model,
      ),
    ]);
    sessionStore.set(spawn.agentKey, emptySessionState({ title: spawn.title }));
    // Open it so the worker's stream is visible in the dock as it runs.
    setOpenAgentKeys((current) => (current.includes(spawn.agentKey) ? current : [...current, spawn.agentKey]));
  }

  function handleOpenAgent(key: string): void {
    setOpenAgentKeys((current) => (current.includes(key) ? current : [...current, key]));
  }

  function handleMinimizeAgent(key: string): void {
    setOpenAgentKeys((current) => current.filter((candidate) => candidate !== key));
  }

  function handleToggleWatchAgent(key: string): void {
    patchAgentSession(key, (session) => ({ ...session, watchesMain: !session.watchesMain }));
  }

  function handleToggleAuditAgent(key: string): void {
    patchAgentSession(key, (session) => ({
      ...session,
      auditsMain: !session.auditsMain,
      // Feedback requires an audit to exist: disabling audit disables it.
      reportsToMain: session.auditsMain ? false : session.reportsToMain,
      lastAuditNote: null,
      // The headline pairing: arming audit on a session that has not chosen a
      // runtime yet derives a model from a different family than the main
      // chat's current model — cross-provider review whichever direction the
      // pairing runs. Explicit choices are never overridden.
      model:
        !session.auditsMain && !session.threadId && !session.model
          ? deriveReviewerModel()
          : session.model,
    }));
  }

  function handleToggleReportAgent(key: string): void {
    patchAgentSession(key, (session) => ({
      ...session,
      reportsToMain: !session.reportsToMain,
      // An explicit toggle IS the send-policy decision — the first-flag
      // prompt never needs to ask this agent.
      sendPolicyDecided: true,
      // Feedback without an audit is meaningless: enabling it arms audit mode
      // too (with the same cross-provider model default).
      auditsMain: session.reportsToMain ? session.auditsMain : true,
      lastAuditNote: null,
      model:
        !session.reportsToMain && !session.auditsMain && !session.threadId && !session.model
          ? deriveReviewerModel()
          : session.model,
    }));
  }

  // The first-flag decision, made with a real finding on screen: "always"
  // arms auto-send from here on, "keep" leaves reports in the dock (the
  // manual flag badge still works either way).
  function handleDecideSendPolicy(key: string, policy: 'always' | 'keep'): void {
    patchAgentSession(key, (session) => ({
      ...session,
      sendPolicyDecided: true,
      reportsToMain: policy === 'always' ? true : session.reportsToMain,
      auditsMain: policy === 'always' ? true : session.auditsMain,
    }));
  }

  function handleSetAgentModel(key: string, model: string, effort?: ReasoningEffort | null): void {
    patchAgentSession(key, (session) => ({
      ...session,
      model,
      reasoningEffort: effort ?? null,
    }));
  }

  useEffect(
    () => () => {
      if (agentDeltaTimerRef.current !== null)
        window.cancelAnimationFrame(agentDeltaTimerRef.current);
      if (agentDockPersistTimerRef.current !== null)
        window.clearTimeout(agentDockPersistTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!agentDockRestoredRef.current) return;
    const snapshot = serializeAgentDock(
      agentCounterRef.current,
      agentSessions,
      openAgentKeys,
      selectedAgentKey,
    );
    if (snapshot === lastAgentDockSnapshotRef.current) return;
    lastAgentDockSnapshotRef.current = snapshot;

    if (agentDockPersistTimerRef.current !== null) {
      window.clearTimeout(agentDockPersistTimerRef.current);
    }
    agentDockPersistTimerRef.current = window.setTimeout(() => {
      agentDockPersistTimerRef.current = null;
      window.localStorage.setItem(storageKey, snapshot);
    }, 250);
  }, [agentSessions, openAgentKeys, selectedAgentKey, storageKey]);

  return {
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
    handleToggleWatchAgent,
    handleToggleAuditAgent,
    handleToggleReportAgent,
    handleDecideSendPolicy,
    handleSetAgentModel,
  };
}
