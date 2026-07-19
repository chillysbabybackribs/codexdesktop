import assert from 'node:assert/strict'
import test from 'node:test'
import type { WebContents, WebFrameMain } from 'electron'
import { BROWSER_AUTOMATION_WORLD_ID, executePageJavaScript } from './page-execution.ts'

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
