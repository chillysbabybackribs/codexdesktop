import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { WebContents } from 'electron'
import { parseHTML } from 'linkedom'
import { buildDocumentSettleProgram, loadPageAndSettle } from './page-navigation.ts'

class FakeWebContents extends EventEmitter {
  stopCalls = 0
  loadedUrl = ''
  destroyed = false
  executedPrograms: string[] = []

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

  executeJavaScript(program: string): Promise<{ reason: string }> {
    this.executedPrograms.push(program)
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

test('navigation can settle against a targeted readiness selector', async () => {
  const contents = new FakeWebContents()
  await loadPageAndSettle(
    contents as unknown as WebContents,
    'https://www.google.com/search?q=research',
    { timeoutMs: 1_000, readySelector: 'a[href] h3', quietMs: 100, maxSettleMs: 750 }
  )

  assert.match(contents.executedPrograms[0], /const readySelector = "a\[href\] h3"/)
  assert.match(contents.executedPrograms[0], /querySelectorDeep\(readySelector\)/)
  assert.match(contents.executedPrograms[0], /finish\('selector-ready'\)/)
})

test('selector readiness uses open shadow roots and ignores unrelated document mutations', async () => {
  const { document, window } = parseHTML('<html><body><main>Loading</main><div id="host"></div></body></html>')
  const host = document.querySelector('#host')
  assert.ok(host)
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = '<section><div class="notification-ready">Ready</div></section>'

  const mutationTimer = setInterval(() => {
    document.querySelector('main')?.append(document.createTextNode('.'))
  }, 10)
  const startedAt = performance.now()
  try {
    const result = await executeSettleProgram(
      buildDocumentSettleProgram(350, 500, '.notification-ready'),
      document,
      window.MutationObserver
    )
    const durationMs = performance.now() - startedAt

    assert.equal(result.reason, 'selector-ready')
    assert.ok(durationMs >= 75, `selector stability resolved too early (${durationMs}ms)`)
    assert.ok(durationMs < 300, `unrelated mutations delayed selector readiness (${durationMs}ms)`)
  } finally {
    clearInterval(mutationTimer)
  }
})

test('missing readiness selector reports a selector deadline', async () => {
  const { document, window } = parseHTML('<html><body><main>Loaded content</main></body></html>')
  const result = await executeSettleProgram(
    buildDocumentSettleProgram(100, 125, '.never-present'),
    document,
    window.MutationObserver
  )

  assert.equal(result.reason, 'selector-deadline')
})

test('navigation can block an unsafe main-frame redirect before following it', async () => {
  const contents = new FakeWebContents()
  let prevented = false
  contents.loadURL = (url: string) => {
    contents.loadedUrl = url
    setImmediate(() => contents.emit('will-redirect', {
      url: 'http://127.0.0.1/private',
      isMainFrame: true,
      preventDefault: () => { prevented = true }
    }, 'http://127.0.0.1/private', false, true, 0, 0))
    return new Promise<void>(() => {})
  }

  await assert.rejects(loadPageAndSettle(
    contents as unknown as WebContents,
    'https://example.com/start',
    {
      timeoutMs: 1_000,
      allowRedirect: (_from, to) => to.startsWith('https://example.com/')
    }
  ), /page redirect blocked/)
  assert.equal(prevented, true)
})

function executeSettleProgram(
  program: string,
  document: unknown,
  MutationObserver: unknown
): Promise<{ reason: string }> {
  const execute = new Function(
    'document',
    'MutationObserver',
    'performance',
    'setInterval',
    'clearInterval',
    `return ${program}`
  ) as (
    document: unknown,
    MutationObserver: unknown,
    performance: Performance,
    setInterval: typeof globalThis.setInterval,
    clearInterval: typeof globalThis.clearInterval
  ) => Promise<{ reason: string }>

  return execute(document, MutationObserver, performance, setInterval, clearInterval)
}
