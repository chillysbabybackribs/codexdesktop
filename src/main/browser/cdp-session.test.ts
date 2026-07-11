import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { WebContents } from 'electron'
import { CdpSession } from './cdp-session.ts'

class FakeDebugger extends EventEmitter {
  attached = false
  commands: Array<{ method: string; params?: object }> = []

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  detach(): void {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }

  async sendCommand(method: string, params?: object): Promise<unknown> {
    this.commands.push({ method, params })
    if (method === 'Browser.getVersion') {
      return {
        product: 'Chrome/150.0.0.0',
        protocolVersion: '1.3',
        revision: '@revision',
        userAgent: 'Electron test',
        jsVersion: '15.0'
      }
    }
    if (method === 'Schema.getDomains') {
      return { domains: [{ name: 'Page', version: '1.2' }, { name: 'Network', version: '1.2' }] }
    }
    return { method, params }
  }
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }
}

function fixture(): { session: CdpSession; contents: FakeWebContents } {
  const contents = new FakeWebContents()
  return {
    session: new CdpSession(contents as unknown as WebContents),
    contents
  }
}

test('CDP session performs one capability handshake before commands', async () => {
  const { session, contents } = fixture()

  const first = await session.send('Page.getLayoutMetrics')
  await session.send('Runtime.evaluate', { expression: 'document.title' })
  const capabilities = await session.capabilities()

  assert.deepEqual(contents.debugger.commands.map(({ method }) => method), [
    'Browser.getVersion',
    'Schema.getDomains',
    'Page.getLayoutMetrics',
    'Runtime.evaluate'
  ])
  assert.deepEqual(first, { method: 'Page.getLayoutMetrics', params: {} })
  assert.equal(capabilities.product, 'Chrome/150.0.0.0')
  assert.equal(capabilities.protocolVersion, '1.3')
  assert.deepEqual(capabilities.domains.map(({ name }) => name), ['Page', 'Network'])
})

test('CDP event journal filters buffered events and resolves waits', async () => {
  const { session, contents } = fixture()
  await session.capabilities()
  const waiting = session.waitForEvent({
    method: 'Page.lifecycleEvent',
    afterSequence: 0,
    filter: { name: 'networkIdle' }
  }, 250)

  contents.debugger.emit('message', {}, 'Page.lifecycleEvent', { name: 'load', frameId: 'one' })
  contents.debugger.emit('message', {}, 'Page.lifecycleEvent', { name: 'networkIdle', frameId: 'two' })

  const event = await waiting
  assert.equal(event.sequence, 2)
  assert.equal((event.params as { name: string }).name, 'networkIdle')
  assert.deepEqual(session.eventPage({ contains: { frameId: 'tw' } }).events.map(({ sequence }) => sequence), [2])
})

test('CDP event journal remains bounded and reports dropped events', () => {
  const { session, contents } = fixture()
  for (let index = 1; index <= 270; index += 1) {
    contents.debugger.emit('message', {}, 'Network.dataReceived', { index })
  }

  const page = session.eventPage({ method: 'Network.dataReceived', limit: 100 })
  assert.equal(page.events.length, 100)
  assert.equal(page.latestSequence, 270)
  assert.equal(page.oldestSequence, 15)
  assert.equal(page.droppedEvents, 14)
})

test('CDP event journal bounds large event payloads without returning partial JSON', () => {
  const { session, contents } = fixture()
  contents.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { text: 'x'.repeat(20_000) })

  const page = session.eventPage()
  const event = page.events[0]

  assert.equal(page.events.length, 1)
  assert.equal((event.params as { truncated: boolean }).truncated, true)
  assert.equal((event.params as { originalChars: number }).originalChars > 20_000, true)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(page)))
  assert.equal(JSON.stringify(page).length < 10_000, true)
})

test('preparing lifecycle and network events enables their domains', async () => {
  const { session, contents } = fixture()

  await session.prepareForEvent('Page.lifecycleEvent')
  await session.prepareForEvent('Network.responseReceived')

  assert.deepEqual(contents.debugger.commands.map(({ method }) => method), [
    'Browser.getVersion',
    'Schema.getDomains',
    'Page.enable',
    'Page.setLifecycleEventsEnabled',
    'Network.enable'
  ])
})
