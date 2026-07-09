import { ipcMain } from 'electron';
import { ipcChannels } from '../../shared/ipc.js';
import { CodexClient } from './codex-client.js';
export function registerCodexIpc(getWindow) {
    const client = new CodexClient(getWindow);
    client.on('event', (event) => {
        getWindow()?.webContents.send(ipcChannels.codexEvent, event);
    });
    ipcMain.handle(ipcChannels.codexGetAuthStatus, () => client.getAuthStatus());
    ipcMain.handle(ipcChannels.codexListThreads, () => client.listThreads());
    ipcMain.handle(ipcChannels.codexStartThread, (_event, cwd) => client.startThread(cwd));
    ipcMain.handle(ipcChannels.codexResumeThread, (_event, threadId) => client.resumeThread(threadId));
    ipcMain.handle(ipcChannels.codexReadThread, (_event, threadId) => client.readThread(threadId));
    ipcMain.handle(ipcChannels.codexSendMessage, (_event, params) => client.sendMessage(params.threadId, params.text, params.cwd));
    ipcMain.handle(ipcChannels.codexInterruptTurn, (_event, params) => client.interruptTurn(params.threadId, params.turnId));
    ipcMain.handle(ipcChannels.codexRespondApproval, (_event, params) => client.respondToApproval(params.requestId, params.decision));
    ipcMain.handle(ipcChannels.codexSetAutoApprove, (_event, enabled) => client.setAutoApprove(enabled));
    return client;
}
