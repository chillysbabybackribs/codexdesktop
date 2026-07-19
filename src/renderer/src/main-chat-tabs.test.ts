import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeMainChatTab,
  createMainChatTab,
  needsMainChatTabHydration,
  parseMainChatTabState,
  serializeMainChatTabState
} from './main-chat-tabs.ts'

test('migrates the legacy last thread into the first tab', () => {
  let counter = 0
  const state = parseMainChatTabState(null, 'thread-1', () => `tab-${++counter}`)
  assert.equal(state.tabs.length, 1)
  assert.equal(state.tabs[0].threadId, 'thread-1')
  assert.equal(state.activeKey, state.tabs[0].key)
})

test('round trips open tabs without persisting transient status', () => {
  const state = {
    activeKey: 'tab-b',
    tabs: [
      { ...createMainChatTab('tab-a', 'thread-a', 'First'), status: 'working' as const },
      { ...createMainChatTab('tab-b', null, 'New Chat'), status: 'attention' as const }
    ]
  }
  const restored = parseMainChatTabState(serializeMainChatTabState(state), null, () => 'unused')
  assert.equal(restored.activeKey, 'tab-b')
  assert.deepEqual(restored.tabs.map((tab) => tab.status), ['idle', 'idle'])
})

test('closing the active tab selects its nearest neighbor', () => {
  const state = {
    activeKey: 'tab-b',
    tabs: [createMainChatTab('tab-a'), createMainChatTab('tab-b'), createMainChatTab('tab-c')]
  }
  const next = closeMainChatTab(state, 'tab-b', () => 'replacement')
  assert.equal(next.activeKey, 'tab-c')
  assert.deepEqual(next.tabs.map((tab) => tab.key), ['tab-a', 'tab-c'])
})

test('closing the only tab leaves a fresh usable tab', () => {
  const state = { activeKey: 'tab-a', tabs: [createMainChatTab('tab-a', 'thread-a', 'Work')] }
  const next = closeMainChatTab(state, 'tab-a', () => 'tab-new')
  assert.deepEqual(next, {
    activeKey: 'tab-new',
    tabs: [createMainChatTab('tab-new')]
  })
})

test('cached running tabs keep their live transcript instead of rehydrating', () => {
  const running = {
    ...createMainChatTab('tab-running', 'thread-running', 'Running task'),
    status: 'working' as const,
    turnId: 'turn-running'
  }

  assert.equal(needsMainChatTabHydration(running, true), false)
  assert.equal(needsMainChatTabHydration(running, false), true)
  assert.equal(needsMainChatTabHydration(createMainChatTab('tab-new'), false), false)
})
