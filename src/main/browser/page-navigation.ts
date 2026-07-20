import type { WebContents } from 'electron'
import { executePageJavaScript } from './page-execution.js'

const DEFAULT_QUIET_MS = 350
const DEFAULT_MAX_SETTLE_MS = 3_000
const READY_SELECTOR_STABLE_MS = 90

export type PageNavigationOptions = {
  timeoutMs: number
  signal?: AbortSignal
  quietMs?: number
  maxSettleMs?: number
  readySelector?: string
  settleDocument?: boolean
  allowRedirect?: (fromUrl: string, toUrl: string) => boolean
}

export type PageNavigationResult = {
  url: string
  durationMs: number
  domReadyMs: number
  settleMs: number
  settleReason: string
}

/**
 * Load a page until its main document is usable, then wait briefly for the DOM
 * to settle. Electron's loadURL promise waits for the full load event, which is
 * often much later than useful content on pages with trackers or lazy media.
 */
export async function loadPageAndSettle(
  webContents: WebContents,
  url: string,
  options: PageNavigationOptions
): Promise<PageNavigationResult> {
  if (webContents.isDestroyed()) {
    throw new Error('page is no longer available')
  }

  const startedAt = Date.now()
  const deadline = startedAt + options.timeoutMs
  const domReady = waitForMainDocument(webContents, options.signal, url, options.allowRedirect)

  webContents.stop()
  const load = webContents.loadURL(url)
  // Readiness below intentionally resolves before the full load event. Retain a
  // rejection handler so an eventual cancellation cannot become unhandled.
  void load.catch(() => {})

  try {
    await withDeadline(domReady, deadline, options.signal, () => webContents.stop())
    const domReadyAt = Date.now()
    if (options.settleDocument === false) {
      return {
        url: safeUrl(webContents) || url,
        durationMs: domReadyAt - startedAt,
        domReadyMs: domReadyAt - startedAt,
        settleMs: 0,
        settleReason: 'dom-ready'
      }
    }
    const settle = await withDeadline(
      waitForDocumentSettle(
        webContents,
        options.quietMs ?? DEFAULT_QUIET_MS,
        Math.min(options.maxSettleMs ?? DEFAULT_MAX_SETTLE_MS, Math.max(250, deadline - domReadyAt)),
        options.readySelector
      ),
      deadline,
      options.signal,
      () => webContents.stop()
    )
    const finishedAt = Date.now()

    return {
      url: safeUrl(webContents) || url,
      durationMs: finishedAt - startedAt,
      domReadyMs: domReadyAt - startedAt,
      settleMs: finishedAt - domReadyAt,
      settleReason: settle.reason
    }
  } catch (error) {
    webContents.stop()
    throw error
  }
}

function waitForMainDocument(
  webContents: WebContents,
  signal?: AbortSignal,
  requestedUrl = '',
  allowRedirect?: (fromUrl: string, toUrl: string) => boolean
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      webContents.removeListener('dom-ready', onReady)
      webContents.removeListener('did-fail-load', onFailed)
      webContents.removeListener('will-redirect', onRedirect)
      webContents.removeListener('destroyed', onDestroyed)
      signal?.removeEventListener('abort', onAborted)
    }
    const finish = (error?: Error): void => {
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onReady = (): void => finish()
    const onFailed = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame && errorCode !== -3) {
        finish(new Error(errorDescription || `page load failed (${errorCode})`))
      }
    }
    const onDestroyed = (): void => finish(new Error('page was closed during navigation'))
    const onAborted = (): void => finish(abortError())
    const onRedirect = (
      event: Electron.Event<Electron.WebContentsWillRedirectEventParams>,
      deprecatedUrl: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      const nextUrl = event.url || deprecatedUrl
      if ((event.isMainFrame ?? isMainFrame) && allowRedirect && !allowRedirect(requestedUrl, nextUrl)) {
        event.preventDefault()
        finish(new Error(`page redirect blocked: ${nextUrl}`))
      }
    }

    webContents.once('dom-ready', onReady)
    webContents.on('did-fail-load', onFailed)
    webContents.on('will-redirect', onRedirect)
    webContents.once('destroyed', onDestroyed)
    signal?.addEventListener('abort', onAborted, { once: true })

    if (signal?.aborted) {
      onAborted()
    }
  })
}

