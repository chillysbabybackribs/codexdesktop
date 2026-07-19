import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserMenuCommand, BrowserMenuRenderPayload } from '../shared/ipc.js'

// Channel names duplicated from shared/ipc.ts ipcChannels on purpose: preloads
// run sandboxed and cannot require() the shared chunk rollup would emit for a
// cross-entry import, so this file must stay self-contained.
const renderChannel = 'browser:menuRender'
const commandChannel = 'browser:menuCommand'

export const browserMenuApi = {
  onRender: (listener: (payload: BrowserMenuRenderPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: BrowserMenuRenderPayload): void => listener(payload)
    ipcRenderer.on(renderChannel, wrapped)
    return () => {
      ipcRenderer.off(renderChannel, wrapped)
    }
  },
  command: (command: BrowserMenuCommand): void => {
    ipcRenderer.send(commandChannel, command)
  }
}

contextBridge.exposeInMainWorld('browserMenu', browserMenuApi)
