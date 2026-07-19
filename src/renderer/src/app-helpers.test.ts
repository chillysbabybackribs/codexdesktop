import assert from 'node:assert/strict'
import test from 'node:test'
import type { Model } from '../../shared/session-protocol'
import {
  providerDisplayName,
  resolveModelProvider,
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
