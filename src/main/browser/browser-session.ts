import { app, dialog, session } from 'electron'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import { safeDownloadName } from './download-policy.js'

export const browserPartition = 'persist:codex-browser'

// Google rejects user agents containing "Electron" — sign-in pages go blank.
export function chromeLikeUserAgent(): string {
  return app.userAgentFallback.replace(/\sElectron\/\S+/g, '').trim()
}

export type BrowserSessionOptions = {
  getWindow: () => BrowserWindow | null
  isUserVisibleWebContents: (webContents: WebContents) => boolean
}

export function configureBrowserSession(options: BrowserSessionOptions): void {
  const browserSession = session.fromPartition(browserPartition)
  browserSession.setUserAgent(chromeLikeUserAgent())
  browserSession.setSpellCheckerLanguages(['en-US'])
  browserSession.on('will-download', (event, item, webContents) => {
    if (!options.isUserVisibleWebContents(webContents)) {
      event.preventDefault()
      console.warn('Blocked a download initiated by a hidden browser surface', item.getURL())
      return
    }

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
