import assert from 'node:assert/strict'
import test from 'node:test'
import type { SavedBrowserState } from './browser-state-types.js'
import {
  parseSavedBrowserState,
  sanitizeBrowserState,
  sanitizeNavigationEntry,
  sanitizeSavedTab,
  sanitizeUrl
} from './browser-state-sanitize.js'

test('sanitizeUrl rejects unsafe and empty urls', () => {
  assert.equal(sanitizeUrl(''), null)
  assert.equal(sanitizeUrl('about:blank'), null)
  assert.equal(sanitizeUrl('javascript:alert(1)'), null)
  assert.equal(sanitizeUrl('file:///etc/passwd'), null)
  assert.equal(sanitizeUrl('https://example.com'), 'https://example.com')
})

test('sanitizeNavigationEntry keeps safe page state', () => {
  const entry = sanitizeNavigationEntry({
    url: 'https://example.com',
    title: 'Example',
    pageState: 'abc123'
  })

  assert.deepEqual(entry, {
    url: 'https://example.com',
    title: 'Example',
    pageState: 'abc123'
  })
})

test('sanitizeSavedTab falls back to url when entries are empty', () => {
  const tab = sanitizeSavedTab({
    title: 'Docs',
    url: 'https://docs.example.com',
    entries: [],
    activeIndex: 0
  })

  assert.deepEqual(tab, {
    title: 'Docs',
    url: 'https://docs.example.com',
    entries: [],
    activeIndex: 0
  })
})

test('sanitizeSavedTab drops tabs with only unsafe urls', () => {
  const tab = sanitizeSavedTab({
    title: 'Bad',
    url: 'javascript:void(0)',
    entries: [{ url: 'file:///tmp/x', title: 'X' }],
    activeIndex: 0
  })

  assert.equal(tab, null)
})

test('sanitizeBrowserState clamps active tab index', () => {
  const state = sanitizeBrowserState({
    version: 1,
    activeTabIndex: 99,
    tabs: [
      {
        title: 'One',
        url: 'https://one.example',
        entries: [],
        activeIndex: 0
      },
      {
        title: 'Two',
        url: 'https://two.example',
        entries: [],
        activeIndex: 0
      }
    ]
  })

  assert.equal(state?.activeTabIndex, 1)
})

test('parseSavedBrowserState rejects invalid payloads', () => {
  assert.equal(parseSavedBrowserState('not-json'), null)
  assert.equal(parseSavedBrowserState(JSON.stringify({ version: 2, tabs: [] })), null)
})

test('parseSavedBrowserState round-trips a valid snapshot', () => {
  const payload: SavedBrowserState = {
    version: 1,
    activeTabIndex: 0,
    tabs: [
      {
        title: 'Google',
        url: 'https://www.google.com',
        entries: [{ url: 'https://www.google.com', title: 'Google' }],
        activeIndex: 0
      }
    ]
  }

  const parsed = parseSavedBrowserState(JSON.stringify(payload))
  assert.deepEqual(parsed, payload)
})
