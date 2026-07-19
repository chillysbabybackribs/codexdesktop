export const claudeDefaultModelId = 'claude-default'

export type ClaudeQuerySession = {
  cwd: string
  model: string | null
  claudeSessionId: string | null
}

export function buildClaudeQueryOptions(session: ClaudeQuerySession, mcpServerConfig: unknown | null) {
  return {
    cwd: session.cwd,
    ...(session.model && session.model !== claudeDefaultModelId ? { model: session.model } : {}),
    ...(session.claudeSessionId ? { resume: session.claudeSessionId } : {}),
    includePartialMessages: true,
    // The pinned SDK requires this explicit acknowledgement whenever bypass
    // mode is selected; permissionMode alone is not a valid pairing.
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    // Spike-verified isolation: the user's ~/.claude settings never bleed
    // into app sessions.
    settingSources: [],
    ...(mcpServerConfig ? { mcpServers: { browser: mcpServerConfig as never } } : {})
  }
}
