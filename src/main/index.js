import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { ipcChannels } from '../shared/ipc.js';
import { TabManager } from './browser/tab-manager.js';
import { registerCodexIpc } from './codex/codex-ipc.js';
let mainWindow = null;
let tabManager = null;
let codexClient = null;
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 2048,
        height: 1024,
        minWidth: 980,
        minHeight: 620,
        show: false,
        frame: false,
        title: 'Chat',
        backgroundColor: '#121212',
        webPreferences: {
            preload: join(__dirname, '../preload/index.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        console.error('Renderer failed to load', { errorCode, errorDescription, validatedURL });
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        console.error('Renderer process gone', details);
    });
    mainWindow.webContents.on('console-message', (event) => {
        const { level, message, sourceId, lineNumber } = event;
        console.log(`Renderer console [${level}]: ${message} (${sourceId}:${lineNumber})`);
    });
    tabManager = new TabManager(mainWindow);
    tabManager.onState((state) => {
        mainWindow?.webContents.send(ipcChannels.browserState, state);
    });
    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
        tabManager?.createInitialTab();
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
        tabManager = null;
    });
    if (process.env.ELECTRON_RENDERER_URL) {
        void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    }
    else {
        void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
}
app.whenReady().then(() => {
    registerIpc();
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
app.on('before-quit', () => {
    codexClient?.dispose();
    codexClient = null;
});
function registerIpc() {
    codexClient = registerCodexIpc(() => mainWindow);
    ipcMain.handle(ipcChannels.windowMinimize, () => mainWindow?.minimize());
    ipcMain.handle(ipcChannels.windowToggleMaximize, () => {
        if (!mainWindow) {
            return;
        }
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        }
        else {
            mainWindow.maximize();
        }
    });
    ipcMain.handle(ipcChannels.windowClose, () => mainWindow?.close());
    ipcMain.handle(ipcChannels.workspacePick, async () => {
        if (!mainWindow) {
            return null;
        }
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose workspace folder',
            properties: ['openDirectory', 'createDirectory']
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    ipcMain.handle(ipcChannels.browserNewTab, (_event, url) => tabManager?.createTab(url));
    ipcMain.handle(ipcChannels.browserCloseTab, (_event, tabId) => tabManager?.closeTab(tabId));
    ipcMain.handle(ipcChannels.browserActivateTab, (_event, tabId) => tabManager?.activateTab(tabId));
    ipcMain.handle(ipcChannels.browserNavigate, (_event, tabId, input) => {
        tabManager?.navigate(tabId, input);
    });
    ipcMain.handle(ipcChannels.browserBack, (_event, tabId) => tabManager?.goBack(tabId));
    ipcMain.handle(ipcChannels.browserForward, (_event, tabId) => tabManager?.goForward(tabId));
    ipcMain.handle(ipcChannels.browserReload, (_event, tabId) => tabManager?.reload(tabId));
    ipcMain.handle(ipcChannels.browserSetBounds, (_event, bounds) => tabManager?.setBounds(bounds));
    ipcMain.handle(ipcChannels.browserBeginDividerDrag, () => tabManager?.beginDividerDrag());
    ipcMain.handle(ipcChannels.browserEndDividerDrag, (_event, bounds) => tabManager?.endDividerDrag(bounds));
    ipcMain.handle(ipcChannels.browserSetOverlayOpen, (_event, open) => tabManager?.setOverlayOpen(open));
}
