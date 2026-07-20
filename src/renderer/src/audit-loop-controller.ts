import { stripVerdictLine } from './audit-trigger.js'

// The RSI loop-to-done controller — the crank in doer → audit → flag → fix →
// re-audit → … The old rule was a flat one-bounce cap; the controller replaces
// it with policy: a flagged audit of a FIX turn may bounce again while the
// round ceiling holds, the fix actually changed something, and the reviewer is
// not repeating itself. Every exit is announced in the transcript; nothing
// stops silently. Convergence = the reviewer's pass verdict; everything else
// is a bounded, explained stop that hands the last word to the user.

export const LOOP_MAX_FIX_ROUNDS = 3

export type LoopState = {
  // Fix rounds dispatched so far in this loop (1 = the first bounce).
  rounds: number
  lastReportSignature: string
}

export type LoopDecision = { kind: 'continue'; round: number } | { kind: 'stop'; reason: string }

// Whitespace/case-collapsed report body, verdict line stripped — equality
// across consecutive rounds is the "reviewer repeated itself" signal.
export function reportSignature(report: string): string {
  return stripVerdictLine(report).toLowerCase().replace(/\s+/g, ' ').trim()
}

export function startLoop(report: string): LoopState {
  return { rounds: 1, lastReportSignature: reportSignature(report) }
}

export function continueLoop(state: LoopState, report: string): LoopState {
  return { rounds: state.rounds + 1, lastReportSignature: reportSignature(report) }
}

// Decide whether a flagged audit of a fix turn may dispatch another round.
// `fixTurnChangedFiles` null means change detection was unavailable (non-git
// workspace) — that signal is skipped rather than treated as no-progress.
export function decideLoopContinuation(input: {
  state: LoopState | null
  fixTurnChangedFiles: number | null
  report: string
}): LoopDecision {
  if (!input.state) {
    // A fix turn with no ledger means the loop predates this session (reload
    // mid-loop). Never resume blind.
    return { kind: 'stop', reason: 'lost track of this loop across a reload' }
  }
  if (input.state.rounds >= LOOP_MAX_FIX_ROUNDS) {
    return { kind: 'stop', reason: `hit the ${LOOP_MAX_FIX_ROUNDS}-round ceiling` }
  }
  if (input.fixTurnChangedFiles === 0) {
    return { kind: 'stop', reason: 'the last fix round changed no files' }
  }
  if (reportSignature(input.report) === input.state.lastReportSignature) {
    return { kind: 'stop', reason: 'the reviewer repeated the same flag' }
  }
  return { kind: 'continue', round: input.state.rounds + 1 }
}

// Transcript announcements — the loop never advances or stops invisibly.
export function loopRoundMessage(round: number): string {
  return `Reviewer flagged the work — fix round ${round} of ${LOOP_MAX_FIX_ROUNDS} starting.`
}

export function loopConvergedMessage(rounds: number): string {
  return `Reviewer passed — loop complete after ${rounds} fix round${rounds === 1 ? '' : 's'}.`
}

export function loopStopMessage(reason: string, rounds: number): string {
  return `Fix loop stopped after ${rounds} round${rounds === 1 ? '' : 's'}: ${reason}. The flagged report stays in the reviewer card — click its flag to continue manually.`
}
