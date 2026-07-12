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
import type { ClaudeClient } from './claude-client.js'
import type { ConversationMemoryService } from '../conversation-memory-service.js'

export type ClaudeIpcHandle = {
  dispose: () => void
}

export function registerClaudeIpc(
  getWindow: () => BrowserWindow | null,
  browserAgent: BrowserAgentController,
  researchRunner: ResearchRunner,
  attachmentStore: AttachmentStore,
  conversationMemory: ConversationMemoryService
): ClaudeIpcHandle {
  let client: ClaudeClient | null = null
  let clientInFlight: Promise<ClaudeClient> | null = null
  let disposed = false

  const getClient = (): Promise<ClaudeClient> => {
    if (client) return Promise.resolve(client)
    if (clientInFlight) return clientInFlight

    clientInFlight = import('./claude-client.js').then(({ ClaudeClient }) => {
      if (disposed) throw new Error('Claude integration is shutting down')
      const next = new ClaudeClient(browserAgent, researchRunner, conversationMemory)
      next.on('event', (event: ClaudeEvent) => {
        getWindow()?.webContents.send(ipcChannels.claudeEvent, event)
      })
      client = next
      return next
    }).finally(() => {
      clientInFlight = null
    })

    return clientInFlight
  }

  ipcMain.handle(ipcChannels.claudeGetAuthStatus, async (_event, cwd?: string | null) =>
    (await getClient()).getAuthStatus(cwd)
  )
  ipcMain.handle(ipcChannels.claudeListModels, async (_event, cwd?: string | null) =>
    (await getClient()).listModels(cwd)
  )
  ipcMain.handle(ipcChannels.claudeListThreads, async (_event, params?: ClaudeListThreadsParams) =>
    (await getClient()).listThreads(params?.cwd)
  )
  ipcMain.handle(ipcChannels.claudeStartThread, async (_event, params?: ClaudeStartThreadParams) =>
    (await getClient()).startThread(params?.cwd, params?.model, params?.effort, params?.collaborationMode)
  )
  ipcMain.handle(ipcChannels.claudeResumeThread, async (_event, threadId: string, cwd?: string | null) =>
    (await getClient()).resumeThread(threadId, cwd)
  )
  ipcMain.handle(ipcChannels.claudeReadThread, async (_event, threadId: string, cwd?: string | null) =>
    (await getClient()).readThread(threadId, cwd)
  )
  ipcMain.handle(ipcChannels.claudeSendMessage, async (_event, params: ClaudeSendMessageParams) => {
    const attachments = await attachmentStore.verify(params.attachments ?? [])
    return (await getClient()).sendMessage(
      params.threadId,
      params.text,
      params.cwd,
      params.model,
      attachments,
      params.effort,
      params.collaborationMode
    )
  })
  ipcMain.handle(ipcChannels.claudeSteerTurn, async (_event, params: ClaudeSteerTurnParams) =>
    (await getClient()).steerTurn(params.threadId, params.turnId, params.text)
  )
  ipcMain.handle(ipcChannels.claudeInterruptTurn, async (_event, params: ClaudeInterruptTurnParams) =>
    (await getClient()).interruptTurn(params.threadId, params.turnId)
  )
  ipcMain.handle(ipcChannels.claudeUnsubscribeThread, async (_event, threadId: string) =>
    (await getClient()).unsubscribeThread(threadId)
  )

  return {
    dispose: () => {
      disposed = true
      client?.dispose()
      client = null
    }
  }
}
