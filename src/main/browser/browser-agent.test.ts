import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WebContents, WebFrameMain } from 'electron'
import type { TabManager } from './tab-manager.ts'
import {
  BrowserAgentController,
  MAX_PARALLEL_BROWSER_FRAMES,
  MAX_PARALLEL_BROWSER_TARGETS,
  buildPageExtractionProgram
} from './browser-agent.ts'
import { CdpArtifactStore } from './cdp-artifact-store.ts'

const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WAAAAABJRU5ErkJggg=='
const minimalPdf = Buffer.from('%PDF-1.4\nminimal\n%%EOF').toString('base64')
const basicDomSnapshot = {
  strings: ['#document', 'HTML', 'BODY', 'A', '#text', 'href', '/docs', 'Read docs'],
  documents: [{
    documentURL: 6,
    nodes: {
      nodeName: [0, 1, 2, 3, 4],
      nodeType: [9, 1, 1, 1, 3],
      nodeValue: [-1, -1, -1, -1, 7],
      parentIndex: [-1, 0, 1, 2, 3],
      backendNodeId: [1, 2, 3, 4, 5],
      attributes: [[], [], [], [5, 6], []]
    },
    layout: { nodeIndex: [3], bounds: [[10, 20, 100, 30]] }
  }]
}

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

test('browser agent runs one program across all live frames in parallel', async () => {
  let active = 0
  let maximumActive = 0
  const execute = (label: string) => async (): Promise<unknown> => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setImmediate(resolve))
    active -= 1
    return { label }
  }
  const main = {} as WebFrameMain
  const child = {} as WebFrameMain
  Object.assign(main, {
    frameTreeNodeId: 10,
    parent: null,
    name: '',
    url: 'https://example.com',
    origin: 'https://example.com',
    detached: false,
    isDestroyed: () => false,
    executeJavaScript: execute('main'),
    framesInSubtree: [main, child]
  })
  Object.assign(child, {
    frameTreeNodeId: 11,
    parent: main,
    name: 'checkout',
    url: 'https://payments.example/frame',
    origin: 'https://payments.example',
    detached: false,
    isDestroyed: () => false,
    executeJavaScript: execute('child'),
    framesInSubtree: [child]
  })
  const webContents = {
    mainFrame: main,
    executeJavaScript: execute('fallback'),
    getURL: () => 'https://example.com',
    getTitle: () => 'Frames'
  } as unknown as WebContents
  const tabs = {
    getActiveTabId: () => 'tab-1',
    resolveWebContents: () => webContents,
    listTabs: () => [],
    listTargets: () => []
  } as unknown as TabManager

  const result = await new BrowserAgentController(() => tabs).run('return location.href', { frame: 'all' })
  const batch = result.result as { frameCount: number; succeeded: number; frames: Array<{ frame: { frameId: string; parentFrameId: string | null }; result: unknown }> }

  assert.equal(result.ok, true)
  assert.equal(maximumActive, 2)
  assert.equal(batch.frameCount, 2)
  assert.equal(batch.succeeded, 2)
  assert.deepEqual(batch.frames.map(({ frame }) => [frame.frameId, frame.parentFrameId]), [['10', null], ['11', '10']])
})

