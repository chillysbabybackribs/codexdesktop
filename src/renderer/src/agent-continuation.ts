// The auto-continuation prompt the coordinator injects when background agents
// finish while the parent thread is idle (agent-run-coordinator.ts
// automaticContinuationPrompt). The parent model needs the raw block; the
// transcript shows a compact retractable card instead of the internal text.
const CONTINUATION_HEADER = '[Automatic background-agent continuation]'
const CONTINUATION_TRAILER =
  'Continue the original task now. Use these results, verify anything still missing, and answer the user without asking them to wake you again.'

export type AgentContinuationNote = {
  /** e.g. "1 background agent finished after the previous turn became idle." */
  headline: string
  /** The per-agent result reports, without the internal continuation directive. */
  report: string
}

export function parseAgentContinuation(text: string): AgentContinuationNote | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(CONTINUATION_HEADER)) return null
  const lines = trimmed.split('\n')
  const headline = lines[1]?.trim() || 'Background agents finished.'
  const body = lines.slice(2)
  while (body.length > 0 && (body.at(-1) ?? '').trim() === '') body.pop()
  if ((body.at(-1) ?? '').trim() === CONTINUATION_TRAILER) body.pop()
  return { headline, report: body.join('\n').trim() }
}
