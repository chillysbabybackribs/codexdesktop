import { app, ipcMain, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import type {
  SessionEvent,
  CodexListThreadTurnsParams,
  CodexInterruptTurnParams,
  AgentRunCancelParams,
  CodexListThreadsParams,
  CodexPluginAppStatusParams,
  CodexPluginInstallParams,
  CodexPluginQueryParams,
  CodexPluginReadParams,
  CodexResumeThreadParams,
  MemoryPersistParams,
  CodexSendMessageParams,
  CodexSetGoalParams,
  CodexStartThreadParams,
  CodexSteerTurnParams,
} from '../../shared/ipc.js';
import { ipcChannels } from '../../shared/ipc.js';
import type { BrowserAgentController } from '../browser/browser-agent.js';
import type { ResearchRunner } from '../browser/research-runner.js';
import { CodexClient } from './codex-client.js';
import type { MemoryStore } from '../memory-store.js';
import type { AttachmentStore } from '../attachment-store.js';
import type { TurnCheckpointStore } from '../turn-checkpoint.js';
import type { SessionProvider } from '../providers/session-provider.js';
import { ClaudeProvider } from '../providers/claude-provider.js';
import { isClaudeModelId } from '../providers/claude-models.js';
import type { ProviderId } from '../../shared/session-protocol/provider.js';
import { SubagentOrchestrator } from '../agents/subagent-orchestrator.js';
import { AgentCompletionCoordinator, AgentRunBridge } from '../agents/agent-run-coordinator.js';
import { decideBrowserUse } from '../browser/browser-use-policy.js';

export type RegisteredSessionProviders = {
  codexClient: CodexClient;
  dispose: () => void;
};

export function registerSessionIpc(
  getWindow: () => BrowserWindow | null,
  browserAgent: BrowserAgentController,
  researchRunner: ResearchRunner,
  memoryStore: MemoryStore,
  attachmentStore: AttachmentStore,
  checkpointStore: TurnCheckpointStore | null = null,
): RegisteredSessionProviders {
  const client = new CodexClient(browserAgent, researchRunner, checkpointStore);
  const claude = new ClaudeProvider(checkpointStore, browserAgent, researchRunner);
  // Provider registry (Claude-prep step 4, populated by the adapter build):
  // routing is by thread-id prefix for existing threads (`claude-…`) and by
  // model-id prefix for new ones, so the ModelPill selection alone decides the
  // runtime and every downstream surface (store, cache, checkpoints, dock)
  // works unchanged.
  const providers = new Map<ProviderId, SessionProvider>([
    [client.id, client],
    [claude.id, claude],
  ]);
  const byThread = (threadId?: string | null): SessionProvider =>
    threadId?.startsWith('claude-') ? claude : client;
  const forNewThread = (model?: string | null): SessionProvider =>
    isClaudeModelId(model) ? claude : client;
  void providers;

  const sendEvent = (event: SessionEvent): void => {
    getWindow()?.webContents.send(ipcChannels.sessionEvent, event);
  };
  const completionCoordinator = new AgentCompletionCoordinator({
    emit: sendEvent,
    statePath: join(app.getPath('userData'), 'agent-completion-outbox.json'),
    resumeParent: async (threadId, prompt) => {
      await byThread(threadId).sendMessage(threadId, prompt);
    },
  });
  const emitEvent = (event: SessionEvent): void => {
    sendEvent(event);
    if (event.type === 'agentRun') completionCoordinator.observeRun(event.run);
  };
  const nativeAgentBridge = new AgentRunBridge(emitEvent);

  // The subagent spawn primitive. It selects the child's runtime the same way
  // a new user thread does (so a codex lead can spawn a claude worker and vice
  // versa) and emits child events + the agentSpawned announcement to the
  // window. Injected into both providers so their spawn_subagent tool calls
  // reach it (the construction cycle — orchestrator needs providers, providers
  // need the orchestrator — is broken by these setters).
  const orchestrator = new SubagentOrchestrator(
    (model) => forNewThread(model),
    emitEvent,
  );
  client.setSubagentSpawner(orchestrator);
  claude.setSubagentSpawner(orchestrator);

  for (const provider of [client, claude]) {
    provider.on('event', (event: SessionEvent) => {
      // Tag child-thread events with parentage so the renderer roster can nest
      // them (a no-op for ordinary main/dock threads) and let the orchestrator
      // settle a pending spawn on the child's terminal event.
      if (event.type === 'agentRun') {
        emitEvent(event);
        return;
      }
      const tagged = orchestrator.tagEvent(event);
      nativeAgentBridge.ingestCodex(tagged);
      completionCoordinator.observeSessionEvent(tagged);
      sendEvent(tagged);
    });
  }

  ipcMain.handle(ipcChannels.sessionGetAuthStatus, () => client.getAuthStatus());
  ipcMain.handle(ipcChannels.sessionListSkills, () => client.listSkills());
  ipcMain.handle(ipcChannels.sessionListModels, async () => {
    const [codexModels, claudeModels] = await Promise.allSettled([
      client.listModels(),
      claude.listModels(),
    ]);
    if (codexModels.status === 'rejected')
      console.warn('failed to list Codex models:', codexModels.reason);
    if (claudeModels.status === 'rejected')
      console.warn('failed to list Claude models:', claudeModels.reason);
    if (codexModels.status === 'rejected' && claudeModels.status === 'rejected')
      throw codexModels.reason;
    return [
      ...(codexModels.status === 'fulfilled' ? codexModels.value : []),
      ...(claudeModels.status === 'fulfilled' ? claudeModels.value : []),
    ];
  });
  ipcMain.handle(ipcChannels.sessionListThreads, (_event, params?: CodexListThreadsParams) =>
    client.listThreads(params),
  );
  ipcMain.handle(ipcChannels.sessionStartThread, (_event, params?: CodexStartThreadParams) =>
    forNewThread(params?.model).startThread(params?.cwd, params?.model),
  );
  ipcMain.handle(ipcChannels.sessionResumeThread, (_event, params: CodexResumeThreadParams) =>
    byThread(params.threadId).resumeThread(params.threadId, params.history),
  );
  ipcMain.handle(ipcChannels.sessionListThreadTurns, (_event, params: CodexListThreadTurnsParams) =>
    byThread(params.threadId).listThreadTurns(params),
  );
  ipcMain.handle(ipcChannels.sessionGetGoal, (_event, threadId: string) =>
    byThread(threadId).getGoal(threadId),
  );
  ipcMain.handle(ipcChannels.sessionSetGoal, (_event, params: CodexSetGoalParams) =>
    byThread(params.threadId).setGoal(params),
  );
  ipcMain.handle(ipcChannels.sessionClearGoal, (_event, threadId: string) =>
    byThread(threadId).clearGoal(threadId),
  );
  ipcMain.handle(ipcChannels.sessionSendMessage, async (_event, params: CodexSendMessageParams) => {
    const attachments = await attachmentStore.verify(params.attachments ?? []);
    const provider = params.threadId ? byThread(params.threadId) : forNewThread(params.model);
    const response = await provider.sendMessage(
      params.threadId,
      params.text,
      params.cwd,
      params.model,
      attachments,
      params.effort,
      params.fastMode === true,
    );
    const browserDecision = decideBrowserUse(params.text);
    sendEvent({
      type: 'browserDecision',
      threadId: response.threadId,
      turnId: response.turn.id,
      provider: provider.id,
      ...browserDecision,
    });
    return response;
  });
  ipcMain.handle(ipcChannels.sessionSteerTurn, (_event, params: CodexSteerTurnParams) =>
    byThread(params.threadId).steerTurn(params.threadId, params.turnId, params.text),
  );
  ipcMain.handle(ipcChannels.sessionInterruptTurn, (_event, params: CodexInterruptTurnParams) => {
    // Cascade first: stop any subagents this turn spawned so a stopped lead
    // never leaves orphan children running.
    orchestrator.interruptChildrenOf(params.threadId, params.turnId);
    return byThread(params.threadId).interruptTurn(params.threadId, params.turnId);
  });
  ipcMain.handle(ipcChannels.sessionCancelAgentRun, (_event, params: AgentRunCancelParams) => {
    if (params.provider === 'codex') {
      return client.stopNativeAgent(
        params.nativeId,
        nativeAgentBridge.codexActiveTurnId(params.nativeId),
      );
    }
    return claude.stopBackgroundTask(params.parentThreadId, params.nativeId);
  });
  ipcMain.handle(ipcChannels.sessionCompactThread, (_event, threadId: string) =>
    byThread(threadId).compactThread(threadId),
  );
  ipcMain.handle(ipcChannels.sessionUnsubscribeThread, (_event, threadId: string) =>
    byThread(threadId).unsubscribeThread(threadId),
  );
  ipcMain.handle(
    ipcChannels.sessionListInstalledPlugins,
    (_event, params?: CodexPluginQueryParams) => client.listInstalledPlugins(params?.cwd),
  );
  ipcMain.handle(ipcChannels.sessionListPlugins, (_event, params?: CodexPluginQueryParams) =>
    client.listPlugins(params?.cwd),
  );
  ipcMain.handle(ipcChannels.sessionReadPlugin, (_event, params: CodexPluginReadParams) =>
    client.readPlugin(params),
  );
  ipcMain.handle(
    ipcChannels.sessionGetPluginAppStatuses,
    (_event, params: CodexPluginAppStatusParams) =>
      client.getPluginAppStatuses(params.appIds, params.forceRefetch),
  );
  ipcMain.handle(ipcChannels.sessionInstallPlugin, (_event, params: CodexPluginInstallParams) =>
    client.installPlugin(params),
  );
  ipcMain.handle(ipcChannels.sessionUninstallPlugin, (_event, pluginId: string) =>
    client.uninstallPlugin(pluginId),
  );
  ipcMain.handle(ipcChannels.memoryPersist, (_event, params: MemoryPersistParams) =>
    memoryStore.persist(params),
  );

  return {
    codexClient: client,
    dispose: () => {
      completionCoordinator.dispose();
      claude.dispose();
      client.dispose();
    },
  };
}
