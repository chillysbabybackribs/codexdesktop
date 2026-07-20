import assert from 'node:assert/strict'
import test from 'node:test'
import type { WebContents, WebFrameMain } from 'electron'
import { BROWSER_AUTOMATION_WORLD_ID, executePageJavaScript } from './page-execution.ts'
import {
  BROWSER_AUTOMATION_WORLD_CSP,
  BROWSER_AUTOMATION_WORLD_NAME,
  browserAutomationSecurityOrigin,
  browserAutomationWorldInfo
} from '../../shared/browser-automation-world.ts'

test('automation world has a named CSP that forbids dynamic code evaluation', () => {
  assert.equal(BROWSER_AUTOMATION_WORLD_CSP, "script-src 'none'; object-src 'none'; base-uri 'none'")
  assert.doesNotMatch(BROWSER_AUTOMATION_WORLD_CSP, /unsafe-eval|unsafe-inline/)
  assert.deepEqual(browserAutomationWorldInfo('https://example.com'), {
    securityOrigin: 'https://example.com',
    csp: BROWSER_AUTOMATION_WORLD_CSP,
    name: BROWSER_AUTOMATION_WORLD_NAME
  })
  assert.equal(browserAutomationSecurityOrigin('null'), 'https://codex-browser-automation.invalid')
  assert.equal(browserAutomationSecurityOrigin('file:///tmp/page.html'), 'https://codex-browser-automation.invalid')
})

test('page programs prefer the dedicated isolated world', async () => {
  const calls: unknown[][] = []
  const target = {
    executeJavaScriptInIsolatedWorld: async (...args: unknown[]) => {
      calls.push(args)
      return 'isolated'
    },
    executeJavaScript: async () => 'main'
  } as unknown as WebContents

  assert.equal(await executePageJavaScript(target, 'document.title'), 'isolated')
  assert.deepEqual(calls, [[BROWSER_AUTOMATION_WORLD_ID, [{ code: 'document.title' }], false]])
})

test('subframes fall back to Electron frame execution', async () => {
  const calls: unknown[][] = []
  const frame = {
    executeJavaScript: async (...args: unknown[]) => {
      calls.push(args)
      return 'frame'
    }
  } as unknown as WebFrameMain

  assert.equal(await executePageJavaScript(frame, 'location.href', true), 'frame')
  assert.deepEqual(calls, [['location.href', true]])
})
