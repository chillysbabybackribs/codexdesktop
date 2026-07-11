import type { CodexPluginInstallParams, CodexPluginAppStatus } from '../../shared/ipc'
import type { AppSummary } from '../../shared/codex-protocol/v2/AppSummary'
import type { PluginMarketplaceEntry } from '../../shared/codex-protocol/v2/PluginMarketplaceEntry'
import type { PluginSummary } from '../../shared/codex-protocol/v2/PluginSummary'

export function isRemotePlugin(plugin: PluginSummary, marketplace?: PluginMarketplaceEntry): boolean {
  return plugin.source.type === 'remote' || (!marketplace?.path && Boolean(plugin.remotePluginId))
}

export function pluginInstallParams(
  plugin: PluginSummary,
  marketplace?: PluginMarketplaceEntry
): CodexPluginInstallParams | null {
  const remote = isRemotePlugin(plugin, marketplace)
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
  return apps.filter((app) => !statusById.get(app.id)?.isAccessible)
}
