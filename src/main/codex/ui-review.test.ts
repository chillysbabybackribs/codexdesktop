import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserAgentController, BrowserAgentResult } from '../browser/browser-agent.js'
import { resolveViewports, runUiReview } from './ui-review.js'

test('ui review defaults to the three calibrated viewports', () => {
  assert.deepEqual(resolveViewports(undefined).map(({ name, width, height }) => ({ name, width, height })), [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 820, height: 1180 },
    { name: 'mobile', width: 390, height: 844 }
  ])
})

test('ui review de-duplicates and orders requested viewports', () => {
  assert.deepEqual(resolveViewports(['mobile', 'desktop', 'mobile', 'unknown']).map(({ name }) => name), ['mobile', 'desktop'])
})

test('ui review returns one model image per viewport and clears emulation', async () => {
  const calls: string[] = []
  let capture = 0
  const browserAgent = {
    cdp: async (method: string): Promise<BrowserAgentResult> => {
      calls.push(method)
      if (method === 'Page.captureScreenshot') {
        capture += 1
        return { ok: true, result: { screenshot: { artifactPath: `/shots/${capture}.png`, tabId: 'tab-1' } } }
      }
      return { ok: true, result: {} }
    },
    run: async (): Promise<BrowserAgentResult> => ({ ok: true, result: { verified: true, horizontalOverflow: false } }),
    readScreenshotDataUrl: async (path: string) => `data:image/png;base64,${path}`,
    cdpEvents: async (): Promise<BrowserAgentResult> => ({ ok: true, result: { events: [] } })
  } as unknown as BrowserAgentController

  const review = await runUiReview(browserAgent, ['desktop', 'mobile'], { tabId: 'tab-1' })
  assert.equal(review.result.ok, true)
  assert.equal(review.imageUrls.length, 2)
  assert.deepEqual(calls, [
    'Emulation.setDeviceMetricsOverride',
    'Page.captureScreenshot',
    'Emulation.setDeviceMetricsOverride',
    'Page.captureScreenshot',
    'Emulation.clearDeviceMetricsOverride'
  ])
})
