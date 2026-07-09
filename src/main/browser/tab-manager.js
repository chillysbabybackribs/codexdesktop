import { WebContentsView, shell } from 'electron';
import { normalizeNavigationInput } from './url-utils.js';
const hiddenBounds = { x: -10000, y: -10000, width: 10, height: 10 };
export class TabManager {
    window;
    tabs = new Map();
    activeTabId = null;
    bounds = hiddenBounds;
    isDraggingDivider = false;
    // The native browser view sits above all renderer DOM, so a renderer overlay
    // (settings modal, etc.) can't cover it with z-index — we hide the view while
    // an overlay is open, the same trick used during a divider drag.
    isOverlayOpen = false;
    stateListener = null;
    constructor(window) {
        this.window = window;
    }
    onState(listener) {
        this.stateListener = listener;
        this.pushState();
    }
    createInitialTab() {
        this.createTab('https://www.google.com');
    }
    createTab(url = 'https://www.google.com') {
        const id = crypto.randomUUID();
        const view = new WebContentsView({
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        });
        view.setBorderRadius?.(12);
        view.setBounds(this.activeTabId ? hiddenBounds : this.bounds);
        this.window.contentView.addChildView(view);
        const tab = {
            id,
            view,
            title: 'New Tab',
            url,
            isLoading: false
        };
        this.tabs.set(id, tab);
        this.attachEvents(tab);
        this.activateTab(id);
        void view.webContents.loadURL(url);
        this.pushState();
        return id;
    }
    closeTab(id) {
        const tab = this.tabs.get(id);
        if (!tab) {
            return;
        }
        this.window.contentView.removeChildView(tab.view);
        tab.view.webContents.close();
        this.tabs.delete(id);
        if (this.activeTabId === id) {
            const next = this.tabs.keys().next().value;
            this.activeTabId = null;
            if (next) {
                this.activateTab(next);
            }
            else {
                this.createTab();
            }
        }
        this.pushState();
    }
    activateTab(id) {
        if (!this.tabs.has(id)) {
            return;
        }
        for (const tab of this.tabs.values()) {
            tab.view.setBounds(hiddenBounds);
        }
        this.activeTabId = id;
        this.syncActiveBounds();
        this.pushState();
    }
    navigate(id, input) {
        const tab = this.tabs.get(id);
        if (!tab) {
            return;
        }
        void tab.view.webContents.loadURL(normalizeNavigationInput(input));
    }
    goBack(id) {
        const tab = this.tabs.get(id);
        const history = tab?.view.webContents.navigationHistory;
        if (history?.canGoBack()) {
            history.goBack();
        }
    }
    goForward(id) {
        const tab = this.tabs.get(id);
        const history = tab?.view.webContents.navigationHistory;
        if (history?.canGoForward()) {
            history.goForward();
        }
    }
    reload(id) {
        this.tabs.get(id)?.view.webContents.reload();
    }
    setBounds(bounds) {
        this.bounds = sanitizeBounds(bounds);
        this.syncActiveBounds();
    }
    beginDividerDrag() {
        this.isDraggingDivider = true;
        this.syncActiveBounds();
    }
    endDividerDrag(bounds) {
        this.bounds = sanitizeBounds(bounds);
        this.isDraggingDivider = false;
        this.syncActiveBounds();
    }
    setOverlayOpen(open) {
        this.isOverlayOpen = open;
        this.syncActiveBounds();
    }
    // The active view is on-screen only when nothing renderer-side needs the
    // browser region clear — a divider drag in progress, or an overlay covering it.
    syncActiveBounds() {
        const hidden = this.isDraggingDivider || this.isOverlayOpen;
        this.getActiveTab()?.view.setBounds(hidden ? hiddenBounds : this.bounds);
    }
    attachEvents(tab) {
        const webContents = tab.view.webContents;
        webContents.setWindowOpenHandler(({ url }) => {
            this.createTab(url);
            return { action: 'deny' };
        });
        webContents.on('page-title-updated', (_event, title) => {
            tab.title = title || tab.url || 'New Tab';
            this.pushState();
        });
        webContents.on('did-start-loading', () => {
            tab.isLoading = true;
            this.pushState();
        });
        webContents.on('did-stop-loading', () => {
            tab.isLoading = false;
            tab.url = webContents.getURL();
            tab.title = webContents.getTitle() || tab.url || 'New Tab';
            this.pushState();
        });
        webContents.on('did-navigate', (_event, url) => {
            tab.url = url;
            this.pushState();
        });
        webContents.on('did-navigate-in-page', (_event, url) => {
            tab.url = url;
            this.pushState();
        });
        webContents.on('did-fail-load', (_event, _errorCode, errorDescription, validatedURL) => {
            tab.isLoading = false;
            tab.url = validatedURL || tab.url;
            tab.title = errorDescription || tab.title;
            this.pushState();
        });
        webContents.on('will-navigate', (event, url) => {
            if (url.startsWith('file://')) {
                event.preventDefault();
                void shell.openExternal(url);
            }
        });
    }
    getActiveTab() {
        return this.activeTabId ? (this.tabs.get(this.activeTabId) ?? null) : null;
    }
    pushState() {
        this.stateListener?.({
            activeTabId: this.activeTabId,
            tabs: Array.from(this.tabs.values()).map((tab) => {
                const webContents = tab.view.webContents;
                const history = webContents.navigationHistory;
                return {
                    id: tab.id,
                    title: tab.title,
                    url: tab.url,
                    isLoading: tab.isLoading,
                    canGoBack: history.canGoBack(),
                    canGoForward: history.canGoForward()
                };
            })
        });
    }
}
function sanitizeBounds(bounds) {
    return {
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height))
    };
}