test('all-frame execution contains a disappearing frame failure without losing other results', async () => {
  const main = {} as WebFrameMain
  const child = {} as WebFrameMain
  Object.assign(main, {
    frameTreeNodeId: 20, parent: null, name: '', url: 'https://example.com', origin: 'https://example.com',
    detached: false, isDestroyed: () => false, executeJavaScript: async () => 'main', framesInSubtree: [main, child]
  })
  Object.assign(child, {
    frameTreeNodeId: 21, parent: main, name: 'transient', url: 'about:blank', origin: 'https://example.com',
    detached: false, isDestroyed: () => false,
    executeJavaScript: async () => { throw new Error('frame was disposed') },
    framesInSubtree: [child]
  })
  const webContents = {
    mainFrame: main,
    executeJavaScript: async () => 'main',
    getURL: () => 'https://example.com',
    getTitle: () => 'Frames'
  } as unknown as WebContents
  const tabs = {
    getActiveTabId: () => 'tab-1', resolveWebContents: () => webContents, listTabs: () => [], listTargets: () => []
  } as unknown as TabManager

  const result = await new BrowserAgentController(() => tabs).run('return 1', { frame: 'all' })
  const batch = result.result as { succeeded: number; failed: number; frames: Array<{ ok: boolean; error?: string }> }
  assert.equal(result.ok, true)
  assert.equal(batch.succeeded, 1)
  assert.equal(batch.failed, 1)
  assert.match(batch.frames[1].error ?? '', /disposed/)
  assert.equal((batch.frames[1] as { errorCode?: string }).errorCode, 'frameDetached')
  assert.deepEqual((batch as { frameInventory?: Array<{ frameId: string }> }).frameInventory?.map(({ frameId }) => frameId), ['20', '21'])
})

test('browser agent runs one program across all tab targets in parallel', async () => {
  let active = 0
  let maximumActive = 0
  const targetContents = new Map(['one', 'two'].map((id) => [id, {
    executeJavaScript: async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      return id
    },
    getURL: () => `https://${id}.example`,
    getTitle: () => id
  } as unknown as WebContents]))
  const tabs = {
    getActiveTabId: () => 'one',
    resolveWebContents: (id: string) => targetContents.get(id) ?? null,
    listTabs: () => [],
    listTargets: () => ['one', 'two'].map((id) => ({ id, kind: 'tab', url: `https://${id}.example`, title: id, active: id === 'one', openerTabId: null }))
  } as unknown as TabManager

  const result = await new BrowserAgentController(() => tabs).run('return location.href', { tabId: 'all' })
  const batch = result.result as { targetCount: number; succeeded: number; targets: Array<{ ok: boolean }> }
  assert.equal(result.ok, true)
  assert.equal(maximumActive, 2)
  assert.equal(batch.targetCount, 2)
  assert.equal(batch.succeeded, 2)
  assert.deepEqual(batch.targets.map(({ ok }) => ok), [true, true])
})

test('all-target execution uses bounded parallel waves', async () => {
  let active = 0
  let maximumActive = 0
  const ids = Array.from({ length: MAX_PARALLEL_BROWSER_TARGETS + 3 }, (_, index) => `target-${index}`)
  const contents = new Map(ids.map((id) => [id, {
    executeJavaScript: async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      return id
    },
    getURL: () => `https://${id}.example`,
    getTitle: () => id
  } as unknown as WebContents]))
  const tabs = {
    getActiveTabId: () => ids[0],
    resolveWebContents: (id: string) => contents.get(id) ?? null,
    listTabs: () => [],
    listTargets: () => ids.map((id) => ({ id, kind: 'tab', url: `https://${id}.example`, title: id, active: id === ids[0], openerTabId: null }))
  } as unknown as TabManager

  const result = await new BrowserAgentController(() => tabs).run('return location.href', { tabId: 'all' })
  const batch = result.result as { targetCount: number; maxConcurrency: number; succeeded: number }
  assert.equal(result.ok, true)
  assert.equal(batch.targetCount, ids.length)
  assert.equal(batch.succeeded, ids.length)
  assert.equal(batch.maxConcurrency, MAX_PARALLEL_BROWSER_TARGETS)
  assert.equal(maximumActive, MAX_PARALLEL_BROWSER_TARGETS)
})

