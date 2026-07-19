import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSteerMessage,
  buildWatchdogBriefing,
  newWatchdogTurnState,
  nextWatchdogDelayMs,
  parseWatchdogVerdict,
  watchdogCheckDue,
  WATCHDOG_MAX_CHECKS,
  WATCHDOG_MIN_ELAPSED_MS,
  WATCHDOG_MIN_STEPS,
} from './main-chat-watchdog.ts'

const T0 = 1_000_000

test('first check requires both elapsed time and step depth', () => {
  const state = newWatchdogTurnState('turn-1', T0)
  assert.equal(state.nextCheckAtMs, T0 + WATCHDOG_MIN_ELAPSED_MS)
  // Too early, even with depth.
  assert.equal(watchdogCheckDue(state, T0 + 5_000, 20), false)
  // Old enough but shallow — a slow simple turn never gets checked.
  assert.equal(
    watchdogCheckDue(state, T0 + WATCHDOG_MIN_ELAPSED_MS, WATCHDOG_MIN_STEPS - 1),
    false
  )
  // Both thresholds met.
  assert.equal(
    watchdogCheckDue(state, T0 + WATCHDOG_MIN_ELAPSED_MS, WATCHDOG_MIN_STEPS),
    true
  )
})

test('in-flight and max-checks both block further checks', () => {
  const state = newWatchdogTurnState('turn-1', T0)
  const due = T0 + WATCHDOG_MIN_ELAPSED_MS
  state.inFlight = true
  assert.equal(watchdogCheckDue(state, due, 20), false)
  state.inFlight = false
  state.checksSent = WATCHDOG_MAX_CHECKS
  assert.equal(watchdogCheckDue(state, due, 20), false)
})

test('later checks ignore step depth and decay in cadence', () => {
  const state = newWatchdogTurnState('turn-1', T0)
  state.checksSent = 1
  state.nextCheckAtMs = T0 + 200_000
  // Depth no longer matters after the first check.
  assert.equal(watchdogCheckDue(state, T0 + 200_000, 0), true)
  // Decay table: 2min, 4min, then 8min capped.
  assert.equal(nextWatchdogDelayMs(1), 120_000)
  assert.equal(nextWatchdogDelayMs(2), 240_000)
  assert.equal(nextWatchdogDelayMs(3), 480_000)
  assert.equal(nextWatchdogDelayMs(9), 480_000)
})

test('briefing carries the request, steps, and the silence contract', () => {
  const briefing = buildWatchdogBriefing({
    userText: 'refactor the parser',
    steps: ['Read parser.ts', 'Ran tests'],
    elapsedMinutes: 3,
    checkNumber: 2,
    doerLabel: 'GPT-5.6-Sol',
  })
  assert.match(briefing, /course check #2/)
  assert.match(briefing, /refactor the parser/)
  assert.match(briefing, /- Read parser\.ts/)
  assert.match(briefing, /GPT-5\.6-Sol/)
  assert.match(briefing, /ON-TRACK/)
  assert.match(briefing, /STEER:/)
  assert.match(briefing, /Do not use tools/)
  assert.match(briefing, /not an audit/)
})

test('verdict parsing is silence-by-default', () => {
  assert.deepEqual(parseWatchdogVerdict('ON-TRACK'), { verdict: 'onTrack' })
  assert.deepEqual(parseWatchdogVerdict('  on-track — plan step 2 underway'), {
    verdict: 'onTrack',
  })
  assert.deepEqual(parseWatchdogVerdict('STEER: wrong file — the parser lives in src/lang/'), {
    verdict: 'steer',
    guidance: 'wrong file — the parser lives in src/lang/',
  })
  const multiline = parseWatchdogVerdict('STEER: stop retrying the same command.\nRead the error first.')
  assert.equal(multiline.verdict, 'steer')
  assert.match((multiline as { guidance: string }).guidance, /Read the error first/)
  // Anything unparseable never steers.
  assert.deepEqual(parseWatchdogVerdict('Looks fine to me!'), { verdict: 'unclear' })
  assert.deepEqual(parseWatchdogVerdict('STEER:'), { verdict: 'unclear' })
  assert.deepEqual(parseWatchdogVerdict(''), { verdict: 'unclear' })
})

test('steer message is attributed to the reviewer', () => {
  assert.equal(
    buildSteerMessage('Reviewer', 'check the branch name first'),
    '[Course check from Reviewer] check the branch name first'
  )
})
