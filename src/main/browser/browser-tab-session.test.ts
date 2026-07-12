import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { NavigationEntry, WebContents } from 'electron'
import type { ManagedBrowserTab } from './browser-tab-model.ts'
import { captureBrowserSnapshot, hydrateSavedBrowserTab } from './browser-tab-session.ts'

class FakeWebContents extends EventEmitter {
  destroyed = false
  url = ''
  title = ''
  entries: NavigationEntry[] = []
  activeIndex = 0
  restored: { entries: NavigationEntry[]; index: number } | null = null
  stopCount = 0

  navigationHistory = {
    canGoBack: () => this.activeIndex > 0,
    canGoForward: () => this.activeIndex < this.entries.length - 1,
    getAllEntries: () => this.entries,
    getActiveIndex: () => this.activeIndex,
    restore: async (state: { entries: NavigationEntry[]; index: number }) => {
      this.restored = state
      this.entries = state.entries
      this.activeIndex = state.index
      this.url = state.entries[state.index]?.url ?? ''
    }
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

  stop(): void {
    this.stopCount += 1
  }
}

function fakeTab(id: string, contents: FakeWebContents): ManagedBrowserTab {
  return {
    id,
    view: { webContents: contents as unknown as WebContents } as ManagedBrowserTab['view'],
    title: contents.title || 'Saved title',
    url: contents.url,
    favicon: null,
    isLoading: true,
    isAudible: false,
    isMuted: false,
    suppressVisits: true
  }
}

test('captures navigation history and the active tab index', () => {
  const firstContents = new FakeWebContents()
  firstContents.url = 'https://first.example/'
  firstContents.entries = [{ url: firstContents.url, title: 'First' }]
  const secondContents = new FakeWebContents()
  secondContents.url = 'https://second.example/two'
  secondContents.entries = [
    { url: 'https://second.example/one', title: 'One' },
    { url: secondContents.url, title: 'Two' }
  ]
  secondContents.activeIndex = 1

  const snapshot = captureBrowserSnapshot(
    [fakeTab('first', firstContents), fakeTab('second', secondContents)],
    'second'
  )

  assert.equal(snapshot?.activeTabIndex, 1)
  assert.equal(snapshot?.tabs[1]?.url, 'https://second.example/two')
  assert.equal(snapshot?.tabs[1]?.activeIndex, 1)
  assert.equal(snapshot?.tabs[1]?.entries.length, 2)
})

test('drops destroyed and empty tabs from snapshots', () => {
  const destroyed = new FakeWebContents()
  destroyed.destroyed = true
  const blank = new FakeWebContents()
  blank.url = 'about:blank'
  ;(blank as { navigationHistory?: unknown }).navigationHistory = undefined

  assert.equal(captureBrowserSnapshot([fakeTab('destroyed', destroyed), fakeTab('blank', blank)], null), null)
})

test('restores safe history while filtering unsafe entries', async () => {
  const contents = new FakeWebContents()
  const tab = fakeTab('restored', contents)
  const navigations: string[] = []

  await hydrateSavedBrowserTab(
    tab,
    {
      title: 'Saved',
      url: 'https://example.com/two',
      favicon: null,
      entries: [
        { url: 'file:///etc/passwd', title: 'Unsafe' },
        { url: 'https://example.com/one', title: 'One' },
        { url: 'https://example.com/two', title: 'Two' }
      ],
      activeIndex: 20
    },
    'https://www.google.com',
    async (url) => {
      navigations.push(url)
    }
  )

  assert.deepEqual(contents.restored?.entries.map((entry) => entry.url), [
    'https://example.com/one',
    'https://example.com/two'
  ])
  assert.equal(contents.restored?.index, 1)
  assert.equal(tab.url, 'https://example.com/two')
  assert.equal(tab.isLoading, false)
  assert.equal(tab.suppressVisits, false)
  assert.deepEqual(navigations, [])
})

test('falls back to the default page when saved navigation is unsafe', async () => {
  const contents = new FakeWebContents()
  const tab = fakeTab('unsafe', contents)
  const navigations: string[] = []

  await hydrateSavedBrowserTab(
    tab,
    {
      title: 'Unsafe',
      url: 'javascript:alert(1)',
      favicon: null,
      entries: [],
      activeIndex: 0
    },
    'https://www.google.com',
    async (url) => {
      navigations.push(url)
      contents.url = url
    }
  )

  assert.deepEqual(navigations, ['https://www.google.com'])
  assert.equal(tab.url, 'https://www.google.com')
  assert.equal(tab.title, 'New Tab')
})

test('stops a hung history restore and falls back to direct navigation', async () => {
  const contents = new FakeWebContents()
  const tab = fakeTab('hung-history', contents)
  const navigations: string[] = []
  contents.navigationHistory.restore = async () => await new Promise<void>(() => {})

  await hydrateSavedBrowserTab(
    tab,
    {
      title: 'Saved',
      url: 'https://example.com/current',
      favicon: null,
      entries: [{ url: 'https://example.com/current', title: 'Current' }],
      activeIndex: 0
    },
    'https://www.google.com',
    async (url) => {
      navigations.push(url)
      contents.url = url
    },
    { historyRestoreTimeoutMs: 5 }
  )

  assert.equal(contents.stopCount, 1)
  assert.deepEqual(navigations, ['https://example.com/current'])
  assert.equal(tab.url, 'https://example.com/current')
  assert.equal(tab.isLoading, false)
  assert.equal(tab.suppressVisits, false)
})
