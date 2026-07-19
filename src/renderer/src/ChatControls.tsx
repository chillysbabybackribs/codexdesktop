import { type FormEvent, useEffect, useState } from 'react';
import type {
  ThreadGoal,
  ThreadGoalStatus,
  ThreadTokenUsage,
} from '../../shared/session-protocol';

export function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 3.5 9 9m0-9-9 9" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg
      className="workspace-pill-icon"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2a1.5 1.5 0 0 1 1.06.44l1.06 1.06A1.5 1.5 0 0 0 11.88 7H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SettingsModal({
  goal,
  isGoalUpdating,
  onSaveGoal,
  onSetGoalStatus,
  onClearGoal,
  onOpenPlugins,
  onClose,
}: {
  goal: ThreadGoal | null;
  isGoalUpdating: boolean;
  onSaveGoal: (objective: string, tokenBudget: number | null) => Promise<boolean>;
  onSetGoalStatus: (status: Extract<ThreadGoalStatus, 'active' | 'paused'>) => Promise<void>;
  onClearGoal: () => Promise<void>;
  onOpenPlugins: () => void;
  onClose: () => void;
}): React.JSX.Element {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // The browser is a native view above the DOM, so hide it while this modal is
  // open — otherwise it renders on top of the modal. Restored on unmount.
  useEffect(() => {
    void window.api.browser.setOverlayOpen(true);
    return () => {
      void window.api.browser.setOverlayOpen(false);
    };
  }, []);

  return (
    <div className="settings-overlay" onPointerDown={onClose}>
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <h2 className="settings-title">Settings</h2>
          <button
            type="button"
            className="settings-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <section className="settings-section">
          <h3 className="settings-section-title">Thread goal</h3>
          <GoalSettings
            goal={goal}
            disabled={isGoalUpdating}
            onSave={onSaveGoal}
            onSetStatus={onSetGoalStatus}
            onClear={onClearGoal}
          />
        </section>
        <section className="settings-section">
          <h3 className="settings-section-title">Extensions</h3>
          <button type="button" className="settings-navigation-row" onClick={onOpenPlugins}>
            <span className="settings-row-text">
              <span className="settings-row-label">Plugin Settings</span>
              <span className="settings-row-hint">
                Browse, install, and remove plugins available through @ mentions.
              </span>
            </span>
            <span className="settings-navigation-arrow" aria-hidden="true">
              →
            </span>
          </button>
        </section>
      </div>
    </div>
  );
}

export function WorkspacePill({
  workspace,
  onPickWorkspace,
}: {
  workspace: string | null;
  onPickWorkspace: () => Promise<void>;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="workspace-pill"
      title={workspace ?? 'No workspace selected — new chats start in your home folder'}
      onClick={() => void onPickWorkspace()}
    >
      <FolderIcon />
      <span className="workspace-pill-name">
        {workspace ? workspaceName(workspace) : 'Choose workspace'}
      </span>
      <span className="workspace-pill-caret">⌄</span>
    </button>
  );
}

// Composer pill showing how full the thread's model context is (the last
// model call's tokens against the model window). Clicking it asks the
// app-server to compact the thread; auto-compaction also runs at 80% from the
// main process, so this is the "clean up now" affordance.
export function ContextPill({
  usage,
  disabled,
  compacting,
  onCompact,
}: {
  usage: ThreadTokenUsage | null;
  disabled: boolean;
  compacting: boolean;
  onCompact: () => Promise<void>;
}): React.JSX.Element {
  const window = usage?.modelContextWindow;
  const contextTokens = usage?.last.totalTokens ?? 0;
  const hasUsage = Boolean(usage && window && contextTokens > 0);
  const percent =
    hasUsage && window ? Math.min(100, Math.round((contextTokens / window) * 100)) : 0;
  const level = percent >= 80 ? 'is-high' : percent >= 60 ? 'is-warm' : '';
  const title = compacting
    ? 'Compacting the conversation…'
    : hasUsage && window
      ? `Context ${percent}% full (${contextTokens.toLocaleString()} of ${window.toLocaleString()} tokens). Click to compact the conversation.`
      : 'Context usage will appear after the first model response.';

  return (
    <button
      type="button"
      className={`context-pill ${level} ${hasUsage ? '' : 'is-empty'} ${compacting ? 'is-compacting' : ''}`}
      disabled={disabled || !hasUsage}
      aria-label={title}
      title={title}
      onClick={() => void onCompact()}
    >
      <span className="context-pill-ring" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <circle className="context-pill-ring-track" cx="12" cy="12" r="8" />
          <circle
            className="context-pill-ring-fill"
            cx="12"
            cy="12"
            r="8"
            pathLength="100"
            style={{ strokeDasharray: `${percent} 100` }}
          />
        </svg>
      </span>
    </button>
  );
}

