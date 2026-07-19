import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BrowserStateStore } from './browser-state-store.ts'
import type { SavedBrowserState } from './browser-state-types.ts'

function state(title: string, url: string): SavedBrowserState {
  return {
    version: 1,
    activeTabIndex: 0,
    tabs: [{ title, url, favicon: null, entries: [{ title, url }], activeIndex: 0 }]
  }
}

test('browser state store serializes overlapping saves and flushes the latest state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codexdesktop-browser-state-'))
  try {
    const store = new BrowserStateStore(join(directory, 'browser-state.json'))
    const first = store.save(state('First', 'https://first.example'))
    const second = store.save(state('Second', 'https://second.example'))

    await Promise.all([first, second])
    await store.flush()

    assert.deepEqual(await store.load(), state('Second', 'https://second.example'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