async function waitForDocumentSettle(
  webContents: WebContents,
  quietMs: number,
  maxSettleMs: number,
  readySelector?: string
): Promise<{ reason: string }> {
  return executePageJavaScript(
    webContents,
    buildDocumentSettleProgram(quietMs, maxSettleMs, readySelector),
  ) as Promise<{ reason: string }>
}

export function buildDocumentSettleProgram(
  quietMs: number,
  maxSettleMs: number,
  readySelector?: string
): string {
  const safeQuietMs = Math.max(100, Math.min(1_500, Math.round(quietMs)))
  const safeMaxSettleMs = Math.max(safeQuietMs, Math.min(10_000, Math.round(maxSettleMs)))
  return `(async () => {
    return await new Promise((resolve) => {
      const readySelector = ${JSON.stringify(readySelector?.trim() ?? '')};
      const startedAt = performance.now();
      let lastMutationAt = startedAt;
      let selectorMatch = null;
      let selectorSeenAt = null;
      let observer;
      let timer;
      let finished = false;
      const finish = (reason) => {
        if (finished) return;
        finished = true;
        observer?.disconnect();
        clearInterval(timer);
        resolve({ reason });
      };
      const querySelectorDeep = (selector) => {
        const roots = [document];
        for (let index = 0; index < roots.length; index += 1) {
          const root = roots[index];
          let match;
          try { match = root.querySelector(selector); }
          catch { return { match: null, invalid: true }; }
          if (match) return { match, invalid: false };
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
          }
        }
        return { match: null, invalid: false };
      };
      const isUseful = () => {
        if (!document.body) return false;
        const textLength = (document.body.innerText || '').trim().length;
        return textLength >= 120 || Boolean(document.querySelector('main, article, form, input, [role="main"]'));
      };
      if (!readySelector) {
        observer = new MutationObserver(() => { lastMutationAt = performance.now(); });
        if (document.documentElement) {
          observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        }
      }
      const tick = () => {
        const now = performance.now();
        if (readySelector) {
          const selected = querySelectorDeep(readySelector);
          if (selected.invalid) {
            finish('selector-invalid');
            return;
          }
          if (selected.match) {
            if (selected.match !== selectorMatch) {
              selectorMatch = selected.match;
              selectorSeenAt = now;
            } else if (selectorSeenAt !== null && now - selectorSeenAt >= ${READY_SELECTOR_STABLE_MS}) {
              finish('selector-ready');
              return;
            }
          } else {
            selectorMatch = null;
            selectorSeenAt = null;
          }
          if (now - startedAt >= ${safeMaxSettleMs}) finish('selector-deadline');
          return;
        }
        if (isUseful() && now - lastMutationAt >= ${safeQuietMs}) finish('dom-quiet');
        else if (now - startedAt >= ${safeMaxSettleMs}) finish(isUseful() ? 'settle-deadline' : 'content-deadline');
      };
      timer = setInterval(tick, readySelector ? 25 : 50);
      tick();
    });
  })()`
}

function withDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  signal?: AbortSignal,
  onCancel?: () => void
): Promise<T> {
  const remaining = Math.max(1, deadline - Date.now())

  return new Promise<T>((resolve, reject) => {
    let finished = false
    const finish = (callback: () => void): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAborted)
      callback()
    }
    const onAborted = (): void => finish(() => {
      onCancel?.()
      reject(abortError())
    })
    const timer = setTimeout(() => finish(() => {
      onCancel?.()
      reject(new Error(`navigation timed out after ${remaining}ms`))
    }), remaining)

    signal?.addEventListener('abort', onAborted, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )

    if (signal?.aborted) onAborted()
  })
}

function abortError(): Error {
  return new Error('navigation aborted')
}

function safeUrl(webContents: WebContents): string {
  try {
    return webContents.isDestroyed() ? '' : webContents.getURL()
  } catch {
    return ''
  }
}
