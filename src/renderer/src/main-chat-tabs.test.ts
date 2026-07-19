import assert from 'node:assert/strict'
import test from 'node:test'
import {
  closeMainChatTab,
  createMainChatTab,
  needsMainChatTabHydration,
  parseMainChatTabState,
  reorderMainChatTabs,
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
      {
        ...createMainChatTab('tab-a', 'thread-a', 'First', 'gpt-5.4', 'high'),
        status: 'working' as const
      },
      {
        ...createMainChatTab('tab-b', null, 'New Chat', 'gpt-5.3', 'medium'),
        status: 'attention' as const
      }
    ]
  }
  const restored = parseMainChatTabState(serializeMainChatTabState(state), null, () => 'unused')
  assert.equal(restored.activeKey, 'tab-b')
  assert.deepEqual(restored.tabs.map((tab) => tab.status), ['idle', 'idle'])
  assert.deepEqual(restored.tabs.map((tab) => [tab.model, tab.reasoningEffort]), [
    ['gpt-5.4', 'high'],
    ['gpt-5.3', 'medium']
  ])
})

test('migrates the legacy model choice into every pre-model tab', () => {
  const state = parseMainChatTabState(
    JSON.stringify({
      activeKey: 'tab-a',
      tabs: [
        { key: 'tab-a', threadId: 'thread-a', title: 'First' },
        { key: 'tab-b', threadId: 'thread-b', title: 'Second' }
      ]
    }),
    null,
    () => 'unused',
    { model: 'gpt-5.4', reasoningEffort: 'high' }
  )

  assert.deepEqual(state.tabs.map((tab) => [tab.model, tab.reasoningEffort]), [
    ['gpt-5.4', 'high'],
    ['gpt-5.4', 'high']
  ])
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

test('reorders open tabs while keeping the active tab stable', () => {
  const state = {
    activeKey: 'tab-b',
    tabs: [createMainChatTab('tab-a'), createMainChatTab('tab-b'), createMainChatTab('tab-c')]
  }

  const movedAfter = reorderMainChatTabs(state, 'tab-a', 'tab-c', 'after')
  assert.deepEqual(movedAfter.tabs.map((tab) => tab.key), ['tab-b', 'tab-c', 'tab-a'])
  assert.equal(movedAfter.activeKey, 'tab-b')

  const movedBefore = reorderMainChatTabs(movedAfter, 'tab-a', 'tab-b', 'before')
  assert.deepEqual(movedBefore.tabs.map((tab) => tab.key), ['tab-a', 'tab-b', 'tab-c'])
})

test('leaves tab state unchanged when a reorder target is invalid', () => {
  const state = {
    activeKey: 'tab-a',
    tabs: [createMainChatTab('tab-a'), createMainChatTab('tab-b')]
  }

  assert.equal(reorderMainChatTabs(state, 'missing', 'tab-b', 'before'), state)
  assert.equal(reorderMainChatTabs(state, 'tab-a', 'missing', 'after'), state)
  assert.equal(reorderMainChatTabs(state, 'tab-a', 'tab-a', 'before'), state)
})

test('cached running tabs keep their live transcript instead of rehydrating', () => {
  const running = {
    ...createMainChatTab('tab-running', 'thread-running', 'Running task'),
    status: 'working' as const,
    turnId: 'turn-running'
  }

  assert.equal(needsMainChatTabHydration(running, 'thread-running'), false)
  assert.equal(needsMainChatTabHydration(running, null), true)
  assert.equal(needsMainChatTabHydration(running, undefined), true)
  // A cached session for a DIFFERENT thread does not count as this tab's cache.
  assert.equal(needsMainChatTabHydration(running, 'thread-other'), true)
  assert.equal(needsMainChatTabHydration(createMainChatTab('tab-new'), null), false)
})
