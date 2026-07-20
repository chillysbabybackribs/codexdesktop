import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildClaudeQueryOptions,
  claudeDefaultModelId,
  synchronizeClaudeRuntimeSettings,
} from './claude-options.ts';

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

test('Claude system prompt prioritizes live browser inspection', () => {
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

  assert.match(options.systemPrompt, /live browser is the authority/i);
  assert.match(options.systemPrompt, /should normally use mcp__browser__browser_research_dual/i);
  assert.match(options.systemPrompt, /WebSearch and WebFetch tools are disabled/i);
  assert.deepEqual(options.disallowedTools, ['WebSearch', 'WebFetch']);
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

test('a live runtime applies model and flag changes before the next turn', async () => {
  const calls: string[] = [];
  const runtime = {
    model: 'opus',
    effort: 'high' as const,
    fastMode: false,
    async setModel(model: string | null) {
      calls.push(`model:${model}`);
    },
    async applySettings(settings: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null; fastMode: boolean }) {
      calls.push(`settings:${settings.effort}:${settings.fastMode}`);
    },
  };

  await synchronizeClaudeRuntimeSettings(runtime, {
    model: 'claude:sonnet',
    effort: 'low',
    fastMode: true,
  });
  assert.deepEqual(calls, ['model:sonnet', 'settings:low:true']);
  assert.equal(runtime.model, 'sonnet');
  assert.equal(runtime.effort, 'low');
  assert.equal(runtime.fastMode, true);

  await synchronizeClaudeRuntimeSettings(runtime, {
    model: 'claude:sonnet',
    effort: 'low',
    fastMode: true,
  });
  assert.equal(calls.length, 2, 'already-applied settings are not resent');
});
