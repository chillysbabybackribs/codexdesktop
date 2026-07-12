import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('research runner stays artifact-first without creating or activating visible tabs', async () => {
  const source = await readFile(new URL('./research-runner.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /TabManager|stageBestPage|stagingTabId|visibleTabId|\.createTab\(|\.activateTab\(/)
  assert.match(source, /normalizeResearchUrls/)
  assert.match(source, /buildPageExtractionProgram\(MAX_ARTIFACT_CHARS, MAX_HTML_CHARS\)/)
  assert.match(source, /selectResearchEvidence/)
})
