import { claudeRuntimeModel, normalizeClaudeEffort, type ClaudeEffort } from './claude-models.js';
import { buildBrowserUseGuidance } from '../browser/browser-use-policy.js';

export { claudeDefaultModelId } from './claude-models.js';

export type ClaudeQuerySession = {
  cwd: string;
  model: string | null;
  effort: ClaudeEffort | null;
  fastMode: boolean;
  claudeSessionId: string | null;
};

export type ClaudeMutableRuntimeSettings = {
  model: string | null;
  effort: ClaudeEffort | null;
  fastMode: boolean;
  setModel: (model: string | null) => Promise<void>;
  applySettings: (settings: { effort: ClaudeEffort | null; fastMode: boolean }) => Promise<void>;
};

export function buildClaudeQueryOptions(
  session: ClaudeQuerySession,
  mcpServerConfig: unknown | null,
) {
  return {
    cwd: session.cwd,
    ...(claudeRuntimeModel(session.model) ? { model: claudeRuntimeModel(session.model)! } : {}),
    ...(normalizeClaudeEffort(session.effort)
      ? { effort: normalizeClaudeEffort(session.effort)! }
      : {}),
    ...(session.fastMode ? { settings: { fastMode: true, fastModePerSessionOptIn: true } } : {}),
    ...(session.claudeSessionId ? { resume: session.claudeSessionId } : {}),
    includePartialMessages: true,
    // The pinned SDK requires this explicit acknowledgement whenever bypass
    // mode is selected; permissionMode alone is not a valid pairing.
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    // Spike-verified isolation: the user's ~/.claude settings never bleed
    // into app sessions.
    settingSources: [],
    systemPrompt: buildBrowserUseGuidance(),
    ...(mcpServerConfig ? { mcpServers: { browser: mcpServerConfig as never } } : {}),
  };
}

export async function synchronizeClaudeRuntimeSettings(
  runtime: ClaudeMutableRuntimeSettings,
  desired: Pick<ClaudeQuerySession, 'model' | 'effort' | 'fastMode'>,
): Promise<void> {
  const model = claudeRuntimeModel(desired.model);
  if (runtime.model !== model) {
    await runtime.setModel(model);
    runtime.model = model;
  }
  if (runtime.effort !== desired.effort || runtime.fastMode !== desired.fastMode) {
    await runtime.applySettings({ effort: desired.effort, fastMode: desired.fastMode });
    runtime.effort = desired.effort;
    runtime.fastMode = desired.fastMode;
  }
}
