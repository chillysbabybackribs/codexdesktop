import type { WebContents } from 'electron'
import type { ManagedBrowserTab } from './browser-tab-model.js'
import { safeWebContentsTitle, safeWebContentsUrl } from './browser-tab-model.js'

export type BrowserTarget = {
  id: string
  kind: 'tab' | 'popup'
  url: string
  title: string
  active: boolean
  openerTabId: string | null
}

export class BrowserTargetRegistry {
  private readonly popups = new Map<string, { webContents: WebContents; openerTabId: string; epoch: number }>()

  registerPopup(webContents: WebContents, openerTabId: string): void {
    if (webContents.isDestroyed()) return

    const id = `popup-${webContents.id}`
    const popup = { webContents, openerTabId, epoch: 0 }
    this.popups.set(id, popup)
    webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) popup.epoch += 1
    })
    webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) popup.epoch += 1
    })
    webContents.once('destroyed', () => {
      this.popups.delete(id)
    })
  }

  resolvePopup(id: string): WebContents | null {
    const webContents = this.popups.get(id)?.webContents
    return webContents && !webContents.isDestroyed() ? webContents : null
  }

  getPopupEpoch(id: string): number | null {
    const popup = this.popups.get(id)
    return popup && !popup.webContents.isDestroyed() ? popup.epoch : null
  }

  contains(webContents: WebContents): boolean {
    this.removeDestroyed()
    return Array.from(this.popups.values()).some((popup) => popup.webContents === webContents)
  }

  list(tabs: Iterable<ManagedBrowserTab>, activeTabId: string | null): BrowserTarget[] {
    this.removeDestroyed()

    return [
      ...Array.from(tabs).map((tab): BrowserTarget => ({
        id: tab.id,
        kind: 'tab',
        url: safeWebContentsUrl(tab.view.webContents) || tab.url,
        title: safeWebContentsTitle(tab.view.webContents) || tab.title,
        active: tab.id === activeTabId,
        openerTabId: null
      })),
      ...Array.from(this.popups.entries()).map(([id, popup]): BrowserTarget => ({
        id,
        kind: 'popup',
        url: safeWebContentsUrl(popup.webContents),
        title: safeWebContentsTitle(popup.webContents) || 'Popup',
        active: false,
        openerTabId: popup.openerTabId
      }))
    ]
  }

  private removeDestroyed(): void {
    for (const [id, popup] of this.popups) {
      if (popup.webContents.isDestroyed()) {
        this.popups.delete(id)
      }
    }
  }
}
