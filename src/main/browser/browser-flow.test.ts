import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { WebContents } from 'electron'
import { BrowserFlowError, runBrowserFlow } from './browser-flow.ts'

function fakeWebContents(
  execute: (program: string, emitter: EventEmitter) => Promise<unknown>,
  initialUrl = 'https://example.com/'
): WebContents & EventEmitter & { setUrl: (url: string) => void } {
  const emitter = new EventEmitter()
  let url = initialUrl
  return Object.assign(emitter, {
    executeJavaScript: (program: string) => execute(program, emitter),
    getURL: () => url,
    isDestroyed: () => false,
    setUrl: (nextUrl: string) => { url = nextUrl }
  }) as WebContents & EventEmitter & { setUrl: (url: string) => void }
}

test('browser flow treats a missing find as successful not_found data and stops', async () => {
  let calls = 0
  const webContents = fakeWebContents(async () => {
    calls += 1
    return { url: 'https://example.com/search', count: 0, matches: [] }
  }, 'https://example.com/search')

  const result = await runBrowserFlow(webContents, [
    { id: 'find-target', type: 'find', selector: 'a.target' },
    { id: 'must-not-run', type: 'click', selector: 'button' }
  ], { timeoutMs: 1_000 })

  assert.equal(result.outcome, 'not_found')
  assert.equal(result.completedSteps, 1)
  assert.deepEqual(result.stoppedAt, { index: 0, id: 'find-target' })
  assert.deepEqual(result.findings['find-target'], { count: 0, matches: [] })
  assert.equal(calls, 1)
})

test('browser flow waits for a containing state before inspecting once', async () => {
  const selectors: string[] = []
  const webContents = fakeWebContents(async (program) => {
    const selector = program.match(/const selector = ("[^"]+")/)?.[1]
    if (selector) selectors.push(JSON.parse(selector) as string)
    if (program.includes('const selector = ".results"')) {
      return { url: 'https://example.com/search', count: 1, matches: [] }
    }
    return { url: 'https://example.com/search', count: 0, matches: [] }
  }, 'https://example.com/search')

  const result = await runBrowserFlow(webContents, [
    { id: 'results-ready', type: 'wait', selector: '.results', stableMs: 0 },
    { id: 'find-target', type: 'find', selector: 'a.target' }
  ], { timeoutMs: 1_000 })

  assert.equal(result.outcome, 'not_found')
  assert.deepEqual(selectors, ['.results', 'a.target'])
})

test('browser flow preserves navigation across a destroyed action context', async () => {
  let webContents: ReturnType<typeof fakeWebContents>
  webContents = fakeWebContents(async (program, emitter) => {
    if (program.includes('const step =')) {
      webContents.setUrl('https://example.com/search?q=Playwright')
      emitter.emit('did-start-navigation', {}, webContents.getURL(), false, true)
      emitter.emit('did-navigate', {}, webContents.getURL())
      throw new Error('Execution context was destroyed, most likely because of a navigation')
    }
    return null
  })

  const result = await runBrowserFlow(webContents, [
    { type: 'submit', selector: 'form', navigation: 'auto' },
    { type: 'wait', urlContains: '/search', stableMs: 0 }
  ], { timeoutMs: 1_000 })

  assert.equal(result.outcome, 'completed')
  assert.equal(result.navigation.started, 1)
  assert.equal(result.navigation.committed, 1)
  assert.equal(result.steps[0]?.status, 'completed')
})

test('browser flow reports action selector failures with a stable code', async () => {
  const webContents = fakeWebContents(async () => ({
    ok: false,
    code: 'selectorNotFound',
    error: 'selector not found: button.missing'
  }))

  await assert.rejects(
    runBrowserFlow(webContents, [{ type: 'click', selector: 'button.missing' }], { timeoutMs: 1_000 }),
    (error: unknown) => error instanceof BrowserFlowError && error.code === 'selectorNotFound'
  )
})

test('browser flow distinguishes invalid selectors from an ordinary find miss', async () => {
  const webContents = fakeWebContents(async () => ({
    code: 'invalidSelector',
    error: 'invalid selector: unexpected token',
    count: 0,
    matches: []
  }))

  await assert.rejects(
    runBrowserFlow(webContents, [{ type: 'find', selector: '[' }], { timeoutMs: 1_000 }),
    (error: unknown) => error instanceof BrowserFlowError && error.code === 'invalidSelector'
  )
})

test('browser flow validates every step before performing the first action', async () => {
  let calls = 0
  const webContents = fakeWebContents(async () => {
    calls += 1
    return { ok: true }
  })

  await assert.rejects(
    runBrowserFlow(webContents, [
      { type: 'click', selector: 'button' },
      { type: 'wait', selector: '.ready', urlContains: '/ready' }
    ], { timeoutMs: 1_000 }),
    (error: unknown) => error instanceof BrowserFlowError && error.code === 'conditionNotMet'
  )
  assert.equal(calls, 0)
})
