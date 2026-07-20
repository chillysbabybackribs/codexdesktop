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
  assert.match(source, /CANDIDATE_ATTEMPTS_PER_SOURCE = 1/)
  assert.match(source, /coversUnresolvedFocus/)
  assert.match(source, /focus\.length > 0 \? attemptsRemaining : remainingSuccessTarget\(\)/)
  assert.match(source, /shouldStop:[\s\S]*focusCoverageDeficit/)
  assert.match(source, /retainValuesReducingDeficit/)
  assert.match(source, /static preflight timed out/)
  assert.match(source, /STATIC_PREFLIGHT_MAX_BYTES = 750_000/)
  assert.match(source, /new ResearchOriginRouter\(\)/)
  assert.match(source, /adaptive route selected Chromium/)
  assert.match(source, /staticFetchSkipped/)
  assert.match(source, /staticFetchTimeouts/)
  assert.match(source, /PAGE_WORKER_CONCURRENCY = 3/)
  assert.doesNotMatch(source, /MAX_TARGET_PAGES|DEFAULT_TARGET_PAGES|maxPages/)

  // Both fetch lanes must apply the same page assessment: without the static
  // lane assessing, an HTTP error body with enough text is silently verified.
  assert.match(source, /const staticAssessment = assessExtractedPage\(extracted\)/)
  assert.match(source, /assessExtractedPage\(result\)/)
  // HTTP failures must surface their status code instead of reading as
  // "page had no usable content".
  assert.match(source, /http-error \(status \$\{extracted\.status\}/)
  assert.match(source, /\(status \$\{result\.status\}\)/)
  // Direct URLs that redirect cross-host onto a nav hub are followed one hop.
  assert.match(source, /harvestRedirectHubLinks/)
  assert.match(source, /extractSameHostNavLinks/)
  assert.match(source, /isCrossHostLanding/)
  assert.match(source, /MAX_REDIRECT_FOLLOW_UPS = 16/)
  assert.match(source, /REDIRECT_HUB_LINK_LIMIT = 8/)
})
