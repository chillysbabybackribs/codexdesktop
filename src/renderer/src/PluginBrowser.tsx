import { useEffect, useRef } from 'react';
import type { PluginSummary } from '../../shared/session-protocol';
import { PluginSetupPanel } from './PluginSetupPanel';
import { usePluginBrowser } from './usePluginBrowser';

export function PluginGlyph({ plugin }: { plugin: PluginSummary }): React.JSX.Element {
  const icon =
    plugin.interface?.composerIconUrl || plugin.interface?.logoUrlDark || plugin.interface?.logoUrl;
  if (icon) return <img src={icon} alt="" />;
  const name = plugin.interface?.displayName || plugin.name;
  return <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

export function PluginBrowserView({
  workspace,
  onClose,
  onChanged,
}: {
  workspace: string | null;
  onClose: () => void;
  onChanged: (plugins: PluginSummary[]) => void;
}): React.JSX.Element {
  const {
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
  } = usePluginBrowser({ workspace, onChanged });
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

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
