import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WebContents } from 'electron'
import type { TabManager } from './tab-manager.ts'
import { BrowserAgentController, buildPageExtractionProgram } from './browser-agent.ts'
import { CdpArtifactStore } from './cdp-artifact-store.ts'

const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WAAAAABJRU5ErkJggg=='

function fakeTabs(executeJavaScript: WebContents['executeJavaScript']): TabManager {
  const webContents = {
    executeJavaScript,
    getURL: () => 'https://example.com/article',
    getTitle: () => 'Example article'
  }

  return {
    getActiveTabId: () => 'tab-1',
    resolveWebContents: () => webContents,
    listTabs: () => [{ id: 'tab-1', url: 'https://example.com/article', title: 'Example article', active: true }]
  } as unknown as TabManager
}

test('page extraction program removes media and low-value components', () => {
  const program = buildPageExtractionProgram(1_200)

  assert.match(program, /const maxChars = 1200/)
  assert.match(program, /script.*style.*img.*nav.*footer/s)
  assert.match(program, /removedImages: true/)
  assert.match(program, /return \{\n    title/)
  assert.doesNotThrow(() => new Function(program))
})

test('browser agent runs a program against the active tab', async () => {
  const controller = new BrowserAgentController(
    () => fakeTabs(async () => ({ answer: 42 }))
  )

  const result = await controller.run('return { answer: 42 }')

  assert.equal(result.ok, true)
  assert.deepEqual(result.result, { answer: 42 })
  assert.equal(result.tabId, 'tab-1')
  assert.equal(result.url, 'https://example.com/article')
})

test('browser agent serializes programs targeting the same tab', async () => {
  let releaseFirst: () => void = () => assert.fail('first browser operation was not queued')
  let active = 0
  let maximumActive = 0
  let call = 0

  const tabs = fakeTabs(async () => {
    call += 1
    active += 1
    maximumActive = Math.max(maximumActive, active)

    if (call === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    }

    active -= 1
    return call
  })
  const controller = new BrowserAgentController(() => tabs)

  const first = controller.run('return 1')
  await new Promise((resolve) => setImmediate(resolve))
  const second = controller.run('return 2')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(maximumActive, 1)
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(maximumActive, 1)
})

test('browser agent returns screenshot artifact metadata instead of base64 image data', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-browser-agent-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const debuggerApi = new FakeDebugger()
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getURL: () => 'https://example.com/page',
    getTitle: () => 'Example page'
  }) as unknown as WebContents
  const tabs = {
    getActiveTabId: () => 'tab-1',
    resolveWebContents: () => webContents,
    listTabs: () => [{ id: 'tab-1', url: 'https://example.com/page', title: 'Example page', active: true }]
  } as unknown as TabManager
  const controller = new BrowserAgentController(() => tabs, new CdpArtifactStore(root))

  const result = await controller.cdp('Page.captureScreenshot', { format: 'png' })
  const screenshot = (result.result as { screenshot: { artifactPath: string; bytes: number; width: number; height: number } }).screenshot

  assert.equal(result.ok, true)
  assert.equal('data' in (result.result as Record<string, unknown>), false)
  assert.match(screenshot.artifactPath, /\.png$/)
  assert.equal(screenshot.bytes > 0, true)
  assert.equal(screenshot.width, 1)
  assert.equal(screenshot.height, 1)
})

class FakeDebugger extends EventEmitter {
  private attached = false

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  async sendCommand(method: string): Promise<unknown> {
    if (method === 'Browser.getVersion') return { product: 'Chrome/test', protocolVersion: '1.3' }
    if (method === 'Schema.getDomains') return { domains: [{ name: 'Page', version: '1.2' }] }
    if (method === 'Page.captureScreenshot') return { data: onePixelPng }
    return {}
  }
}
