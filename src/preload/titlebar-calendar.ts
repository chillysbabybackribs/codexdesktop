import { contextBridge, ipcRenderer } from 'electron';

// Kept self-contained because sandboxed preload entries cannot import the
// shared IPC chunk emitted by Rollup.
const closeChannel = 'titlebar-calendar:popupClose';

export const titlebarCalendarPopupApi = {
  close: (): void => {
    ipcRenderer.send(closeChannel);
  },
};

contextBridge.exposeInMainWorld('titlebarCalendarPopup', titlebarCalendarPopupApi);
