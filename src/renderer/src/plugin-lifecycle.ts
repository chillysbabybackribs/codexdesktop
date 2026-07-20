import type { CodexPluginInstallParams, CodexPluginAppStatus } from '../../shared/ipc'
import type { AppSummary } from '../../shared/session-protocol'
import type { PluginMarketplaceEntry } from '../../shared/session-protocol'
import type { PluginSummary } from '../../shared/session-protocol'

export function isRemotePlugin(plugin: PluginSummary): boolean {
  return plugin.source.type === 'remote'
}

export function flattenPlugins(marketplaces: PluginMarketplaceEntry[]): PluginSummary[] {
  return [
    ...new Map(
      marketplaces
        .flatMap((marketplace) => marketplace.plugins)
        .map((plugin) => [plugin.id, plugin])
    ).values()
  ]
}

export function pluginInstallParams(
  plugin: PluginSummary,
  marketplace?: PluginMarketplaceEntry
): CodexPluginInstallParams | null {
  const remote = isRemotePlugin(plugin)
  const pluginName = remote ? plugin.remotePluginId : plugin.name
  if (!pluginName) return null

  return {
    pluginName,
    marketplacePath: remote ? null : marketplace?.path ?? null,
    remoteMarketplaceName: remote ? marketplace?.name ?? null : null
  }
}

export function pluginUninstallId(plugin: PluginSummary): string | null {
  return isRemotePlugin(plugin) ? plugin.remotePluginId : plugin.id
}

export function safePluginAuthUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || (hostname !== 'chatgpt.com' && !hostname.endsWith('.chatgpt.com'))) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

export function unresolvedPluginApps(
  apps: AppSummary[],
  statuses: CodexPluginAppStatus[]
): AppSummary[] {
  const statusById = new Map(statuses.map((status) => [status.id, status]))
  return apps.filter((app) => Boolean(app.installUrl) && !statusById.get(app.id)?.isAccessible)
}
