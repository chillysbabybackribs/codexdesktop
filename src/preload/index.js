import { contextBridge, ipcRenderer } from 'electron';
import { ipcChannels } from '../shared/ipc.js';
const api = {
    window: {
        minimize: () => ipcRenderer.invoke(ipcChannels.windowMinimize),
        toggleMaximize: () => ipcRenderer.invoke(ipcChannels.windowToggleMaximize),
        close: () => ipcRenderer.invoke(ipcChannels.windowClose)
    },
    browser: {
        newTab: (url) => ipcRenderer.invoke(ipcChannels.browserNewTab, url),
        closeTab: (tabId) => ipcRenderer.invoke(ipcChannels.browserCloseTab, tabId),
        activateTab: (tabId) => ipcRenderer.invoke(ipcChannels.browserActivateTab, tabId),
        navigate: (tabId, input) => ipcRenderer.invoke(ipcChannels.browserNavigate, tabId, input),
        back: (tabId) => ipcRenderer.invoke(ipcChannels.browserBack, tabId),
        forward: (tabId) => ipcRenderer.invoke(ipcChannels.browserForward, tabId),
        reload: (tabId) => ipcRenderer.invoke(ipcChannels.browserReload, tabId),
        setBounds: (bounds) => ipcRenderer.invoke(ipcChannels.browserSetBounds, bounds),
        beginDividerDrag: () => ipcRenderer.invoke(ipcChannels.browserBeginDividerDrag),
        endDividerDrag: (bounds) => ipcRenderer.invoke(ipcChannels.browserEndDividerDrag, bounds),
        setOverlayOpen: (open) => ipcRenderer.invoke(ipcChannels.browserSetOverlayOpen, open),
        onState: (listener) => {
            const wrapped = (_event, state) => listener(state);
            ipcRenderer.on(ipcChannels.browserState, wrapped);
            return () => ipcRenderer.off(ipcChannels.browserState, wrapped);
        }
    },
    codex: {
        getAuthStatus: () => ipcRenderer.invoke(ipcChannels.codexGetAuthStatus),
        listThreads: () => ipcRenderer.invoke(ipcChannels.codexListThreads),
        startThread: (cwd) => ipcRenderer.invoke(ipcChannels.codexStartThread, cwd),
        resumeThread: (threadId) => ipcRenderer.invoke(ipcChannels.codexResumeThread, threadId),
        readThread: (threadId) => ipcRenderer.invoke(ipcChannels.codexReadThread, threadId),
        sendMessage: (params) => ipcRenderer.invoke(ipcChannels.codexSendMessage, params),
        interruptTurn: (params) => ipcRenderer.invoke(ipcChannels.codexInterruptTurn, params),
        onEvent: (listener) => {
            const wrapped = (_event, event) => listener(event);
            ipcRenderer.on(ipcChannels.codexEvent, wrapped);
            return () => ipcRenderer.off(ipcChannels.codexEvent, wrapped);
        }
    },
    workspace: {
        pick: () => ipcRenderer.invoke(ipcChannels.workspacePick)
    }
};
contextBridge.exposeInMainWorld('api', api);
