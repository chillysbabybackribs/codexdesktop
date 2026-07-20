import assert from 'node:assert/strict'
import test from 'node:test'
import { browserUserAgentFallback } from './browser-identity.ts'

const electronUserAgent =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'codexdesktop/0.1.0 Chrome/150.0.7871.47 Electron/43.1.0 Safari/537.36'

test('browser fallback removes Electron and application product tokens', () => {
  assert.equal(
    browserUserAgentFallback(electronUserAgent, 'Codex Desktop'),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.47 Safari/537.36'
  )
})

test('browser fallback leaves Chromium identity bytes unchanged', () => {
  const clean = electronUserAgent.replace('codexdesktop/0.1.0 ', '').replace('Electron/43.1.0 ', '')
  assert.equal(browserUserAgentFallback(clean, 'Codex Desktop'), clean)
})
