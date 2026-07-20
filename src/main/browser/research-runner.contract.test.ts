import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('research runner stays artifact-first without creating or activating visible tabs', async () => {
  const source = await readFile(new URL('./research-runner.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /TabManager|stageBestPage|stagingTabId|visibleTabId|\.createTab\(|\.activateTab\(/)
  assert.match(source, /normalizeResearchUrls/)
  assert.match(source, /buildPageExtractionProgram\(MAX_ARTIFACT_CHARS, MAX_HTML_CHARS\)/)
  assert.match(source, /selectResearchEvidence/)
  assert.match(source, /focus\.reduce\(\(total, \{ minSources \}\) => total \+ minSources, 0\)/)
  assert.match(source, /DEFAULT_UNFOCUSED_SOURCE_TARGET = 1/)
  assert.match(source, /CANDIDATE_ATTEMPTS_PER_SOURCE = 2/)
  assert.match(source, /coversUnresolvedFocus/)
  assert.match(source, /focus\.length > 0 \? attemptsRemaining : remainingSuccessTarget\(\)/)
  assert.match(source, /shouldStop:[\s\S]*focusCoverageDeficit/)
  assert.match(source, /retainValuesReducingDeficit/)
  assert.match(source, /static preflight timed out/)
  assert.match(source, /STATIC_PREFLIGHT_TIMEOUT_MS = 2_000/)
  assert.match(source, /STATIC_PREFLIGHT_MAX_BYTES = 750_000/)
  assert.match(source, /PAGE_WORKER_CONCURRENCY = 3/)
  assert.doesNotMatch(source, /MAX_TARGET_PAGES|DEFAULT_TARGET_PAGES|maxPages/)
})
