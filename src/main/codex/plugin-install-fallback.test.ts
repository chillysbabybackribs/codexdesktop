import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PluginMarketplaceEntry } from '../../shared/codex-protocol/v2/PluginMarketplaceEntry.js'
import type { PluginSummary } from '../../shared/codex-protocol/v2/PluginSummary.js'
import {
  localCuratedFallbackParams,
  mergeInstalledPlugins,
  parseRemotePluginManifestMismatch
} from './plugin-install-fallback.ts'

function plugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'semrush@openai-curated-remote',
    remotePluginId: 'plugin_connector_semrush',
    version: '2.0.0',
    localVersion: null,
    name: 'semrush',
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

function marketplace(
  name: string,
  path: string | null,
  plugins: PluginSummary[]
): PluginMarketplaceEntry {
  return { name, path, interface: null, plugins }
}

test('parses the app-server remote manifest identity mismatch', () => {
  assert.deepEqual(
    parseRemotePluginManifestMismatch(
      new Error(
        'install remote plugin bundle: plugin.json name `app-691f` does not match marketplace plugin name `semrush`'
      )
    ),
    { manifestName: 'app-691f', marketplacePluginName: 'semrush' }
  )
  assert.equal(parseRemotePluginManifestMismatch(new Error('network unavailable')), null)
})

test('uses an exact local curated entry for a remote manifest mismatch', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-plugin-fallback-test-'))
  const marketplacePath = join(codexHome, '.tmp', 'plugins', '.agents', 'plugins', 'marketplace.json')
  try {
    await mkdir(join(marketplacePath, '..'), { recursive: true })
    await writeFile(
      marketplacePath,
      JSON.stringify({
        plugins: [
          { name: 'semrush', source: { source: 'local', path: './plugins/semrush' } },
          { name: 'remote-only', source: { source: 'url', url: 'https://example.com/plugin.git' } }
        ]
      })
    )
    const error = new Error(
      'plugin.json name `app-691f` does not match marketplace plugin name `semrush`'
    )
    assert.deepEqual(
      await localCuratedFallbackParams(
        {
          pluginName: 'plugin_connector_semrush',
          marketplacePath: null,
          remoteMarketplaceName: 'openai-curated-remote'
        },
        error,
        codexHome
      ),
      {
        pluginName: 'semrush',
        marketplacePath,
        remoteMarketplaceName: null
      }
    )
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})

test('does not fall back for non-local or unrelated marketplace entries', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-plugin-fallback-test-'))
  const marketplacePath = join(codexHome, '.tmp', 'plugins', '.agents', 'plugins', 'marketplace.json')
  try {
    await mkdir(join(marketplacePath, '..'), { recursive: true })
    await writeFile(
      marketplacePath,
      JSON.stringify({ plugins: [{ name: 'semrush', source: { source: 'url' } }] })
    )
    const params = {
      pluginName: 'plugin_connector_semrush',
      marketplacePath: null,
      remoteMarketplaceName: 'openai-curated-remote'
    }
    assert.equal(
      await localCuratedFallbackParams(
        params,
        new Error('plugin.json name `app-691f` does not match marketplace plugin name `semrush`'),
        codexHome
      ),
      null
    )
    assert.equal(await localCuratedFallbackParams(params, new Error('network unavailable'), codexHome), null)
  } finally {
    await rm(codexHome, { recursive: true, force: true })
  }
})

test('merges locally installed plugins into a remote-only catalog response', () => {
  const remote = plugin()
  const local = plugin({
    id: 'semrush@openai-curated',
    remotePluginId: null,
    version: '1.0.3',
    localVersion: '1.0.3',
    source: { type: 'local', path: '/tmp/plugins/semrush' },
    installed: true,
    enabled: true
  })
  const result = mergeInstalledPlugins(
    {
      marketplaces: [marketplace('openai-curated-remote', null, [remote])],
      marketplaceLoadErrors: [],
      featuredPluginIds: [remote.id]
    },
    {
      marketplaces: [marketplace('openai-curated', '/tmp/marketplace.json', [local])],
      marketplaceLoadErrors: []
    }
  )
  assert.deepEqual(
    result.marketplaces.flatMap((entry) => entry.plugins.map((item) => item.id)),
    [remote.id, local.id]
  )
  assert.deepEqual(result.featuredPluginIds, [remote.id])
})
