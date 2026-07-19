import type { WebContents, WebFrameMain, WebSource } from 'electron'

// Electron reserves world 999 for its context-isolated preload. Keep browser
// automation in a separate, stable world so strict page CSP remains intact and
// page scripts cannot observe our temporary helpers on globalThis.
export const BROWSER_AUTOMATION_WORLD_ID = 1_001

type PageExecutionTarget = WebContents | WebFrameMain

/**
 * Execute browser-owned code in an isolated world whenever Electron exposes
 * that API. WebFrameMain does not currently provide an isolated-world method,
 * so subframe execution retains Electron's privileged frame evaluator.
 */
export function executePageJavaScript(
  target: PageExecutionTarget,
  code: string,
  userGesture = false
): Promise<unknown> {
  const isolated = (target as WebContents).executeJavaScriptInIsolatedWorld
  if (typeof isolated === 'function') {
    const scripts: WebSource[] = [{ code }]
    return isolated.call(target, BROWSER_AUTOMATION_WORLD_ID, scripts, userGesture)
  }
  return target.executeJavaScript(code, userGesture)
}
