import { ipcMain, type BrowserWindow } from 'electron'
import type {
  SessionEvent,
  CodexListThreadTurnsParams,
  CodexInterruptTurnParams,
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
  CodexSteerTurnParams
} from '../../shared/ipc.js'
import { ipcChannels } from '../../shared/ipc.js'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import { CodexClient } from './codex-client.js'
import type { MemoryStore } from '../memory-store.js'
import type { AttachmentStore } from '../attachment-store.js'
import type { TurnCheckpointStore } from '../turn-checkpoint.js'
import type { SessionProvider } from '../providers/session-provider.js'
import { ClaudeProvider } from '../providers/claude-provider.js'
import type { ProviderId } from '../../shared/session-protocol/provider.js'

export function registerSessionIpc(
  getWindow: () => BrowserWindow | null,
  browserAgent: BrowserAgentController,
  researchRunner: ResearchRunner,
  memoryStore: MemoryStore,
  attachmentStore: AttachmentStore,
  checkpointStore: TurnCheckpointStore | null = null
): CodexClient {
  const client = new CodexClient(browserAgent, researchRunner, checkpointStore)
  const claude = new ClaudeProvider(checkpointStore, browserAgent, researchRunner)
  // Provider registry (Claude-prep step 4, populated by the adapter build):
  // routing is by thread-id prefix for existing threads (`claude-…`) and by
  // model-id prefix for new ones, so the ModelPill selection alone decides the
  // runtime and every downstream surface (store, cache, checkpoints, dock)
  // works unchanged.
  const providers = new Map<ProviderId, SessionProvider>([
    [client.id, client],
    [claude.id, claude]
  ])
  const byThread = (threadId?: string | null): SessionProvider =>
    threadId?.startsWith('claude-') ? claude : client
  const forNewThread = (model?: string | null): SessionProvider =>
    model?.startsWith('claude') ? claude : client
  void providers

  for (const provider of [client, claude]) {
    provider.on('event', (event: SessionEvent) => {
      getWindow()?.webContents.send(ipcChannels.sessionEvent, event)
    })
  }

  ipcMain.handle(ipcChannels.sessionGetAuthStatus, () => client.getAuthStatus())
  ipcMain.handle(ipcChannels.sessionListModels, async () => {
    const [codexModels, claudeModels] = await Promise.all([client.listModels(), claude.listModels()])
    return [...codexModels, ...claudeModels]
  })
  ipcMain.handle(ipcChannels.sessionListThreads, (_event, params?: CodexListThreadsParams) =>
    client.listThreads(params)
  )
  ipcMain.handle(ipcChannels.sessionStartThread, (_event, params?: CodexStartThreadParams) =>
    forNewThread(params?.model).startThread(params?.cwd, params?.model)
  )
  ipcMain.handle(ipcChannels.sessionResumeThread, (_event, params: CodexResumeThreadParams) =>
    byThread(params.threadId).resumeThread(params.threadId, params.history)
  )
  ipcMain.handle(ipcChannels.sessionListThreadTurns, (_event, params: CodexListThreadTurnsParams) =>
    byThread(params.threadId).listThreadTurns(params)
  )
  ipcMain.handle(ipcChannels.sessionGetGoal, (_event, threadId: string) => byThread(threadId).getGoal(threadId))
  ipcMain.handle(ipcChannels.sessionSetGoal, (_event, params: CodexSetGoalParams) => byThread(params.threadId).setGoal(params))
  ipcMain.handle(ipcChannels.sessionClearGoal, (_event, threadId: string) => byThread(threadId).clearGoal(threadId))
  ipcMain.handle(ipcChannels.sessionSendMessage, async (_event, params: CodexSendMessageParams) => {
    const attachments = await attachmentStore.verify(params.attachments ?? [])
    const provider = params.threadId ? byThread(params.threadId) : forNewThread(params.model)
    return provider.sendMessage(
      params.threadId,
      params.text,
      params.cwd,
      params.model,
      attachments,
      params.effort,
      params.fastMode === true
    )
  })
  ipcMain.handle(ipcChannels.sessionSteerTurn, (_event, params: CodexSteerTurnParams) =>
    byThread(params.threadId).steerTurn(params.threadId, params.turnId, params.text)
  )
  ipcMain.handle(ipcChannels.sessionInterruptTurn, (_event, params: CodexInterruptTurnParams) =>
    byThread(params.threadId).interruptTurn(params.threadId, params.turnId)
  )
  ipcMain.handle(ipcChannels.sessionCompactThread, (_event, threadId: string) =>
    byThread(threadId).compactThread(threadId)
  )
  ipcMain.handle(ipcChannels.sessionUnsubscribeThread, (_event, threadId: string) =>
    byThread(threadId).unsubscribeThread(threadId)
  )
  ipcMain.handle(ipcChannels.sessionListInstalledPlugins, (_event, params?: CodexPluginQueryParams) =>
    client.listInstalledPlugins(params?.cwd)
  )
  ipcMain.handle(ipcChannels.sessionListPlugins, (_event, params?: CodexPluginQueryParams) =>
    client.listPlugins(params?.cwd)
  )
  ipcMain.handle(ipcChannels.sessionReadPlugin, (_event, params: CodexPluginReadParams) =>
    client.readPlugin(params)
  )
  ipcMain.handle(ipcChannels.sessionGetPluginAppStatuses, (_event, params: CodexPluginAppStatusParams) =>
    client.getPluginAppStatuses(params.appIds, params.forceRefetch)
  )
  ipcMain.handle(ipcChannels.sessionInstallPlugin, (_event, params: CodexPluginInstallParams) =>
    client.installPlugin(params)
  )
  ipcMain.handle(ipcChannels.sessionUninstallPlugin, (_event, pluginId: string) =>
    client.uninstallPlugin(pluginId)
  )
  ipcMain.handle(ipcChannels.memoryPersist, (_event, params: MemoryPersistParams) =>
    memoryStore.persist(params)
  )

  return client
}
