import assert from 'node:assert/strict'
import test from 'node:test'
import type { WebContents } from 'electron'
import type { TabManager } from './tab-manager.ts'
import { BrowserAgentController, buildPageExtractionProgram } from './browser-agent.ts'

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
  let releaseFirst: (() => void) | null = null
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
  releaseFirst?.()
  await Promise.all([first, second])
  assert.equal(maximumActive, 1)
})
