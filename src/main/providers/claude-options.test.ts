import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaudeQueryOptions, claudeDefaultModelId } from './claude-options.ts';

test('bypass permission mode includes the SDK safety acknowledgement', () => {
  const options = buildClaudeQueryOptions(
    {
      cwd: '/tmp/workspace',
      model: claudeDefaultModelId,
      effort: null,
      fastMode: false,
      claudeSessionId: null,
    },
    null,
  );

  assert.equal(options.permissionMode, 'bypassPermissions');
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(options.settingSources, []);
  assert.equal('model' in options, false);
});

test('resume, explicit model, and browser MCP configuration are forwarded', () => {
  const browser = { type: 'sdk', name: 'browser' };
  const options = buildClaudeQueryOptions(
    {
      cwd: '/tmp/workspace',
      model: 'claude:opus',
      effort: 'max',
      fastMode: true,
      claudeSessionId: 'session-123',
    },
    browser,
  );

  assert.equal(options.model, 'opus');
  assert.equal(options.effort, 'max');
  assert.equal(options.settings?.fastMode, true);
  assert.equal(options.settings?.fastModePerSessionOptIn, true);
  assert.equal(options.resume, 'session-123');
  assert.equal(options.mcpServers?.browser, browser);
});
