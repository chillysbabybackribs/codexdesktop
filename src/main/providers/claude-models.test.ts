import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClaudeModelCatalog,
  claudeDefaultModelId,
  claudeModelId,
  claudeRuntimeModel,
  isClaudeModelId,
  normalizeClaudeEffort,
} from './claude-models.ts';

test('Claude model ids are provider-qualified and reversible', () => {
  assert.equal(claudeModelId('sonnet'), 'claude:sonnet');
  assert.equal(claudeRuntimeModel('claude:opus%5B1m%5D'), 'opus[1m]');
  assert.equal(claudeRuntimeModel(claudeDefaultModelId), null);
  assert.equal(isClaudeModelId('claude:sonnet'), true);
  assert.equal(isClaudeModelId('sonnet'), false);
  assert.equal(
    isClaudeModelId('claude-opus-4-8'),
    true,
    'legacy explicit ids keep routing to Claude',
  );
});

test('SDK model metadata maps into shared picker rows', () => {
  const catalog = buildClaudeModelCatalog([
    {
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-5',
      displayName: 'Sonnet',
      description: 'Balanced model.',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high', 'max'],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
    },
  ]);

  assert.equal(catalog[0].model, claudeDefaultModelId);
  assert.equal(catalog[1].model, 'claude:sonnet');
  assert.equal(catalog[1].runtimeModel, 'sonnet');
  assert.equal(catalog[1].resolvedModel, 'claude-sonnet-5');
  assert.equal(catalog[1].providerId, 'claude');
  assert.equal(catalog[1].supportsFastMode, true);
  assert.equal(catalog[1].supportsAdaptiveThinking, true);
  assert.deepEqual(
    catalog[1].supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
    ['low', 'high', 'max'],
  );
  assert.equal(catalog[1].defaultReasoningEffort, 'high');
  assert.match(catalog[1].description, /claude-sonnet-5/);
});

test('invalid effort values are not forwarded to Claude', () => {
  assert.equal(normalizeClaudeEffort('xhigh'), 'xhigh');
  assert.equal(normalizeClaudeEffort('minimal'), null);
  assert.equal(normalizeClaudeEffort(null), null);
});
