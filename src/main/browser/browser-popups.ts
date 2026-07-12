import type { BrowserWindow, WebContents } from 'electron'
import { join } from 'node:path'
import { browserPartition, chromeLikeUserAgent } from './browser-session.js'
import { resolveWindowOpenAction } from './window-open-policy.js'

// Google Sign-In popups call window.opener.postMessage(). Converting popups
// into in-app tabs breaks that link and leaves a blank gsi/iframe page.
// Real child BrowserWindows keep the opener relationship while staying in-app.
export function attachPopupWindowHandling(
  webContents: WebContents,
  parent: BrowserWindow,
  onPopupCreated?: (webContents: WebContents) => void
): void {
  webContents.setUserAgent(chromeLikeUserAgent())

  webContents.setWindowOpenHandler((details) => {
    const action = resolveWindowOpenAction(details)

    if (action === 'deny') {
      return { action: 'deny' }
    }

    if (action === 'current-page') {
      void webContents.loadURL(details.url.trim()).catch(() => undefined)
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
          preload: join(__dirname, '../preload/browser-page.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: browserPartition
        }
      }
    }
  })

  webContents.on('did-create-window', (childWindow) => {
    onPopupCreated?.(childWindow.webContents)
    attachPopupWindowHandling(childWindow.webContents, parent, onPopupCreated)
  })
}
