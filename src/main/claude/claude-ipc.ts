import { ipcMain, type BrowserWindow } from 'electron'
import type {
  ClaudeEvent,
  ClaudeInterruptTurnParams,
  ClaudeListThreadsParams,
  ClaudeSendMessageParams,
  ClaudeStartThreadParams,
  ClaudeSteerTurnParams
} from '../../shared/ipc.js'
import { ipcChannels } from '../../shared/ipc.js'
import type { BrowserAgentController } from '../browser/browser-agent.js'
import type { ResearchRunner } from '../browser/research-runner.js'
import type { AttachmentStore } from '../attachment-store.js'
import { ClaudeClient } from './claude-client.js'

export function registerClaudeIpc(
  getWindow: () => BrowserWindow | null,
  browserAgent: BrowserAgentController,
  researchRunner: ResearchRunner,
  attachmentStore: AttachmentStore
): ClaudeClient {
  const client = new ClaudeClient(browserAgent, researchRunner)

  client.on('event', (event: ClaudeEvent) => {
    getWindow()?.webContents.send(ipcChannels.claudeEvent, event)
  })

  ipcMain.handle(ipcChannels.claudeGetAuthStatus, (_event, cwd?: string | null) => client.getAuthStatus(cwd))
  ipcMain.handle(ipcChannels.claudeListModels, (_event, cwd?: string | null) => client.listModels(cwd))
  ipcMain.handle(ipcChannels.claudeListThreads, (_event, params?: ClaudeListThreadsParams) =>
    client.listThreads(params?.cwd)
  )
  ipcMain.handle(ipcChannels.claudeStartThread, (_event, params?: ClaudeStartThreadParams) =>
    client.startThread(params?.cwd, params?.model, params?.effort, params?.collaborationMode)
  )
  ipcMain.handle(ipcChannels.claudeResumeThread, (_event, threadId: string, cwd?: string | null) =>
    client.resumeThread(threadId, cwd)
  )
  ipcMain.handle(ipcChannels.claudeReadThread, (_event, threadId: string, cwd?: string | null) =>
    client.readThread(threadId, cwd)
  )
  ipcMain.handle(ipcChannels.claudeSendMessage, async (_event, params: ClaudeSendMessageParams) => {
    const attachments = await attachmentStore.verify(params.attachments ?? [])
    return client.sendMessage(
      params.threadId,
      params.text,
      params.cwd,
      params.model,
      attachments,
      params.effort,
      params.collaborationMode
    )
  })
  ipcMain.handle(ipcChannels.claudeSteerTurn, (_event, params: ClaudeSteerTurnParams) =>
    client.steerTurn(params.threadId, params.turnId, params.text)
  )
  ipcMain.handle(ipcChannels.claudeInterruptTurn, (_event, params: ClaudeInterruptTurnParams) =>
    client.interruptTurn(params.threadId, params.turnId)
  )

  return client
}
