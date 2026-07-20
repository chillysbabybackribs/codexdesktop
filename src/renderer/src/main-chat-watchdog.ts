// Mid-turn watchdog — the middle phase of reviewer supervision
// (beginning = intake, end = completion audit; docs/prompt-intake-2026-07-19.md).
//
// While the main chat's turn runs, the paired Reviewer gets sparse trajectory
// checks: "is this still heading the right way?" Silence is the contract — the
// reviewer replies ON-TRACK (dropped) unless the work is clearly derailing, in
// which case its STEER: guidance is delivered into the running turn through
// the existing steer channel. Short turns pay nothing: the first check
// requires both elapsed time and step depth, and the cadence decays after it.

export const WATCHDOG_MIN_STEPS = 5
export const WATCHDOG_MIN_ELAPSED_MS = 60_000
export const WATCHDOG_MAX_CHECKS = 5
// Gap after the Nth check: front-loaded, then sparse.
const WATCHDOG_DECAY_MS = [120_000, 240_000, 480_000]

export const ON_TRACK_SENTINEL = 'ON-TRACK'
export const STEER_SENTINEL = 'STEER:'

export type WatchdogTurnState = {
  turnId: string
  checksSent: number
  // Earliest wall-clock time the next check may fire; the first check also
  // requires WATCHDOG_MIN_STEPS of visible progress.
  nextCheckAtMs: number
  inFlight: boolean
}

export function newWatchdogTurnState(turnId: string, startedAtMs: number): WatchdogTurnState {
  return {
    turnId,
    checksSent: 0,
    nextCheckAtMs: startedAtMs + WATCHDOG_MIN_ELAPSED_MS,
    inFlight: false,
  }
}

export function watchdogCheckDue(
  state: WatchdogTurnState,
  nowMs: number,
  stepCount: number
): boolean {
  if (state.inFlight) return false
  if (state.checksSent >= WATCHDOG_MAX_CHECKS) return false
  if (nowMs < state.nextCheckAtMs) return false
  if (state.checksSent === 0 && stepCount < WATCHDOG_MIN_STEPS) return false
  return true
}

// Gap to schedule after the Nth check (1-based).
export function nextWatchdogDelayMs(checksSent: number): number {
  const index = Math.max(0, Math.min(checksSent - 1, WATCHDOG_DECAY_MS.length - 1))
  return WATCHDOG_DECAY_MS[index]
}

export function buildWatchdogBriefing(input: {
  userText: string
  steps: string[]
  elapsedMinutes: number
  checkNumber: number
  doerLabel: string
}): string {
  const steps = input.steps.length
    ? input.steps.map((step) => `- ${step}`).join('\n')
    : '- (no visible steps yet)'
  return [
    `Mid-turn course check #${input.checkNumber}: the main chat (${input.doerLabel}) is still RUNNING its turn — about ${input.elapsedMinutes} minutes in. This is a trajectory check, not an audit; the completed turn gets its own review later.`,
    '',
    'The user asked:',
    '<user-request>',
    input.userText,
    '</user-request>',
    '',
    'Steps taken so far:',
    steps,
    '',
    'If you wrote the plan for this task earlier in this thread, hold the trajectory to it.',
    `Reply with exactly ${ON_TRACK_SENTINEL} if the work is heading the right way — nothing else.`,
    `Only if it is clearly derailing — solving the wrong problem, misreading the request, circling on retries, or exploding scope — start your reply with ${STEER_SENTINEL} followed by one or two sentences of course correction addressed directly to the doer.`,
    `Judge from what is above and what you already know from this thread. Do not use tools. When in doubt: ${ON_TRACK_SENTINEL}.`,
  ].join('\n')
}

export type WatchdogVerdict =
  | { verdict: 'onTrack' }
  | { verdict: 'steer'; guidance: string }
  | { verdict: 'unclear' }

// Silence-by-default extends to parsing: anything that is not an unambiguous
// STEER is treated as no-steer.
export function parseWatchdogVerdict(text: string): WatchdogVerdict {
  const trimmed = text.trim()
  if (!trimmed) return { verdict: 'unclear' }
  const upper = trimmed.toUpperCase()
  if (upper.startsWith(STEER_SENTINEL)) {
    const guidance = trimmed
      .slice(STEER_SENTINEL.length)
      .replace(/^[\s:—–-]+/, '')
      .trim()
    return guidance ? { verdict: 'steer', guidance } : { verdict: 'unclear' }
  }
  if (upper.startsWith(ON_TRACK_SENTINEL)) return { verdict: 'onTrack' }
  return { verdict: 'unclear' }
}

// The steer text the doer receives mid-turn, attributed so it never reads as
// the user speaking.
export function buildSteerMessage(reviewerTitle: string, guidance: string): string {
  return `[Course check from ${reviewerTitle}] ${guidance}`
}
