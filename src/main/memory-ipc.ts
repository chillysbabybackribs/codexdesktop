import { ipcMain } from 'electron'
import { ipcChannels, type MemoryPersistParams } from '../shared/ipc.js'
import type { ConversationMemoryService } from './conversation-memory-service.js'

export function registerMemoryIpc(memory: ConversationMemoryService): void {
  ipcMain.handle(ipcChannels.memoryPersist, (_event, params: MemoryPersistParams) =>
    memory.persist(params)
  )
}
