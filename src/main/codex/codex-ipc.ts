import { ipcMain, type BrowserWindow } from 'electron'
import type {
  CodexEvent,
  CodexInterruptTurnParams,
  CodexListThreadsParams,
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

export function registerCodexIpc(
  getWindow: () => BrowserWindow | null,
  browserAgent: BrowserAgentController,
  researchRunner: ResearchRunner,
  memoryStore: MemoryStore
): CodexClient {
  const client = new CodexClient(getWindow, browserAgent, researchRunner)

  client.on('event', (event: CodexEvent) => {
    getWindow()?.webContents.send(ipcChannels.codexEvent, event)
  })

  ipcMain.handle(ipcChannels.codexGetAuthStatus, () => client.getAuthStatus())
  ipcMain.handle(ipcChannels.codexListModels, () => client.listModels())
  ipcMain.handle(ipcChannels.codexListThreads, (_event, params?: CodexListThreadsParams) =>
    client.listThreads(params)
  )
  ipcMain.handle(ipcChannels.codexStartThread, (_event, params?: CodexStartThreadParams) =>
    client.startThread(params?.cwd, params?.model)
  )
  ipcMain.handle(ipcChannels.codexResumeThread, (_event, threadId: string) => client.resumeThread(threadId))
  ipcMain.handle(ipcChannels.codexReadThread, (_event, threadId: string) => client.readThread(threadId))
  ipcMain.handle(ipcChannels.codexGetGoal, (_event, threadId: string) => client.getGoal(threadId))
  ipcMain.handle(ipcChannels.codexSetGoal, (_event, params: CodexSetGoalParams) => client.setGoal(params))
  ipcMain.handle(ipcChannels.codexClearGoal, (_event, threadId: string) => client.clearGoal(threadId))
  ipcMain.handle(ipcChannels.codexSendMessage, (_event, params: CodexSendMessageParams) =>
    client.sendMessage(params.threadId, params.text, params.cwd, params.model)
  )
  ipcMain.handle(ipcChannels.codexSteerTurn, (_event, params: CodexSteerTurnParams) =>
    client.steerTurn(params.threadId, params.turnId, params.text)
  )
  ipcMain.handle(ipcChannels.codexInterruptTurn, (_event, params: CodexInterruptTurnParams) =>
    client.interruptTurn(params.threadId, params.turnId)
  )
  ipcMain.handle(ipcChannels.codexCompactThread, (_event, threadId: string) =>
    client.compactThread(threadId)
  )
  ipcMain.handle(ipcChannels.codexUnsubscribeThread, (_event, threadId: string) =>
    client.unsubscribeThread(threadId)
  )
  ipcMain.handle(ipcChannels.memoryPersist, (_event, params: MemoryPersistParams) =>
    memoryStore.persist(params)
  )

  return client
}
