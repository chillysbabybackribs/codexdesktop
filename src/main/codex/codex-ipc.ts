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

export function registerSessionIpc(
  getWindow: () => BrowserWindow | null,
  browserAgent: BrowserAgentController,
  researchRunner: ResearchRunner,
  memoryStore: MemoryStore,
  attachmentStore: AttachmentStore,
  checkpointStore: TurnCheckpointStore | null = null
): CodexClient {
  const client = new CodexClient(browserAgent, researchRunner, checkpointStore)

  client.on('event', (event: SessionEvent) => {
    getWindow()?.webContents.send(ipcChannels.sessionEvent, event)
  })

  ipcMain.handle(ipcChannels.sessionGetAuthStatus, () => client.getAuthStatus())
  ipcMain.handle(ipcChannels.sessionListModels, () => client.listModels())
  ipcMain.handle(ipcChannels.sessionListThreads, (_event, params?: CodexListThreadsParams) =>
    client.listThreads(params)
  )
  ipcMain.handle(ipcChannels.sessionStartThread, (_event, params?: CodexStartThreadParams) =>
    client.startThread(params?.cwd, params?.model)
  )
  ipcMain.handle(ipcChannels.sessionResumeThread, (_event, params: CodexResumeThreadParams) =>
    client.resumeThread(params.threadId, params.history)
  )
  ipcMain.handle(ipcChannels.sessionListThreadTurns, (_event, params: CodexListThreadTurnsParams) =>
    client.listThreadTurns(params)
  )
  ipcMain.handle(ipcChannels.sessionGetGoal, (_event, threadId: string) => client.getGoal(threadId))
  ipcMain.handle(ipcChannels.sessionSetGoal, (_event, params: CodexSetGoalParams) => client.setGoal(params))
  ipcMain.handle(ipcChannels.sessionClearGoal, (_event, threadId: string) => client.clearGoal(threadId))
  ipcMain.handle(ipcChannels.sessionSendMessage, async (_event, params: CodexSendMessageParams) => {
    const attachments = await attachmentStore.verify(params.attachments ?? [])
    return client.sendMessage(
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
    client.steerTurn(params.threadId, params.turnId, params.text)
  )
  ipcMain.handle(ipcChannels.sessionInterruptTurn, (_event, params: CodexInterruptTurnParams) =>
    client.interruptTurn(params.threadId, params.turnId)
  )
  ipcMain.handle(ipcChannels.sessionCompactThread, (_event, threadId: string) =>
    client.compactThread(threadId)
  )
  ipcMain.handle(ipcChannels.sessionUnsubscribeThread, (_event, threadId: string) =>
    client.unsubscribeThread(threadId)
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