// Thread-scoped goal controls live in settings so the composer remains focused
// on composing, while preserving the app-server goal lifecycle and usage data.
function GoalSettings({
  goal,
  disabled,
  onSave,
  onSetStatus,
  onClear,
}: {
  goal: ThreadGoal | null;
  disabled: boolean;
  onSave: (objective: string, tokenBudget: number | null) => Promise<boolean>;
  onSetStatus: (status: Extract<ThreadGoalStatus, 'active' | 'paused'>) => Promise<void>;
  onClear: () => Promise<void>;
}): React.JSX.Element {
  const [objective, setObjective] = useState(goal?.objective ?? '');
  const [tokenBudget, setTokenBudget] = useState(goal?.tokenBudget ? String(goal.tokenBudget) : '');

  useEffect(() => {
    setObjective(goal?.objective ?? '');
    setTokenBudget(goal?.tokenBudget ? String(goal.tokenBudget) : '');
  }, [goal?.objective, goal?.tokenBudget]);

  const submitGoal = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const parsedBudget = tokenBudget.trim() ? Number(tokenBudget) : null;
    if (parsedBudget !== null && (!Number.isFinite(parsedBudget) || parsedBudget <= 0)) return;

    const saved = await onSave(objective, parsedBudget === null ? null : Math.floor(parsedBudget));
    if (!saved) return;
  };

  return (
    <div className="goal-settings">
      <div className="goal-settings-heading">
        <div>
          <p className="goal-settings-label">
            Keep this thread working toward a persistent objective.
          </p>
        </div>
        {goal ? (
          <span className="goal-settings-status">
            <span className={`goal-status-dot is-${goal.status}`} aria-hidden="true" />
            {goalStatusLabel(goal.status)}
          </span>
        ) : null}
      </div>
      <form onSubmit={(event) => void submitGoal(event)}>
        <label htmlFor="goal-objective">Objective</label>
        <textarea
          id="goal-objective"
          value={objective}
          rows={4}
          maxLength={1_000}
          disabled={disabled}
          placeholder="What should this thread keep working toward?"
          onChange={(event) => setObjective(event.target.value)}
        />
        <label htmlFor="goal-token-budget">Token budget</label>
        <input
          id="goal-token-budget"
          type="number"
          min="1"
          step="1000"
          value={tokenBudget}
          disabled={disabled}
          placeholder="No limit"
          onChange={(event) => setTokenBudget(event.target.value)}
        />
        {goal ? (
          <p className="goal-usage">
            {goal.tokensUsed.toLocaleString()} tokens · {formatGoalTime(goal.timeUsedSeconds)}
          </p>
        ) : null}
        <div className="goal-actions">
          <button type="submit" disabled={disabled || !objective.trim()}>
            {goal ? 'Update' : 'Start goal'}
          </button>
          {goal?.status === 'active' ? (
            <button type="button" disabled={disabled} onClick={() => void onSetStatus('paused')}>
              Pause
            </button>
          ) : goal?.status === 'paused' ? (
            <button type="button" disabled={disabled} onClick={() => void onSetStatus('active')}>
              Resume
            </button>
          ) : null}
          {goal ? (
            <button
              type="button"
              className="goal-clear"
              disabled={disabled}
              onClick={() => void onClear()}
            >
              Clear
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function goalStatusLabel(status: ThreadGoalStatus): string {
  return {
    active: 'Goal active',
    paused: 'Goal paused',
    blocked: 'Goal blocked',
    usageLimited: 'Usage limited',
    budgetLimited: 'Budget reached',
    complete: 'Goal complete',
  }[status];
}

function formatGoalTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds < 3_600
    ? `${minutes}m ${Math.round(seconds % 60)}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function workspaceName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}