test('all-frame execution uses bounded parallel waves', async () => {
  let active = 0
  let maximumActive = 0
  const frames = Array.from({ length: MAX_PARALLEL_BROWSER_FRAMES + 2 }, (_, index) => ({
    frameTreeNodeId: 100 + index,
    parent: null,
    name: `frame-${index}`,
    url: `https://frame-${index}.example`,
    origin: `https://frame-${index}.example`,
    detached: false,
    isDestroyed: () => false,
    executeJavaScript: async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      return index
    }
  })) as unknown as WebFrameMain[]
  Object.assign(frames[0], { framesInSubtree: frames })
  for (const frame of frames.slice(1)) Object.assign(frame, { parent: frames[0], framesInSubtree: [frame] })
  const webContents = {
    mainFrame: frames[0], executeJavaScript: async () => 0, getURL: () => 'https://main.example', getTitle: () => 'Frames'
  } as unknown as WebContents
  const tabs = {
    getActiveTabId: () => 'tab-1', resolveWebContents: () => webContents, listTabs: () => [], listTargets: () => []
  } as unknown as TabManager

  const result = await new BrowserAgentController(() => tabs).run('return location.href', { frame: 'all' })
  const batch = result.result as { frameCount: number; maxConcurrency: number; succeeded: number }
  assert.equal(result.ok, true)
  assert.equal(batch.frameCount, frames.length)
  assert.equal(batch.succeeded, frames.length)
  assert.equal(batch.maxConcurrency, MAX_PARALLEL_BROWSER_FRAMES)
  assert.equal(maximumActive, MAX_PARALLEL_BROWSER_FRAMES)
})

test('fan-out result governor preserves a structured envelope under oversized output', async () => {
  const ids = ['one', 'two', 'three']
  const contents = new Map(ids.map((id) => [id, {
    executeJavaScript: async () => ({ id, payload: 'x'.repeat(20_000) }),
    getURL: () => `https://${id}.example`,
    getTitle: () => id
  } as unknown as WebContents]))
  const tabs = {
    getActiveTabId: () => ids[0],
    resolveWebContents: (id: string) => contents.get(id) ?? null,
    listTabs: () => [],
    listTargets: () => ids.map((id) => ({ id, kind: 'tab', url: `https://${id}.example`, title: id, active: id === ids[0], openerTabId: null }))
  } as unknown as TabManager

  const result = await new BrowserAgentController(() => tabs).run('return window.largePayload', {
    tabId: 'all',
    maxResultChars: 2_000
  })
  const batch = result.result as { targetCount: number; targets: unknown[]; omittedItems: number; truncated: boolean }
  assert.equal(result.ok, true)
  assert.equal(typeof result.result, 'object')
  assert.equal(batch.targetCount, 3)
  assert.equal(batch.truncated, true)
  assert.equal(batch.omittedItems > 0 || batch.targets.some((target) => (target as { truncated?: boolean }).truncated), true)
  assert.equal(JSON.stringify(result.result).length <= 2_000, true)
})

test('missing frame failures return a stable code and fresh frame inventory', async () => {
  const main = Object.assign({} as WebFrameMain, {
    frameTreeNodeId: 30, parent: null, name: '', url: 'https://example.com', origin: 'https://example.com',
    detached: false, isDestroyed: () => false, executeJavaScript: async () => null
  })
  Object.assign(main, { framesInSubtree: [main] })
  const webContents = {
    mainFrame: main, executeJavaScript: async () => null, getURL: () => 'https://example.com', getTitle: () => 'Main'
  } as unknown as WebContents
  const tabs = {
    getActiveTabId: () => 'tab-1', resolveWebContents: () => webContents, listTabs: () => [], listTargets: () => []
  } as unknown as TabManager

  const result = await new BrowserAgentController(() => tabs).run('return 1', { frame: 'missing' })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'frameNotFound')
  assert.deepEqual(result.targetState?.frames?.map(({ frameId }) => frameId), ['30'])
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

test('browser agent returns PDF artifact metadata instead of base64 document data', async (context) => {
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

  const result = await controller.cdp('Page.printToPDF')
  const pdf = (result.result as { pdf: { artifactPath: string; bytes: number; kind: string } }).pdf

  assert.equal(result.ok, true)
  assert.equal('data' in (result.result as Record<string, unknown>), false)
  assert.match(pdf.artifactPath, /\.pdf$/)
  assert.equal(pdf.kind, 'pdf')
  assert.equal(pdf.bytes > 0, true)
})

test('browser agent falls back to Electron PDF export when the embedded CDP target lacks Page.printToPDF', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'codexdesktop-browser-agent-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const debuggerApi = new FakeDebugger()
  debuggerApi.unsupportedPdf = true
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getURL: () => 'https://example.com/page',
    getTitle: () => 'Example page',
    printToPDF: async () => Buffer.from('%PDF-1.4\nfallback\n%%EOF')
  }) as unknown as WebContents
  const tabs = {
    getActiveTabId: () => 'tab-1',
    resolveWebContents: () => webContents,
    listTabs: () => [{ id: 'tab-1', url: 'https://example.com/page', title: 'Example page', active: true }]
  } as unknown as TabManager
  const controller = new BrowserAgentController(() => tabs, new CdpArtifactStore(root))

  const result = await controller.cdp('Page.printToPDF')
  const pdf = (result.result as { pdf: { artifactPath: string; bytes: number } }).pdf

  assert.equal(result.ok, true)
  assert.match(pdf.artifactPath, /\.pdf$/)
  assert.equal(pdf.bytes > 0, true)
})

