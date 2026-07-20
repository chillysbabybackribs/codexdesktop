import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldHandleChatSplitShortcut } from './keyboard-shortcuts.ts'

function shortcut(overrides: Record<string, unknown> = {}) {
  return {
    key: '\\',
    code: 'Backslash',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    target: null,
    ...overrides,
  } as unknown as KeyboardEvent
}

test('chat split shortcut requires the physical backslash command chord', () => {
  assert.equal(shouldHandleChatSplitShortcut(shortcut()), true)
  assert.equal(shouldHandleChatSplitShortcut(shortcut({ key: '|', metaKey: true, ctrlKey: false })), true)
  assert.equal(shouldHandleChatSplitShortcut(shortcut({ code: 'Enter', key: '\\' })), false)
  assert.equal(shouldHandleChatSplitShortcut(shortcut({ key: 'Enter' })), false)
})

test('chat split shortcut never runs while a text editor owns the event', () => {
  const editingTarget = {
    closest: (selector: string) => (selector.includes('textarea') ? { tagName: 'TEXTAREA' } : null),
  }
  assert.equal(shouldHandleChatSplitShortcut(shortcut({ target: editingTarget })), false)
  assert.equal(shouldHandleChatSplitShortcut(shortcut({ defaultPrevented: true })), false)
  assert.equal(shouldHandleChatSplitShortcut(shortcut({ altKey: true })), false)
})
