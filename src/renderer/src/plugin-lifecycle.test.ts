import assert from 'node:assert/strict'
import test from 'node:test'
import type { PluginMarketplaceEntry } from '../../shared/session-protocol/index.ts'
import type { PluginSummary } from '../../shared/session-protocol/index.ts'
import { pluginInstallParams, pluginUninstallId, safePluginAuthUrl, unresolvedPluginApps } from './plugin-lifecycle.ts'

function plugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'figma@openai-curated-remote',
    remotePluginId: 'plugin_connector_figma',
    version: '1.0.0',
    localVersion: null,
    name: 'figma',
    shareContext: null,
    source: { type: 'remote' },
    installed: false,
    enabled: false,
    installPolicy: 'AVAILABLE',
    installPolicySource: null,
    authPolicy: 'ON_INSTALL',
    availability: 'AVAILABLE',
    interface: null,
    keywords: [],
    ...overrides
  }
}

function marketplace(overrides: Partial<PluginMarketplaceEntry> = {}): PluginMarketplaceEntry {
  return {
    name: 'openai-curated-remote',
    path: null,
    interface: null,
    plugins: [],
    ...overrides
  }
}

test('remote plugin lifecycle uses the backend remote id', () => {
  const remote = plugin()
  assert.deepEqual(pluginInstallParams(remote, marketplace()), {
    pluginName: 'plugin_connector_figma',
    marketplacePath: null,
    remoteMarketplaceName: 'openai-curated-remote'
  })
  assert.equal(pluginUninstallId(remote), 'plugin_connector_figma')
})

test('marketplace-backed local plugin lifecycle keeps name and installed id', () => {
  const local = plugin({
    id: 'lifecycle-smoke@personal',
    remotePluginId: null,
    name: 'lifecycle-smoke',
    source: { type: 'local', path: '/tmp/lifecycle-smoke' }
  })
  assert.deepEqual(pluginInstallParams(local, marketplace({ name: 'personal', path: '/tmp/marketplace.json' })), {
    pluginName: 'lifecycle-smoke',
    marketplacePath: '/tmp/marketplace.json',
    remoteMarketplaceName: null
  })
  assert.equal(pluginUninstallId(local), 'lifecycle-smoke@personal')
})

test('remote plugins without a backend id fail closed', () => {
  const remote = plugin({ remotePluginId: null })
  assert.equal(pluginInstallParams(remote, marketplace()), null)
  assert.equal(pluginUninstallId(remote), null)
})

test('plugin auth only opens trusted ChatGPT HTTPS install pages', () => {
  assert.equal(
    safePluginAuthUrl('https://chatgpt.com/apps/figma/connector_123'),
    'https://chatgpt.com/apps/figma/connector_123'
  )
  assert.equal(safePluginAuthUrl('https://auth.chatgpt.com/connect'), 'https://auth.chatgpt.com/connect')
  assert.equal(safePluginAuthUrl('http://chatgpt.com/apps/figma'), null)
  assert.equal(safePluginAuthUrl('https://example.com/apps/figma'), null)
  assert.equal(safePluginAuthUrl('javascript:alert(1)'), null)
})

test('auth completion requires every bundled app to be accessible', () => {
  const apps = [
    { id: 'one', name: 'One', description: null, installUrl: 'https://chatgpt.com/apps/one', category: null },
    { id: 'two', name: 'Two', description: null, installUrl: 'https://chatgpt.com/apps/two', category: null }
  ]
  assert.deepEqual(unresolvedPluginApps(apps, [
    { id: 'one', name: 'One', installUrl: apps[0].installUrl, isAccessible: true, isEnabled: true }
  ]), [apps[1]])
})

test('apps without an authentication destination do not create a dead-end connection prompt', () => {
  const apps = [{ id: 'local', name: 'Local', description: null, installUrl: null, category: null }]
  assert.deepEqual(unresolvedPluginApps(apps, []), [])
})
