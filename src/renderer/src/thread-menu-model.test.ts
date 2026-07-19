import assert from 'node:assert/strict'
import test from 'node:test'
import type { Thread } from '../../shared/session-protocol/index.ts'
import {
  groupThreadsForMenu,
  headerMenuCommands,
  relativeThreadTime,
  stripSkillMarkerFromTitle,
  threadTitle
} from './thread-menu-model.ts'

const dayMs = 86_400_000

function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    name: null,
    preview: '',
    updatedAt: 0,
    recencyAt: null,
    ...overrides
  } as Thread
}

function startOfTodayMs(): number {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  return startOfToday.getTime()
}

test('threadTitle prefers the thread name over the preview', () => {
  const thread = makeThread({ id: 't1', name: 'Named chat', preview: 'First message' })
  assert.equal(threadTitle(thread), 'Named chat')
})

test('threadTitle falls back to the preview when the name is empty', () => {
  const thread = makeThread({ id: 't1', name: null, preview: 'First message' })
  assert.equal(threadTitle(thread), 'First message')
})

test('threadTitle falls back to "New Chat" when name and preview are empty', () => {
  const thread = makeThread({ id: 't1', name: null, preview: '' })
  assert.equal(threadTitle(thread), 'New Chat')
})

test('threadTitle strips the research skill marker from the name', () => {
  const thread = makeThread({
    id: 't1',
    name: '$artifact-first-web-research Compare recent reports'
  })
  assert.equal(threadTitle(thread), 'Compare recent reports')
})

test('stripSkillMarkerFromTitle removes the marker case-insensitively', () => {
  assert.equal(
    stripSkillMarkerFromTitle('$ARTIFACT-FIRST-WEB-RESEARCH Compare reports'),
    'Compare reports'
  )
})

test('stripSkillMarkerFromTitle returns "New Chat" for a marker-only title', () => {
  assert.equal(stripSkillMarkerFromTitle('$artifact-first-web-research'), 'New Chat')
})

test('stripSkillMarkerFromTitle leaves unrelated titles untouched', () => {
  assert.equal(stripSkillMarkerFromTitle('Plain title'), 'Plain title')
})

test('relativeThreadTime reports "now" for a fresh timestamp', () => {
  assert.equal(relativeThreadTime(Date.now() / 1000), 'now')
})

test('relativeThreadTime reports minutes within the hour', () => {
  assert.equal(relativeThreadTime((Date.now() - 5 * 60_000) / 1000), '5m')
})

test('relativeThreadTime reports hours within the day', () => {
  assert.equal(relativeThreadTime((Date.now() - 3 * 3_600_000) / 1000), '3h')
})

test('relativeThreadTime uses non-relative labels beyond a day', () => {
  const relative = /^(now|\d+m|\d+h)$/
  const threeDaysAgo = relativeThreadTime((Date.now() - 3 * dayMs) / 1000)
  assert.equal(typeof threeDaysAgo, 'string')
  assert.ok(threeDaysAgo.length > 0)
  assert.ok(!relative.test(threeDaysAgo))

  const sixtyDaysAgo = relativeThreadTime((Date.now() - 60 * dayMs) / 1000)
  assert.ok(sixtyDaysAgo.length > 0)
  assert.ok(!relative.test(sixtyDaysAgo))
  assert.notEqual(sixtyDaysAgo, 'Yesterday')
})

test('groupThreadsForMenu buckets threads into recency bands sorted newest first', () => {
  const todayStart = startOfTodayMs()
  const today = makeThread({ id: 'today', name: 'Today chat', recencyAt: Date.now() / 1000 })
  const yesterday = makeThread({
    id: 'yesterday',
    name: 'Yesterday chat',
    recencyAt: (todayStart - 12 * 3_600_000) / 1000
  })
  const thisWeek = makeThread({
    id: 'week',
    name: 'Weekday chat',
    recencyAt: (todayStart - 3 * dayMs + 3_600_000) / 1000
  })
  const older = makeThread({
    id: 'older',
    name: 'Old chat',
    recencyAt: (todayStart - 30 * dayMs) / 1000
  })

  const { groups, flatIds } = groupThreadsForMenu([older, thisWeek, today, yesterday], '')

  assert.deepEqual(
    groups.map((group) => group.label),
    ['Today', 'Yesterday', 'Previous 7 days', 'Older']
  )
  assert.deepEqual(flatIds, ['today', 'yesterday', 'week', 'older'])
})

test('groupThreadsForMenu omits empty recency bands', () => {
  const today = makeThread({ id: 'today', name: 'Today chat', recencyAt: Date.now() / 1000 })
  const { groups } = groupThreadsForMenu([today], '')
  assert.deepEqual(
    groups.map((group) => group.label),
    ['Today']
  )
})

test('groupThreadsForMenu falls back to updatedAt when recencyAt is null', () => {
  const todayStart = startOfTodayMs()
  const thread = makeThread({
    id: 'fallback',
    name: 'Fallback chat',
    recencyAt: null,
    updatedAt: (todayStart - 12 * 3_600_000) / 1000
  })

  const { groups, flatIds } = groupThreadsForMenu([thread], '')

  assert.deepEqual(
    groups.map((group) => group.label),
    ['Yesterday']
  )
  assert.deepEqual(flatIds, ['fallback'])
})

test('groupThreadsForMenu filters by query case-insensitively across titles', () => {
  const now = Date.now() / 1000
  const named = makeThread({ id: 'named', name: 'Deploy checklist', recencyAt: now })
  const previewOnly = makeThread({
    id: 'preview',
    name: null,
    preview: 'deploy the new build',
    recencyAt: now - 60
  })
  const unrelated = makeThread({ id: 'other', name: 'Grocery list', recencyAt: now - 120 })

  const { flatIds } = groupThreadsForMenu([named, previewOnly, unrelated], 'DEPLOY')

  assert.deepEqual(flatIds, ['named', 'preview'])
})

test('groupThreadsForMenu returns nothing when the query matches no thread', () => {
  const thread = makeThread({ id: 't1', name: 'Deploy checklist', recencyAt: Date.now() / 1000 })
  const { groups, flatIds } = groupThreadsForMenu([thread], 'zebra')
  assert.deepEqual(groups, [])
  assert.deepEqual(flatIds, [])
})

test('header menu consolidates layout, split, history, and settings commands', () => {
  const commands = headerMenuCommands({
    isBrowserMiddle: false,
    canSplitActivePane: true,
    disabled: false,
    showGlobalActions: true
  })

  assert.deepEqual(
    commands.map((command) => command.id),
    ['browser-layout', 'split-right', 'split-down', 'history', 'settings']
  )
  assert.equal(commands[0]?.label, 'Center browser')
  assert.equal(commands[1]?.hint, 'Ctrl+\\')
})

test('secondary browser-middle header keeps only pane layout commands', () => {
  const commands = headerMenuCommands({
    isBrowserMiddle: true,
    canSplitActivePane: false,
    disabled: false,
    showGlobalActions: false
  })

  assert.deepEqual(commands.map((command) => command.id), [
    'browser-layout',
    'split-right',
    'split-down'
  ])
  assert.equal(commands[0]?.label, 'Move browser right')
  assert.equal(commands[0]?.active, true)
  assert.equal(commands[1]?.disabled, true)
})
