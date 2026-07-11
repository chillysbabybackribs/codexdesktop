import { contextBridge, ipcRenderer } from 'electron'
import type { OmniboxRenderPayload } from '../shared/ipc.js'
import { ipcChannels } from '../shared/ipc.js'

export const omniboxPopupApi = {
  onRender: (listener: (payload: OmniboxRenderPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: OmniboxRenderPayload): void => listener(payload)
    ipcRenderer.on(ipcChannels.browserOmniboxRender, wrapped)
    return () => {
      ipcRenderer.off(ipcChannels.browserOmniboxRender, wrapped)
    }
  },
  commit: (url: string): void => {
    ipcRenderer.send(ipcChannels.browserOmniboxCommit, url)
  }
}

contextBridge.exposeInMainWorld('omniboxPopup', omniboxPopupApi)
