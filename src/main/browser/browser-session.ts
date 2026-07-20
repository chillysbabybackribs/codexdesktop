import { app, dialog, session } from 'electron'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import { browserUserAgentFallback } from './browser-identity.js'
import { installGoogleAuthClientHints } from './browser-auth-client-hints.js'
import { browserDownloadCaptureBroker } from './browser-download-capture.js'
import { safeDownloadName } from './download-policy.js'

export const browserPartition = 'persist:codex-browser'
// Background public-web workers must not inherit the visible browser's login
// cookies or local storage. Authenticated/account work stays in the live lane.
export const researchPartition = 'persist:codex-research'

/**
 * Must run before Chromium creates any browser session or WebContents. Keeping
 * this at the app fallback layer preserves Chromium's native UA Client Hints
 * and avoids attaching DevTools to tabs during ordinary manual browsing.
 */
export function configureBrowserUserAgentFallback(): void {
  app.userAgentFallback = browserUserAgentFallback(app.userAgentFallback, app.getName())
}

export type BrowserSessionOptions = {
  getWindow: () => BrowserWindow | null
  isUserVisibleWebContents: (webContents: WebContents) => boolean
}

// Permissions we let untrusted guest pages hold without a prompt. Everything
// else (geolocation, camera/microphone via `media`, clipboard-read, MIDI, USB,
// serial, etc.) is denied: the embedded browser has no UI to review a grant,
// and a silent default-allow would let a hostile page read the OS clipboard or
// tap hardware. `clipboard-sanitized-write` stays denied — the app's own
// auto-copy path handles writes through a sender-validated IPC channel.
const allowedGuestPermissions = new Set(['fullscreen', 'pointerLock'])

export function configureBrowserSession(options: BrowserSessionOptions): void {
  for (const partition of [browserPartition, researchPartition]) {
    const browserSession = session.fromPartition(partition)
    browserSession.setSpellCheckerLanguages(['en-US'])
    // Only the visible browser handles interactive Google sign-in. The research
    // partition never logs a human in, so it keeps its native Client Hints.
    if (partition === browserPartition) {
      installGoogleAuthClientHints(browserSession, app.userAgentFallback)
    }
    browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(allowedGuestPermissions.has(permission))
    })
    browserSession.setPermissionCheckHandler((_webContents, permission) =>
      allowedGuestPermissions.has(permission)
    )
    browserSession.on('will-download', (event, item, webContents) => {
      if (partition === researchPartition || !options.isUserVisibleWebContents(webContents)) {
        event.preventDefault()
        console.warn('Blocked a download initiated by a hidden browser surface', item.getURL())
        return
      }

      if (browserDownloadCaptureBroker.handleWillDownload(item, webContents)) return

      const window = options.getWindow()
      if (!window) {
        event.preventDefault()
        return
      }

      item.pause()
      const filename = safeDownloadName(item.getFilename())
      void dialog.showSaveDialog(window, {
        title: 'Save download',
        defaultPath: join(app.getPath('downloads'), filename)
      }).then((result) => {
        if (result.canceled || !result.filePath) {
          item.cancel()
          return
        }

        item.setSavePath(result.filePath)
        item.resume()
      }).catch((error) => {
        console.error('Failed to choose a download destination', error)
        item.cancel()
      })
    })
  }
}
