import { ipcMain, WebContentsView } from 'electron';
import type { BrowserWindow, IpcMainEvent } from 'electron';
import { join } from 'node:path';
import type { TitlebarCalendarAnchor } from '../shared/ipc.js';
import { ipcChannels } from '../shared/ipc.js';

const popupWidth = 310;
const popupHeight = 370;
const hiddenBounds = { x: -10000, y: -10000, width: 10, height: 10 };

// The title-bar calendar follows the same native-overlay architecture as the
// omnibox and browser menu. A renderer element cannot cover the browser's
// WebContentsView, so this transparent child view is stacked above it instead.
// The page remains visible and keeps its bounds while the calendar is open.
export class TitlebarCalendarPopup {
  private view: WebContentsView | null = null;
  private pageReady = false;
  private visible = false;
  private anchor: TitlebarCalendarAnchor | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly onClosed: () => void,
  ) {
    ipcMain.on(ipcChannels.titlebarCalendarPopupClose, this.handlePopupClose);
    this.ensureView();
  }

  show(anchor: TitlebarCalendarAnchor): void {
    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return;
    this.anchor = anchor;
    this.visible = true;
    const view = this.ensureView();
    if (this.pageReady) this.present(view);
  }

  hide(): void {
    const wasVisible = this.visible;
    this.visible = false;
    this.anchor = null;
    if (this.view) {
      this.view.setVisible(false);
      this.view.setBounds(hiddenBounds);
    }
    if (wasVisible) {
      if (this.window.isFocused()) this.window.webContents.focus();
      this.onClosed();
    }
  }

  isOpen(): boolean {
    return this.visible;
  }

  dispose(): void {
    ipcMain.off(ipcChannels.titlebarCalendarPopupClose, this.handlePopupClose);
    if (!this.view) return;
    try {
      this.window.contentView.removeChildView(this.view);
    } catch {
      // Window may already be tearing down.
    }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
  }

  private readonly handlePopupClose = (event: IpcMainEvent): void => {
    if (event.sender === this.view?.webContents) this.hide();
  };

  private ensureView(): WebContentsView {
    if (this.view) return this.view;

    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/titlebar-calendar.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    view.setBounds(hiddenBounds);
    this.window.contentView.addChildView(view);

    view.webContents.on('did-finish-load', () => {
      this.pageReady = true;
      if (this.visible) this.present(view);
    });
    view.webContents.on('blur', () => {
      setTimeout(() => {
        if (this.visible && !view.webContents.isFocused()) this.hide();
      }, 0);
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      void view.webContents.loadURL(
        `${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')}/titlebar-calendar.html`,
      );
    } else {
      void view.webContents.loadFile(join(__dirname, '../renderer/titlebar-calendar.html'));
    }

    this.view = view;
    return view;
  }

  private present(view: WebContentsView): void {
    if (!this.anchor || !this.visible) return;
    this.window.contentView.addChildView(view);
    view.setBounds(this.computeBounds(this.anchor));
    view.setVisible(true);
    view.webContents.focus();
  }

  private computeBounds(anchor: TitlebarCalendarAnchor): Electron.Rectangle {
    const [windowWidth, windowHeight] = this.window.getContentSize();
    const width = Math.min(popupWidth, Math.max(180, windowWidth - 16));
    const height = Math.min(popupHeight, Math.max(180, windowHeight - anchor.y - 8));
    return {
      x: Math.max(8, Math.min(Math.round(anchor.x - width / 2), windowWidth - width - 8)),
      y: Math.max(0, Math.round(anchor.y)),
      width,
      height,
    };
  }
}
