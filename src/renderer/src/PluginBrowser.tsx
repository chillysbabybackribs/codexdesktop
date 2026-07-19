import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppSummary,
  PluginAuthPolicy,
  PluginMarketplaceEntry,
  PluginSummary,
} from '../../shared/session-protocol';
import {
  pluginInstallParams,
  pluginUninstallId,
  safePluginAuthUrl,
  unresolvedPluginApps,
} from './plugin-lifecycle';

export function flattenPlugins(marketplaces: PluginMarketplaceEntry[]): PluginSummary[] {
  return [
    ...new Map(
      marketplaces
        .flatMap((marketplace) => marketplace.plugins)
        .map((plugin) => [plugin.id, plugin]),
    ).values(),
  ];
}

export function PluginGlyph({ plugin }: { plugin: PluginSummary }): React.JSX.Element {
  const icon =
    plugin.interface?.composerIconUrl || plugin.interface?.logoUrlDark || plugin.interface?.logoUrl;
  if (icon) return <img src={icon} alt="" />;
  const name = plugin.interface?.displayName || plugin.name;
  return <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

type PluginConnectionInfo = {
  apps: AppSummary[];
  needsAuth: AppSummary[];
};

type PluginSetupFlow = {
  plugin: PluginSummary;
  apps: AppSummary[];
  authPolicy: PluginAuthPolicy;
  phase: 'prompt' | 'opening' | 'waiting' | 'success' | 'error' | 'timeout';
  activeAppId: string | null;
  authTabId: string | null;
  error: string | null;
};

export function PluginBrowserView({
  workspace,
  onClose,
  onChanged,
}: {
  workspace: string | null;
  onClose: () => void;
  onChanged: (plugins: PluginSummary[]) => void;
}): React.JSX.Element {
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
  const closeRef = useRef<HTMLButtonElement | null>(null);

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
  useEffect(() => {
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

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

  return (
    <section className="plugin-browser-view" aria-labelledby="plugin-browser-title">
      <header className="plugin-browser-header">
        <button
          ref={closeRef}
          type="button"
          className="plugin-browser-back"
          aria-label="Back to chat"
          title="Back to chat"
          onClick={onClose}
        >
          <span aria-hidden="true">←</span>
        </button>
        <h2 id="plugin-browser-title">Plugins</h2>
      </header>
      <div className="plugin-browser-tools">
        <label>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
            <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search plugins and capabilities"
            aria-label="Search plugins"
          />
        </label>
      </div>
      <div className="plugin-browser-catalog">
        {setup ? (
          <PluginSetupPanel
            setup={setup}
            checking={isCheckingAuth}
            onConnect={() => void openAuthentication()}
            onCheck={() => void verifyAuthentication()}
            onRetry={() =>
              setSetup((current) =>
                current
                  ? { ...current, phase: current.authTabId ? 'waiting' : 'prompt', error: null }
                  : current,
              )
            }
            onDismiss={dismissSetup}
          />
        ) : null}
        {actionError ? (
          <div className="plugin-action-error" role="alert">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss error">
              ×
            </button>
          </div>
        ) : null}
        {state === 'loading' ? (
          <div className="plugin-browser-state shimmer-text">Loading plugin catalog…</div>
        ) : null}
        {state === 'error' ? (
          <div className="plugin-browser-state">
            The plugin catalog could not be loaded.{' '}
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : null}
        {state === 'ready' && !plugins.length ? (
          <div className="plugin-browser-state">No plugins match that search.</div>
        ) : null}
        {state === 'ready' && plugins.length ? (
          <section className="plugin-browser-group">
            <h3>Codex Desktop plugins</h3>
            <div className="plugin-browser-grid">
              {plugins.map((plugin) => {
                const name = plugin.interface?.displayName || plugin.name;
                const marketplace = firstMarketplaceByPluginId.get(plugin.id);
                const connection = connectionByPluginId[plugin.id];
                const needsAuth = Boolean(connection?.needsAuth.length);
                const action =
                  busyId === plugin.id
                    ? 'Working…'
                    : needsAuth
                      ? 'Connect'
                      : plugin.installed
                        ? 'Remove'
                        : plugin.availability === 'AVAILABLE'
                          ? 'Get'
                          : 'Unavailable';
                const status = plugin.installed
                  ? needsAuth
                    ? 'Connection required'
                    : connection?.apps.length
                      ? 'Connected'
                      : 'Ready'
                  : null;
                return (
                  <article className="plugin-browser-card" key={plugin.id}>
                    <span className="plugin-glyph is-large">
                      <PluginGlyph plugin={plugin} />
                    </span>
                    <div className="plugin-browser-card-copy">
                      <h4>{name}</h4>
                      <p>
                        {plugin.interface?.shortDescription ||
                          plugin.interface?.longDescription ||
                          'Adds focused capabilities to Codex Desktop.'}
                      </p>
                      {status ? (
                        <span
                          className={`plugin-card-status ${needsAuth ? 'needs-auth' : 'is-ready'}`}
                        >
                          <i aria-hidden="true" />
                          {status}
                        </span>
                      ) : null}
                    </div>
                    <div className="plugin-card-actions">
                      <button
                        type="button"
                        className={`plugin-install-button ${plugin.installed && !needsAuth ? 'is-installed' : ''} ${needsAuth ? 'needs-auth' : ''}`}
                        aria-label={`${action} ${name}`}
                        disabled={busyId === plugin.id || plugin.availability !== 'AVAILABLE'}
                        onClick={() =>
                          needsAuth
                            ? beginConnection(plugin, connection.needsAuth)
                            : plugin.installed
                              ? void uninstall(plugin)
                              : void install(plugin, marketplace)
                        }
                      >
                        {action}
                      </button>
                      {needsAuth ? (
                        <button
                          type="button"
                          className="plugin-remove-link"
                          disabled={busyId === plugin.id}
                          onClick={() => void uninstall(plugin)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function PluginSetupPanel({
  setup,
  checking,
  onConnect,
  onCheck,
  onRetry,
  onDismiss,
}: {
  setup: PluginSetupFlow;
  checking: boolean;
  onConnect: () => void;
  onCheck: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const pluginName = setup.plugin.interface?.displayName || setup.plugin.name;
  const appName = setup.apps[0]?.name || pluginName;
  const isSuccess = setup.phase === 'success';
  const isProblem = setup.phase === 'error' || setup.phase === 'timeout';
  const title = isSuccess
    ? `${pluginName} is ready`
    : setup.phase === 'waiting'
      ? `Finish connecting ${appName}`
      : isProblem
        ? `Connection needs attention`
        : `${pluginName} is installed`;
  const copy = isSuccess
    ? 'Its skills and connected tools will be available in your next chat.'
    : setup.phase === 'waiting'
      ? 'Complete the sign-in in the browser. This page will update automatically when ChatGPT confirms access.'
      : setup.phase === 'timeout'
        ? 'The plugin is still installed. Keep the authentication page open and check again, or finish later.'
        : setup.phase === 'error'
          ? setup.error || 'The connection could not be verified.'
          : `${appName} needs your permission before its connected tools can be used.`;

  return (
    <section
      className={`plugin-setup-panel is-${isSuccess ? 'success' : isProblem ? 'problem' : setup.phase}`}
      aria-live="polite"
    >
      <span className="plugin-setup-icon" aria-hidden="true">
        {isSuccess ? '✓' : isProblem ? '!' : '↗'}
      </span>
      <div className="plugin-setup-copy">
        <div className="plugin-setup-heading">
          <span>
            {isSuccess
              ? 'Setup complete'
              : setup.phase === 'waiting'
                ? 'Browser connection'
                : 'One more step'}
          </span>
          <strong>{title}</strong>
        </div>
        <p>{copy}</p>
        {setup.phase === 'waiting' ? (
          <div className="plugin-setup-progress">
            <span className="plugin-setup-spinner" aria-hidden="true" />
            <span>{checking ? 'Checking connection…' : 'Waiting for authorization…'}</span>
          </div>
        ) : null}
      </div>
      <div className="plugin-setup-actions">
        {setup.phase === 'prompt' ? (
          <button type="button" className="plugin-setup-primary" onClick={onConnect}>
            Connect {appName}
          </button>
        ) : null}
        {setup.phase === 'opening' ? (
          <button type="button" className="plugin-setup-primary" disabled>
            Opening browser…
          </button>
        ) : null}
        {setup.phase === 'waiting' ? (
          <button
            type="button"
            className="plugin-setup-primary"
            disabled={checking}
            onClick={onCheck}
          >
            {checking ? 'Checking…' : 'Check now'}
          </button>
        ) : null}
        {isProblem ? (
          <button type="button" className="plugin-setup-primary" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        <button type="button" className="plugin-setup-secondary" onClick={onDismiss}>
          {isSuccess ? 'Done' : 'Finish later'}
        </button>
      </div>
    </section>
  );
}
