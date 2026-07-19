import { useState } from 'react';
import type { PluginSummary } from '../../shared/session-protocol';
import { pluginUninstallId } from './plugin-lifecycle';
import { PluginGlyph } from './PluginBrowser';

export function PluginMentionMenu({
  state,
  plugins,
  selectedIndex,
  onChoose,
  onBrowse,
  onUninstalled,
}: {
  state: 'loading' | 'ready' | 'error';
  plugins: PluginSummary[];
  selectedIndex: number;
  onChoose: (plugin: PluginSummary) => void;
  onBrowse: () => void;
  onUninstalled: (pluginId: string) => void;
}): React.JSX.Element {
  const [removing, setRemoving] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const remove = (plugin: PluginSummary): void => {
    if (armed !== plugin.id) {
      setArmed(plugin.id);
      return;
    }
    const uninstallId = pluginUninstallId(plugin);
    if (!uninstallId) return;
    setRemoving(plugin.id);
    void window.api.session
      .uninstallPlugin(uninstallId)
      .then(() => {
        onUninstalled(plugin.id);
        setArmed(null);
      })
      .finally(() => setRemoving(null));
  };

  return (
    <div className="plugin-mention-menu" role="listbox" aria-label="Installed plugins">
      <div className="plugin-mention-heading">
        <span>Installed plugins</span>
        <span>{plugins.length || ''}</span>
      </div>
      <div className="plugin-mention-list">
        {state === 'loading' ? (
          <div className="plugin-menu-message shimmer-text">Loading plugins…</div>
        ) : null}
        {state === 'error' ? (
          <div className="plugin-menu-message">Plugins could not be loaded.</div>
        ) : null}
        {state === 'ready' && !plugins.length ? (
          <div className="plugin-menu-message">No matching installed plugins.</div>
        ) : null}
        {state === 'ready'
          ? plugins.map((plugin, index) => (
              <div
                className={`plugin-mention-row ${selectedIndex === index ? 'is-selected' : ''}`}
                key={plugin.id}
                role="option"
                aria-selected={selectedIndex === index}
              >
                <button
                  type="button"
                  className="plugin-mention-select"
                  onClick={() => onChoose(plugin)}
                >
                  <span className="plugin-glyph">
                    <PluginGlyph plugin={plugin} />
                  </span>
                  <span className="plugin-mention-copy">
                    <strong>{plugin.interface?.displayName || plugin.name}</strong>
                    <small>
                      {plugin.interface?.shortDescription ||
                        plugin.interface?.capabilities.slice(0, 2).join(' · ') ||
                        'Plugin'}
                    </small>
                  </span>
                </button>
                <button
                  type="button"
                  className={`plugin-remove ${armed === plugin.id ? 'is-armed' : ''}`}
                  aria-label={
                    armed === plugin.id ? `Confirm remove ${plugin.name}` : `Remove ${plugin.name}`
                  }
                  title={armed === plugin.id ? 'Click again to remove' : 'Remove plugin'}
                  disabled={removing === plugin.id}
                  onClick={() => remove(plugin)}
                >
                  {armed === plugin.id ? <span>Remove</span> : <TrashIcon />}
                </button>
              </div>
            ))
          : null}
      </div>
      <button type="button" className="browse-plugins-button" onClick={onBrowse}>
        <span>Browse plugins</span>
        <span aria-hidden="true">↗</span>
      </button>
    </div>
  );
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
