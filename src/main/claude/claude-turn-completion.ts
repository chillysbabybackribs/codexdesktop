export type ClaudeTurnCompletion = {
  status: 'completed' | 'failed' | 'interrupted'
  error: string | null
}

export function normalizeClaudeCompletion(
  interrupted: boolean,
  error: string | null
): ClaudeTurnCompletion {
  if (interrupted) {
    // The SDK reports an internal diagnostic result when interrupt() lands
    // during tool use. Cancellation is an expected user action, not a
    // transcript error, so do not expose that provider diagnostic downstream.
    return { status: 'interrupted', error: null }
  }

  return error
    ? { status: 'failed', error }
    : { status: 'completed', error: null }
}
