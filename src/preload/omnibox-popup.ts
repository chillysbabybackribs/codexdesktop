import { contextBridge, ipcRenderer } from 'electron'
import type { OmniboxRenderPayload } from '../shared/ipc.js'

// Channel names duplicated from shared/ipc.ts ipcChannels on purpose: preloads
// run sandboxed and cannot require() the shared chunk rollup would emit for a
// cross-entry import, so this file must stay self-contained.
const renderChannel = 'browser:omniboxRender'
const commitChannel = 'browser:omniboxCommit'
const deleteHistoryChannel = 'browser:omniboxDeleteHistory'

export const omniboxPopupApi = {
  onRender: (listener: (payload: OmniboxRenderPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: OmniboxRenderPayload): void => listener(payload)
    ipcRenderer.on(renderChannel, wrapped)
    return () => {
      ipcRenderer.off(renderChannel, wrapped)
    }
  },
  commit: (url: string): void => {
    ipcRenderer.send(commitChannel, url)
  },
  deleteHistory: (url: string): void => {
    ipcRenderer.send(deleteHistoryChannel, url)
  }
}

contextBridge.exposeInMainWorld('omniboxPopup', omniboxPopupApi)
