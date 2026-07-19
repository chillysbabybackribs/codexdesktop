import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PluginInstallParams } from '../../shared/codex-protocol/v2/PluginInstallParams.js'
import type { PluginInstalledResponse } from '../../shared/codex-protocol/v2/PluginInstalledResponse.js'
import type { PluginListResponse } from '../../shared/codex-protocol/v2/PluginListResponse.js'

type MarketplacePluginEntry = {
  name?: unknown
  source?: unknown
}

type MarketplaceFile = {
  plugins?: unknown
}

export type RemotePluginManifestMismatch = {
  manifestName: string
  marketplacePluginName: string
}

const manifestMismatchPattern =
  /plugin\.json name `([^`]+)` does not match marketplace plugin name `([^`]+)`/

export function parseRemotePluginManifestMismatch(error: unknown): RemotePluginManifestMismatch | null {
  if (!(error instanceof Error)) return null
  const match = error.message.match(manifestMismatchPattern)
  if (!match) return null
  return {
    manifestName: match[1]!,
    marketplacePluginName: match[2]!
  }
}

function isLocalMarketplaceEntry(value: unknown, pluginName: string): boolean {
  if (!value || typeof value !== 'object') return false
  const entry = value as MarketplacePluginEntry
  if (entry.name !== pluginName) return false
  if (typeof entry.source === 'string') return true
  if (!entry.source || typeof entry.source !== 'object') return false
  return (entry.source as { source?: unknown }).source === 'local'
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
}

export async function localCuratedFallbackParams(
  params: PluginInstallParams,
  error: unknown,
  codexHome = defaultCodexHome()
): Promise<PluginInstallParams | null> {
  if (params.marketplacePath || !params.remoteMarketplaceName) return null
  const mismatch = parseRemotePluginManifestMismatch(error)
  if (!mismatch) return null

  const marketplacePath = join(codexHome, '.tmp', 'plugins', '.agents', 'plugins', 'marketplace.json')
  let marketplace: MarketplaceFile
  try {
    marketplace = JSON.parse(await readFile(marketplacePath, 'utf8')) as MarketplaceFile
  } catch {
    return null
  }
  if (
    !Array.isArray(marketplace.plugins) ||
    !marketplace.plugins.some((entry) => isLocalMarketplaceEntry(entry, mismatch.marketplacePluginName))
  ) {
    return null
  }

  return {
    pluginName: mismatch.marketplacePluginName,
    marketplacePath,
    remoteMarketplaceName: null
  }
}

export function mergeInstalledPlugins(
  available: PluginListResponse,
  installed: PluginInstalledResponse
): PluginListResponse {
  const marketplaces = available.marketplaces.map((marketplace) => ({
    ...marketplace,
    plugins: [...marketplace.plugins]
  }))

  for (const installedMarketplace of installed.marketplaces) {
    const existingMarketplace = marketplaces.find(
      (marketplace) => marketplace.name === installedMarketplace.name && marketplace.path === installedMarketplace.path
    )
    if (!existingMarketplace) {
      marketplaces.push(installedMarketplace)
      continue
    }
    const existingIds = new Set(existingMarketplace.plugins.map((plugin) => plugin.id))
    existingMarketplace.plugins.push(
      ...installedMarketplace.plugins.filter((plugin) => !existingIds.has(plugin.id))
    )
  }

  const loadErrorKeys = new Set(
    available.marketplaceLoadErrors.map((error) => `${error.marketplacePath}\u0000${error.message}`)
  )
  const marketplaceLoadErrors = [
    ...available.marketplaceLoadErrors,
    ...installed.marketplaceLoadErrors.filter(
      (error) => !loadErrorKeys.has(`${error.marketplacePath}\u0000${error.message}`)
    )
  ]

  return { ...available, marketplaces, marketplaceLoadErrors }
}
