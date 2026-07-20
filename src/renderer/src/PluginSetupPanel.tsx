import type {
  AppSummary,
  PluginAuthPolicy,
  PluginSummary,
} from '../../shared/session-protocol';

export type PluginSetupFlow = {
  plugin: PluginSummary;
  apps: AppSummary[];
  authPolicy: PluginAuthPolicy;
  phase: 'prompt' | 'opening' | 'waiting' | 'success' | 'error' | 'timeout';
  activeAppId: string | null;
  authTabId: string | null;
  error: string | null;
};

export function PluginSetupPanel({
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
