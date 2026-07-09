import type { BrowserWindow, WebContents } from 'electron'
import { browserPartition, chromeLikeUserAgent } from './browser-session.js'
import { isUnsafePopupUrl } from './window-open-policy.js'

// Google Sign-In popups call window.opener.postMessage(). Converting popups
// into in-app tabs breaks that link and leaves a blank gsi/iframe page.
// Real child BrowserWindows keep the opener relationship while staying in-app.
export function attachPopupWindowHandling(webContents: WebContents, parent: BrowserWindow): void {
  webContents.setUserAgent(chromeLikeUserAgent())

  webContents.setWindowOpenHandler((details) => {
    if (isUnsafePopupUrl(details.url)) {
      return { action: 'deny' }
    }

    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent,
        width: 520,
        height: 680,
        autoHideMenuBar: true,
        show: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: browserPartition
        }
      }
    }
  })

  webContents.on('did-create-window', (childWindow) => {
    attachPopupWindowHandling(childWindow.webContents, parent)
  })
}
