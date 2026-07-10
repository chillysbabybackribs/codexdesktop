import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { WebContents } from 'electron'
import { loadPageAndSettle } from './page-navigation.ts'

class FakeWebContents extends EventEmitter {
  stopCalls = 0
  loadedUrl = ''
  destroyed = false

  stop(): void {
    this.stopCalls += 1
  }

  loadURL(url: string): Promise<void> {
    this.loadedUrl = url
    setImmediate(() => this.emit('dom-ready'))
    // Full page load deliberately remains pending. The readiness coordinator
    // should resolve from DOM readiness and document settling instead.
    return new Promise<void>(() => {})
  }

  executeJavaScript(): Promise<{ reason: string }> {
    return Promise.resolve({ reason: 'dom-quiet' })
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return this.loadedUrl
  }
}

test('navigation resolves from useful document readiness before full load', async () => {
  const contents = new FakeWebContents()
  const result = await loadPageAndSettle(
    contents as unknown as WebContents,
    'https://example.com/article',
    { timeoutMs: 1_000 }
  )

  assert.equal(result.url, 'https://example.com/article')
  assert.equal(result.settleReason, 'dom-quiet')
  assert.equal(contents.stopCalls, 1)
})

test('aborting navigation stops the underlying page load', async () => {
  const contents = new FakeWebContents()
  contents.loadURL = (url: string) => {
    contents.loadedUrl = url
    return new Promise<void>(() => {})
  }
  const controller = new AbortController()
  const navigation = loadPageAndSettle(
    contents as unknown as WebContents,
    'https://example.com/slow',
    { timeoutMs: 1_000, signal: controller.signal }
  )
  controller.abort()

  await assert.rejects(navigation, /navigation aborted/)
  assert.ok(contents.stopCalls >= 2)
})
