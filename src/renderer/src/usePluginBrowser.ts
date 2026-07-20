import { useCallback, useEffect, useState } from 'react';
import type {
  AppSummary,
  PluginMarketplaceEntry,
  PluginSummary,
} from '../../shared/session-protocol';
import {
  flattenPlugins,
  pluginInstallParams,
  pluginUninstallId,
  safePluginAuthUrl,
  unresolvedPluginApps,
} from './plugin-lifecycle';
import type { PluginSetupFlow } from './PluginSetupPanel';

export type PluginConnectionInfo = {
  apps: AppSummary[];
  needsAuth: AppSummary[];
};

export function usePluginBrowser({
  workspace,
  onChanged,
}: {
  workspace: string | null;
  onChanged: (plugins: PluginSummary[]) => void;
}): {
  query: string;
  setQuery: (query: string) => void;
  state: 'loading' | 'ready' | 'error';
  busyId: string | null;
  connectionByPluginId: Record<string, PluginConnectionInfo>;
  setup: PluginSetupFlow | null;
  setSetup: React.Dispatch<React.SetStateAction<PluginSetupFlow | null>>;
  isCheckingAuth: boolean;
  actionError: string | null;
  setActionError: (error: string | null) => void;
  plugins: PluginSummary[];
  firstMarketplaceByPluginId: Map<string, PluginMarketplaceEntry>;
  load: (showLoading?: boolean) => Promise<void>;
  beginConnection: (plugin: PluginSummary, apps: AppSummary[]) => void;
  install: (plugin: PluginSummary, marketplace: PluginMarketplaceEntry | undefined) => Promise<void>;
  uninstall: (plugin: PluginSummary) => Promise<void>;
  openAuthentication: () => Promise<void>;
  verifyAuthentication: () => Promise<void>;
  dismissSetup: () => void;
} {
  const [marketplaces, setMarketplaces] = useState<PluginMarketplaceEntry[]>([]);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connectionByPluginId, setConnectionByPluginId] = useState<
    Record<string, PluginConnectionInfo>
  >({});
  const [setup, setSetup] = useState<PluginSetupFlow | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshConnections = useCallback(
    async (nextMarketplaces: PluginMarketplaceEntry[]): Promise<void> => {
      const installed = nextMarketplaces.flatMap((marketplace) =>
        marketplace.plugins
          .filter((plugin) => plugin.installed)
          .map((plugin) => ({ marketplace, plugin })),
      );
      if (!installed.length) {
        setConnectionByPluginId({});
        return;
      }

      const detailResults = await Promise.allSettled(
        installed.map(async ({ marketplace, plugin }) => {
          const params = pluginInstallParams(plugin, marketplace);
          if (!params) return { pluginId: plugin.id, apps: [] as AppSummary[] };
          const response = await window.api.session.readPlugin(params);
          return { pluginId: plugin.id, apps: response.plugin.apps };
        }),
      );
      const appGroups = detailResults.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const appIds = [...new Set(appGroups.flatMap((group) => group.apps.map((app) => app.id)))];
      const statuses = appIds.length
        ? (await window.api.session.getPluginAppStatuses({ appIds })).apps
        : [];
      const nextConnections: Record<string, PluginConnectionInfo> = {};
      for (const group of appGroups) {
        nextConnections[group.pluginId] = {
          apps: group.apps,
          needsAuth: unresolvedPluginApps(group.apps, statuses),
        };
      }
      setConnectionByPluginId(nextConnections);
    },
    [],
  );

  const load = useCallback(
    async (showLoading = true): Promise<void> => {
      if (showLoading) setState('loading');
      try {
        const result = await window.api.session.listPlugins({ cwd: workspace });
        setMarketplaces(result.marketplaces);
        onChanged(flattenPlugins(result.marketplaces).filter((plugin) => plugin.installed));
        setState('ready');
        void refreshConnections(result.marketplaces).catch((error) => {
          console.warn('Plugin connection refresh failed; statuses may be stale', error);
        });
      } catch {
        setState('error');
      }
    },
    [workspace, onChanged, refreshConnections],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const plugins = flattenPlugins(marketplaces).filter((plugin) => {
    const haystack = [
      plugin.name,
      plugin.interface?.displayName,
      plugin.interface?.shortDescription,
      plugin.interface?.category,
      ...plugin.keywords,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return !query.trim() || haystack.includes(query.trim().toLowerCase());
  });

  const firstMarketplaceByPluginId = new Map<string, PluginMarketplaceEntry>();
  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      if (!firstMarketplaceByPluginId.has(plugin.id))
        firstMarketplaceByPluginId.set(plugin.id, marketplace);
    }
  }

  const beginConnection = (
    plugin: PluginSummary,
    apps: AppSummary[],
    authPolicy = plugin.authPolicy,
  ): void => {
    setActionError(null);
    setSetup({
      plugin,
      apps,
      authPolicy,
      phase: 'prompt',
      activeAppId: null,
      authTabId: null,
      error: null,
    });
  };

  const install = async (
    plugin: PluginSummary,
    marketplace: PluginMarketplaceEntry | undefined,
  ): Promise<void> => {
    const params = pluginInstallParams(plugin, marketplace);
    if (!params) {
      setActionError(
        `${plugin.interface?.displayName || plugin.name} is missing its remote installation identifier.`,
      );
      return;
    }
    setActionError(null);
    setBusyId(plugin.id);
    try {
      const result = await window.api.session.installPlugin(params);
      await load(false);
      if (result.appsNeedingAuth.length) {
        setConnectionByPluginId((current) => ({
          ...current,
          [plugin.id]: { apps: result.appsNeedingAuth, needsAuth: result.appsNeedingAuth },
        }));
        beginConnection(
          { ...plugin, installed: true, enabled: true },
          result.appsNeedingAuth,
          result.authPolicy,
        );
      } else {
        setSetup({
          plugin: { ...plugin, installed: true, enabled: true },
          apps: [],
          authPolicy: result.authPolicy,
          phase: 'success',
          activeAppId: null,
          authTabId: null,
          error: null,
        });
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Could not install ${plugin.name}.`);
    } finally {
      setBusyId(null);
    }
  };

  const uninstall = async (plugin: PluginSummary): Promise<void> => {
    const uninstallId = pluginUninstallId(plugin);
    if (!uninstallId) {
      setActionError(
        `${plugin.interface?.displayName || plugin.name} is missing its remote installation identifier.`,
      );
      return;
    }
    setActionError(null);
    setBusyId(plugin.id);
    try {
      await window.api.session.uninstallPlugin(uninstallId);
      setSetup((current) => (current?.plugin.id === plugin.id ? null : current));
      await load(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Could not remove ${plugin.name}.`);
    } finally {
      setBusyId(null);
    }
  };

  const openAuthentication = async (): Promise<void> => {
    const app = setup?.apps[0];
    const installUrl = safePluginAuthUrl(app?.installUrl);
    if (!setup || !app || !installUrl) {
      setSetup((current) =>
        current
          ? {
              ...current,
              phase: 'error',
              error: 'This connector did not provide a trusted ChatGPT authentication page.',
            }
          : current,
      );
      return;
    }
    setSetup((current) =>
      current ? { ...current, phase: 'opening', activeAppId: app.id, error: null } : current,
    );
    try {
      const tabId = await window.api.browser.newTab(installUrl);
      if (!tabId) throw new Error('The authentication tab could not be opened.');
      setSetup((current) =>
        current ? { ...current, phase: 'waiting', authTabId: tabId } : current,
      );
    } catch (error) {
      setSetup((current) =>
        current
          ? {
              ...current,
              phase: 'error',
              error:
                error instanceof Error
                  ? error.message
                  : 'The authentication tab could not be opened.',
            }
          : current,
      );
    }
  };

  const verifyAuthentication = useCallback(async (): Promise<void> => {
    if (!setup || setup.phase !== 'waiting') return;
    setIsCheckingAuth(true);
    try {
      const response = await window.api.session.getPluginAppStatuses({
        appIds: setup.apps.map((app) => app.id),
        forceRefetch: true,
      });
      const remaining = unresolvedPluginApps(setup.apps, response.apps);
      setConnectionByPluginId((current) => ({
        ...current,
        [setup.plugin.id]: { apps: setup.apps, needsAuth: remaining },
      }));
      if (!remaining.length) {
        if (setup.authTabId) void window.api.browser.closeTab(setup.authTabId);
        setSetup((current) =>
          current?.plugin.id === setup.plugin.id
            ? {
                ...current,
                phase: 'success',
                apps: [],
                activeAppId: null,
                authTabId: null,
                error: null,
              }
            : current,
        );
        await load(false);
      } else if (remaining.length < setup.apps.length) {
        if (setup.authTabId) void window.api.browser.closeTab(setup.authTabId);
        setSetup((current) =>
          current?.plugin.id === setup.plugin.id
            ? {
                ...current,
                phase: 'prompt',
                apps: remaining,
                activeAppId: null,
                authTabId: null,
                error: null,
              }
            : current,
        );
      }
    } catch (error) {
      setSetup((current) =>
        current?.plugin.id === setup.plugin.id
          ? {
              ...current,
              phase: 'error',
              error: error instanceof Error ? error.message : 'Could not verify the connection.',
            }
          : current,
      );
    } finally {
      setIsCheckingAuth(false);
    }
  }, [setup, load]);

  useEffect(() => {
    if (!setup || setup.phase !== 'waiting') return;
    const pluginId = setup.plugin.id;
    let lastLoadedUrl = '';
    const dispose = window.api.browser.onState((browser) => {
      const tab = browser.tabs.find((candidate) => candidate.id === setup.authTabId);
      if (!tab || (!tab.isLoading && tab.url !== lastLoadedUrl)) {
        lastLoadedUrl = tab?.url ?? '';
        void verifyAuthentication();
      }
    });
    const interval = window.setInterval(() => void verifyAuthentication(), 5_000);
    const timeout = window.setTimeout(() => {
      setSetup((current) =>
        current?.plugin.id === pluginId && current.phase === 'waiting'
          ? {
              ...current,
              phase: 'timeout',
              error: 'Still waiting for ChatGPT to confirm this connection.',
            }
          : current,
      );
    }, 120_000);
    void verifyAuthentication();
    return () => {
      dispose();
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [setup?.plugin.id, setup?.phase, setup?.authTabId, verifyAuthentication]);

  const dismissSetup = (): void => {
    if (setup?.authTabId) void window.api.browser.closeTab(setup.authTabId);
    setSetup(null);
  };

  return {
    query,
    setQuery,
    state,
    busyId,
    connectionByPluginId,
    setup,
    setSetup,
    isCheckingAuth,
    actionError,
    setActionError,
    plugins,
    firstMarketplaceByPluginId,
    load,
    beginConnection,
    install,
    uninstall,
    openAuthentication,
    verifyAuthentication,
    dismissSetup,
  };
}