test('browser agent stores the raw DOM snapshot and returns a compact interaction model', async (context) => {
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

  const result = await controller.captureDomSnapshot({ maxNodes: 20 })
  const snapshot = (result.result as { snapshot: { artifactPath: string; kind: string; model: { nodeCount: number; nodes: Array<{ role: string }> } } }).snapshot

  assert.equal(result.ok, true)
  assert.match(snapshot.artifactPath, /\.json$/)
  assert.equal(snapshot.kind, 'snapshot')
  assert.equal(snapshot.model.nodeCount, 1)
  assert.equal(snapshot.model.nodes[0]?.role, 'link')
})

test('browser agent returns a bounded network journal and materializes a response body', async (context) => {
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

  assert.equal((await controller.startNetworkJournal()).ok, true)
  debuggerApi.emit('message', {}, 'Network.requestWillBeSent', {
    requestId: 'request-1', type: 'Fetch', timestamp: 1,
    request: { url: 'https://example.com/api/data', method: 'GET', headers: { cookie: 'secret' } }
  })
  debuggerApi.emit('message', {}, 'Network.responseReceived', {
    requestId: 'request-1', type: 'Fetch',
    response: { status: 200, mimeType: 'application/json', protocol: 'h2' }
  })
  debuggerApi.emit('message', {}, 'Network.loadingFinished', {
    requestId: 'request-1', timestamp: 1.05, encodedDataLength: 11
  })

  const journalResult = await controller.readNetworkJournal({ urlContains: '/api/' })
  const network = (journalResult.result as { network: { requests: Array<{ requestId: string }>; active: boolean } }).network
  assert.equal(network.active, true)
  assert.deepEqual(network.requests.map(({ requestId }) => requestId), ['request-1'])
  assert.equal(JSON.stringify(network).includes('secret'), false)

  const bodyResult = await controller.captureNetworkResponseBody('request-1')
  const body = (bodyResult.result as { responseBody: { artifactPath: string; kind: string; requestUrl: string } }).responseBody
  assert.equal(bodyResult.ok, true)
  assert.equal(body.kind, 'response-body')
  assert.equal(body.requestUrl, 'https://example.com/api/data')
  assert.equal(await (await import('node:fs/promises')).readFile(body.artifactPath, 'utf8'), '{"ok":true}')
})

class FakeDebugger extends EventEmitter {
  private attached = false
  unsupportedPdf = false

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  async sendCommand(method: string, _params?: object): Promise<unknown> {
    if (method === 'Browser.getVersion') return { product: 'Chrome/test', protocolVersion: '1.3' }
    if (method === 'Schema.getDomains') return { domains: [{ name: 'Page', version: '1.2' }] }
    if (method === 'Page.captureScreenshot') return { data: onePixelPng }
    if (method === 'Page.printToPDF') {
      if (this.unsupportedPdf) throw new Error("'Page.printToPDF' wasn't found")
      return { data: minimalPdf }
    }
    if (method === 'DOMSnapshot.captureSnapshot') return basicDomSnapshot
    if (method === 'Network.getResponseBody') return { body: '{"ok":true}', base64Encoded: false }
    return {}
  }
}
