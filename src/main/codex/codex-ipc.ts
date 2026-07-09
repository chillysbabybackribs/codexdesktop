import { ipcMain, type BrowserWindow } from 'electron'
import type { CodexEvent, CodexInterruptTurnParams, CodexListThreadsParams, CodexSendMessageParams } from '../../shared/ipc.js'
import { ipcChannels } from '../../shared/ipc.js'
import { CodexClient } from './codex-client.js'

export function registerCodexIpc(getWindow: () => BrowserWindow | null): CodexClient {
  const client = new CodexClient(getWindow)

  client.on('event', (event: CodexEvent) => {
    getWindow()?.webContents.send(ipcChannels.codexEvent, event)
  })

  ipcMain.handle(ipcChannels.codexGetAuthStatus, () => client.getAuthStatus())
  ipcMain.handle(ipcChannels.codexListThreads, (_event, params?: CodexListThreadsParams) =>
    client.listThreads(params)
  )
  ipcMain.handle(ipcChannels.codexStartThread, (_event, cwd?: string | null) => client.startThread(cwd))
  ipcMain.handle(ipcChannels.codexResumeThread, (_event, threadId: string) => client.resumeThread(threadId))
  ipcMain.handle(ipcChannels.codexReadThread, (_event, threadId: string) => client.readThread(threadId))
  ipcMain.handle(ipcChannels.codexSendMessage, (_event, params: CodexSendMessageParams) =>
    client.sendMessage(params.threadId, params.text, params.cwd)
  )
  ipcMain.handle(ipcChannels.codexInterruptTurn, (_event, params: CodexInterruptTurnParams) =>
    client.interruptTurn(params.threadId, params.turnId)
  )
  ipcMain.handle(ipcChannels.codexUnsubscribeThread, (_event, threadId: string) =>
    client.unsubscribeThread(threadId)
  )

  return client
}
