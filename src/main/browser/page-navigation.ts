import type { WebContents } from 'electron'

const DEFAULT_QUIET_MS = 350
const DEFAULT_MAX_SETTLE_MS = 3_000

export type PageNavigationOptions = {
  timeoutMs: number
  userAgent?: string
  signal?: AbortSignal
  quietMs?: number
  maxSettleMs?: number
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
  const domReady = waitForMainDocument(webContents, options.signal)

  webContents.stop()
  const load = webContents.loadURL(url, {
    ...(options.userAgent ? { userAgent: options.userAgent } : {})
  })
  // Readiness below intentionally resolves before the full load event. Retain a
  // rejection handler so an eventual cancellation cannot become unhandled.
  void load.catch(() => {})

  try {
    await withDeadline(domReady, deadline, options.signal, () => webContents.stop())
    const domReadyAt = Date.now()
    const settle = await withDeadline(
      waitForDocumentSettle(
        webContents,
        options.quietMs ?? DEFAULT_QUIET_MS,
        Math.min(options.maxSettleMs ?? DEFAULT_MAX_SETTLE_MS, Math.max(250, deadline - domReadyAt))
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

function waitForMainDocument(webContents: WebContents, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      webContents.removeListener('dom-ready', onReady)
      webContents.removeListener('did-fail-load', onFailed)
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

    webContents.once('dom-ready', onReady)
    webContents.on('did-fail-load', onFailed)
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
  maxSettleMs: number
): Promise<{ reason: string }> {
  const safeQuietMs = Math.max(100, Math.min(1_500, Math.round(quietMs)))
  const safeMaxSettleMs = Math.max(safeQuietMs, Math.min(10_000, Math.round(maxSettleMs)))
  const program = `
    return await new Promise((resolve) => {
      const startedAt = performance.now();
      let lastMutationAt = startedAt;
      let observer;
      const finish = (reason) => {
        observer?.disconnect();
        clearInterval(timer);
        resolve({ reason });
      };
      const isUseful = () => {
        if (!document.body) return false;
        const textLength = (document.body.innerText || '').trim().length;
        return textLength >= 120 || Boolean(document.querySelector('main, article, form, input, [role="main"]'));
      };
      observer = new MutationObserver(() => { lastMutationAt = performance.now(); });
      if (document.documentElement) {
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      }
      const timer = setInterval(() => {
        const now = performance.now();
        if (isUseful() && now - lastMutationAt >= ${safeQuietMs}) finish('dom-quiet');
        else if (now - startedAt >= ${safeMaxSettleMs}) finish(isUseful() ? 'settle-deadline' : 'content-deadline');
      }, 50);
    });
  `

  return webContents.executeJavaScript(`(async () => { ${program}\n})()`, true) as Promise<{ reason: string }>
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
