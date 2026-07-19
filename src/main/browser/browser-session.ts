import { app, dialog, session } from 'electron'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import { buildBrowserIdentity, type BrowserIdentity } from './browser-identity.js'
import { cdpSessionFor } from './cdp-session.js'
import { safeDownloadName } from './download-policy.js'

export const browserPartition = 'persist:codex-browser'

let cachedBrowserIdentity: BrowserIdentity | null = null
const browserIdentityPromises = new WeakMap<WebContents, Promise<void>>()
const watchedBrowserIdentities = new WeakSet<WebContents>()

function browserIdentity(): BrowserIdentity {
  cachedBrowserIdentity ??= buildBrowserIdentity({
    chromeVersion: process.versions.chrome || chromeVersionFromFallback(app.userAgentFallback),
    platform: process.platform,
    architecture: process.arch
  })
  return cachedBrowserIdentity
}

// Trust-sensitive sites reject both Electron and application-name UA tokens.
export function chromeLikeUserAgent(): string {
  return browserIdentity().userAgent
}

/**
 * Apply the same identity to HTTP headers, navigator.userAgent, and UA Client
 * Hints before a guest page loads. Session.setUserAgent alone leaves
 * navigator.userAgentData empty in Electron, which is itself a strong shell
 * fingerprint on sites that compare the two surfaces.
 */
export function ensureBrowserIdentity(webContents: WebContents): Promise<void> {
  if (webContents.isDestroyed()) return Promise.resolve()
  webContents.setUserAgent(chromeLikeUserAgent())

  if (!watchedBrowserIdentities.has(webContents)) {
    watchedBrowserIdentities.add(webContents)
    const debuggerClient = webContents.debugger
    const onDebuggerDetach = (): void => {
      // DevTools can temporarily replace our debugger client. Retry the native
      // UA-CH override before the next app-driven navigation.
      browserIdentityPromises.delete(webContents)
    }
    debuggerClient.on('detach', onDebuggerDetach)
    webContents.once('destroyed', () => {
      // Accessing webContents.debugger after the destroyed event can throw
      // "Object has been destroyed" in Electron. The retained Debugger handle
      // remains an EventEmitter long enough for best-effort listener cleanup.
      try {
        debuggerClient.off('detach', onDebuggerDetach)
      } catch {
        // The native debugger object may already be finalized too.
      }
    })
  }

  const existing = browserIdentityPromises.get(webContents)
  if (existing) return existing

  const identity = browserIdentity()
  let ready: Promise<void>
  ready = withTimeout(
    cdpSessionFor(webContents).send('Network.setUserAgentOverride', {
      userAgent: identity.userAgent,
      acceptLanguage: identity.acceptLanguage,
      userAgentMetadata: identity.userAgentMetadata
    }),
    2_000
  ).then(() => undefined).catch((error) => {
    // A closing target or open DevTools client can temporarily own the CDP
    // channel. The clean session/WebContents UA remains the compatibility floor.
    if (!/target closed|destroyed|disposed|detached/i.test(String(error))) {
      console.warn('Could not apply browser UA Client Hints override', error)
    }
    if (browserIdentityPromises.get(webContents) === ready) {
      browserIdentityPromises.delete(webContents)
    }
  })
  browserIdentityPromises.set(webContents, ready)
  return ready
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
  const browserSession = session.fromPartition(browserPartition)
  const identity = browserIdentity()
  browserSession.setUserAgent(identity.userAgent, identity.acceptLanguage)
  browserSession.setSpellCheckerLanguages(['en-US'])
  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowedGuestPermissions.has(permission))
  })
  browserSession.setPermissionCheckHandler((_webContents, permission) =>
    allowedGuestPermissions.has(permission)
  )
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

function chromeVersionFromFallback(userAgent: string): string {
  return /\bChrome\/([\d.]+)/.exec(userAgent)?.[1] ?? '1.0.0.0'
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`browser identity setup timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
