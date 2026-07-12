import assert from 'node:assert/strict'
import test from 'node:test'
import type { ManagedBrowserTab } from './browser-tab-model.ts'
import {
  clampTabIndex,
  fitBrowserBounds,
  nextActiveTabId,
  sanitizeBrowserBounds
} from './browser-tab-model.ts'

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

test('fits native view bounds inside the current window content area', () => {
  assert.deepEqual(fitBrowserBounds({ x: 700, y: 80, width: 1440, height: 900 }, 900, 720), {
    x: 700,
    y: 80,
    width: 200,
    height: 640
  })
  assert.deepEqual(fitBrowserBounds({ x: 1200, y: 900, width: 400, height: 300 }, 800, 600), {
    x: 799,
    y: 599,
    width: 1,
    height: 1
  })
})

test('selects the first surviving tab when the active tab closes', () => {
  const tabs = [{ id: 'first' }, { id: 'active' }, { id: 'last' }] as ManagedBrowserTab[]
  assert.equal(nextActiveTabId(tabs, 'active'), 'first')
  assert.equal(nextActiveTabId([{ id: 'active' }] as ManagedBrowserTab[], 'active'), null)
})
