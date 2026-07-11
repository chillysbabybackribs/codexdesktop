import assert from 'node:assert/strict'
import test from 'node:test'
import type { ManagedBrowserTab } from './browser-tab-model.ts'
import { clampTabIndex, nextActiveTabId, sanitizeBrowserBounds } from './browser-tab-model.ts'

test('clamps restored tab indexes and native view bounds', () => {
  assert.equal(clampTabIndex(-10, 3), 0)
  assert.equal(clampTabIndex(10, 3), 2)
  assert.equal(clampTabIndex(Number.NaN, 3), 2)
  assert.deepEqual(sanitizeBrowserBounds({ x: -4.2, y: 8.7, width: 0, height: 20.4 }), {
    x: 0,
    y: 9,
    width: 1,
    height: 20
  })
})

test('selects the first surviving tab when the active tab closes', () => {
  const tabs = [{ id: 'first' }, { id: 'active' }, { id: 'last' }] as ManagedBrowserTab[]
  assert.equal(nextActiveTabId(tabs, 'active'), 'first')
  assert.equal(nextActiveTabId([{ id: 'active' }] as ManagedBrowserTab[], 'active'), null)
})
