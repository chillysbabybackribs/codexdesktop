import assert from 'node:assert/strict'
import test from 'node:test'
import { BROWSER_ACCEPT_LANGUAGE, buildBrowserIdentity } from './browser-identity.ts'

test('browser identity removes Electron and application product tokens by construction', () => {
  const identity = buildBrowserIdentity({
    chromeVersion: '150.0.7871.47',
    platform: 'linux',
    architecture: 'x64'
  })

  assert.equal(
    identity.userAgent,
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.47 Safari/537.36'
  )
  assert.doesNotMatch(identity.userAgent, /Electron|codexdesktop/i)
  assert.equal(identity.acceptLanguage, BROWSER_ACCEPT_LANGUAGE)
})

test('browser identity keeps UA Client Hints coherent with the bundled Chromium', () => {
  const identity = buildBrowserIdentity({
    chromeVersion: '150.0.7871.47',
    platform: 'darwin',
    architecture: 'arm64'
  })

  assert.equal(identity.userAgentMetadata.platform, 'macOS')
  assert.equal(identity.userAgentMetadata.architecture, 'arm')
  assert.equal(identity.userAgentMetadata.bitness, '64')
  assert.deepEqual(identity.userAgentMetadata.brands.map(({ version }) => version), ['150', '150', '99'])
  assert.deepEqual(identity.userAgentMetadata.fullVersionList.map(({ version }) => version), [
    '150.0.7871.47',
    '150.0.7871.47',
    '99.0.0.0'
  ])
})
