import assert from 'node:assert/strict'
import test from 'node:test'
import type { Model } from '../../shared/session-protocol'
import {
  defaultThreadTitle,
  hasObservedTerminalTurn,
  provisionalThreadTitle,
  providerDisplayName,
  resolveModelProvider,
  resolveThreadTitle,
  steerComposerPlaceholder,
} from './app-helpers.ts'

const model = (id: string, providerId: 'codex' | 'claude' | undefined): Model =>
  ({
    id,
    model: id,
    providerId,
    hidden: false,
    isDefault: id === 'codex-default',
    inputModalities: ['text'],
    supportedReasoningEfforts: [],
  }) as unknown as Model

test('resolveModelProvider falls back to codex for unknown models', () => {
  const models = [model('codex-default', 'codex'), model('claude-default', 'claude')]
  assert.equal(resolveModelProvider(models, 'missing'), 'codex')
})

test('resolveModelProvider uses the catalog default when model is unset', () => {
  const models = [model('codex-default', 'codex'), model('claude-default', 'claude')]
  assert.equal(resolveModelProvider(models, null), 'codex')
})

test('steerComposerPlaceholder names the active provider', () => {
  assert.equal(
    steerComposerPlaceholder('codex'),
    'Add guidance while Codex works…',
  )
  assert.equal(
    steerComposerPlaceholder('claude'),
    'Add guidance while Claude Code works…',
  )
  assert.equal(providerDisplayName('claude'), 'Claude Code')
})

test('a terminal notification remains authoritative over a later turn-start response', () => {
  assert.equal(hasObservedTerminalTurn({}, 'turn-1'), false)
  assert.equal(hasObservedTerminalTurn({ 'turn-1': { status: 'inProgress' } }, 'turn-1'), false)
  assert.equal(hasObservedTerminalTurn({ 'turn-1': { status: 'completed' } }, 'turn-1'), true)
  assert.equal(hasObservedTerminalTurn({ 'turn-1': { status: 'failed' } }, 'turn-1'), true)
  assert.equal(hasObservedTerminalTurn({ 'turn-1': { status: 'interrupted' } }, 'turn-1'), true)
})

test('creates a compact provisional title from the first prompt', () => {
  assert.equal(
    provisionalThreadTitle('  Update the split-chat close button\nso it uses an X  '),
    'Update the split-chat close button so it uses an X',
  )
  assert.equal(
    provisionalThreadTitle('$artifact-first-web-research Compare recent reports'),
    'Compare recent reports',
  )
  assert.equal(
    provisionalThreadTitle('A deliberately long prompt that should stay readable in a compact chat tab without spilling into the rest of the header'),
    'A deliberately long prompt that should stay readable in a compact…',
  )
})

test('keeps a provisional title until the server supplies a real name', () => {
  assert.equal(
    resolveThreadTitle(defaultThreadTitle, 'Update split chat close button'),
    'Update split chat close button',
  )
  assert.equal(
    resolveThreadTitle('Split pane close controls', 'Update split chat close button'),
    'Split pane close controls',
  )
})
