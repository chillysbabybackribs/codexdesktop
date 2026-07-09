import type { BrowserWindow, HandlerDetails, WebContents } from 'electron'
import { shell } from 'electron'
import { isBlankPopupUrl, isExternalHttpUrl } from './window-open-policy.js'

export function resolveWindowOpen(parent: BrowserWindow, url: string | undefined) {
  if (isExternalHttpUrl(url)) {
    void shell.openExternal(url!.trim())
    return { action: 'deny' as const }
  }

  if (isBlankPopupUrl(url)) {
    return {
      action: 'allow' as const,
      overrideBrowserWindowOptions: {
        parent,
        width: 520,
        height: 640,
        autoHideMenuBar: true,
        show: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      }
    }
  }

  return { action: 'deny' as const }
}

export function attachPopupExternalRouting(webContents: WebContents, parent: BrowserWindow): void {
  webContents.setWindowOpenHandler((details: HandlerDetails) => resolveWindowOpen(parent, details.url))

  webContents.on('did-create-window', (childWindow) => {
    const childContents = childWindow.webContents

    childContents.setWindowOpenHandler((details: HandlerDetails) => resolveWindowOpen(parent, details.url))

    const routeToSystemBrowser = (event: { preventDefault: () => void }, targetUrl: string): void => {
      if (!isExternalHttpUrl(targetUrl)) {
        return
      }

      event.preventDefault()
      void shell.openExternal(targetUrl.trim())
      childWindow.close()
    }

    childContents.on('will-navigate', routeToSystemBrowser)
    childContents.on('will-redirect', routeToSystemBrowser)
  })
}
