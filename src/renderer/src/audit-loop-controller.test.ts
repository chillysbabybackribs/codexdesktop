import assert from 'node:assert/strict'
import test from 'node:test'
import {
  continueLoop,
  decideLoopContinuation,
  LOOP_MAX_FIX_ROUNDS,
  loopConvergedMessage,
  loopRoundMessage,
  loopStopMessage,
  reportSignature,
  startLoop,
} from './audit-loop-controller.ts'

test('reportSignature collapses noise and strips the verdict line', () => {
  const a = reportSignature('Missing null check in  parser.\n\nVERDICT: flag')
  const b = reportSignature('missing NULL check in parser.\nVERDICT: flag')
  assert.equal(a, b)
  assert.ok(!a.includes('verdict'))
  assert.notEqual(a, reportSignature('Different finding.\nVERDICT: flag'))
})

test('loop ledger starts at round one and advances with new signatures', () => {
  const started = startLoop('First flag.\nVERDICT: flag')
  assert.equal(started.rounds, 1)
  const advanced = continueLoop(started, 'Second flag.\nVERDICT: flag')
  assert.equal(advanced.rounds, 2)
  assert.notEqual(advanced.lastReportSignature, started.lastReportSignature)
})

test('continuation requires ledger, progress, novelty, and headroom', () => {
  const state = startLoop('Fix the parser guard.\nVERDICT: flag')

  // No ledger (reload mid-loop) → stop, never resume blind.
  assert.equal(
    decideLoopContinuation({ state: null, fixTurnChangedFiles: 2, report: 'x' }).kind,
    'stop'
  )
  // Fix round touched nothing → stop.
  assert.equal(
    decideLoopContinuation({ state, fixTurnChangedFiles: 0, report: 'New issue.\nVERDICT: flag' })
      .kind,
    'stop'
  )
  // Reviewer repeats itself → stop.
  assert.equal(
    decideLoopContinuation({
      state,
      fixTurnChangedFiles: 2,
      report: 'fix the PARSER guard.\nVERDICT: flag',
    }).kind,
    'stop'
  )
  // Detection unavailable (null) is not treated as no-progress.
  const go = decideLoopContinuation({
    state,
    fixTurnChangedFiles: null,
    report: 'Now the tests are stale.\nVERDICT: flag',
  })
  assert.deepEqual(go, { kind: 'continue', round: 2 })
  // Ceiling.
  const atCeiling = { rounds: LOOP_MAX_FIX_ROUNDS, lastReportSignature: 'sig' }
  assert.equal(
    decideLoopContinuation({
      state: atCeiling,
      fixTurnChangedFiles: 5,
      report: 'Fresh issue.\nVERDICT: flag',
    }).kind,
    'stop'
  )
})

test('announcement copy carries round counts and the manual escape', () => {
  assert.match(loopRoundMessage(2), /fix round 2 of 3/)
  assert.match(loopConvergedMessage(1), /1 fix round\b/)
  assert.match(loopConvergedMessage(2), /2 fix rounds/)
  const stop = loopStopMessage('hit the 3-round ceiling', 3)
  assert.match(stop, /stopped after 3 rounds/)
  assert.match(stop, /click its flag to continue manually/)
})
