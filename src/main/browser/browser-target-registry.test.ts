import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { WebContents } from 'electron'
import type { ManagedBrowserTab } from './browser-tab-model.ts'
import { BrowserTargetRegistry } from './browser-target-registry.ts'

class FakeWebContents extends EventEmitter {
  destroyed = false
  readonly id: number
  private readonly url: string
  private readonly title: string

  constructor(id: number, url: string, title: string) {
    super()
    this.id = id
    this.url = url
    this.title = title
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }
}

function fakeTab(id: string, contents: FakeWebContents): ManagedBrowserTab {
  return {
    id,
    view: { webContents: contents as unknown as WebContents } as ManagedBrowserTab['view'],
    title: 'fallback title',
    url: 'https://fallback.example',
    favicon: null,
    isLoading: false,
    isAudible: false,
    isMuted: false,
    suppressVisits: false
  }
}

test('registers, resolves, lists, and removes popup targets', () => {
  const registry = new BrowserTargetRegistry()
  const tabContents = new FakeWebContents(1, 'https://tab.example', 'Tab')
  const popupContents = new FakeWebContents(2, 'https://login.example', 'Login')
  const tab = fakeTab('tab-1', tabContents)

  registry.registerPopup(popupContents as unknown as WebContents, tab.id)

  assert.equal(registry.resolvePopup('popup-2'), popupContents)
  assert.equal(registry.contains(popupContents as unknown as WebContents), true)
  assert.deepEqual(registry.list([tab], tab.id), [
    {
      id: 'tab-1',
      kind: 'tab',
      url: 'https://tab.example',
      title: 'Tab',
      active: true,
      openerTabId: null
    },
    {
      id: 'popup-2',
      kind: 'popup',
      url: 'https://login.example',
      title: 'Login',
      active: false,
      openerTabId: 'tab-1'
    }
  ])

  popupContents.destroyed = true
  popupContents.emit('destroyed')
  assert.equal(registry.resolvePopup('popup-2'), null)
  assert.equal(registry.list([tab], tab.id).length, 1)
})

test('ignores popups that are already destroyed', () => {
  const registry = new BrowserTargetRegistry()
  const popup = new FakeWebContents(4, '', '')
  popup.destroyed = true

  registry.registerPopup(popup as unknown as WebContents, 'tab-1')
  assert.deepEqual(registry.list([], null), [])
})
