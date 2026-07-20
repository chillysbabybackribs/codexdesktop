import type { WebContents, WebFrameMain, WebSource } from 'electron'
import { BROWSER_AUTOMATION_WORLD_ID } from '../../shared/browser-automation-world.js'

export { BROWSER_AUTOMATION_WORLD_ID } from '../../shared/browser-automation-world.js'

type PageExecutionTarget = WebContents | WebFrameMain

/**
 * Execute browser-owned code in the constrained isolated world configured by
 * the guest preload whenever Electron exposes that API. WebFrameMain does not
 * currently provide an isolated-world method, so subframe execution retains
 * Electron's frame evaluator and the frame's own CSP.
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
