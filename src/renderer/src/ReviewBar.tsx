import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { parseUnifiedDiff } from './diff';
import type { ThreadItem } from '../../shared/session-protocol';

// Cursor-style post-generation review bar: after a turn that edited files
// settles, this bar floats above the composer summarizing the changes with
// Keep all / Undo all and per-file undo. Edits are already applied (the app
// auto-applies, like Cursor 2.x) — this is the post-hoc review surface.

type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>;
export type ReviewChange = FileChangeItem['changes'][number];

export function ReviewBar({
  changes,
  workspace,
  undonePaths,
  alwaysKeepAll,
  elapsedLabel,
  onKeepAll,
  onSetAlwaysKeepAll,
  onUndoAll,
  onUndoFile,
  onRestoreCheckpoint,
}: {
  changes: ReviewChange[];
  workspace: string | null;
  undonePaths: ReadonlySet<string>;
  alwaysKeepAll: boolean;
  elapsedLabel?: string | null;
  onKeepAll: () => void;
  onSetAlwaysKeepAll: (enabled: boolean) => void;
  onUndoAll: () => void;
  onUndoFile: (path: string) => void;
  onRestoreCheckpoint?: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [confirmingUndoAll, setConfirmingUndoAll] = useState(false);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!actionsOpen) {
      setConfirmingUndoAll(false);
      setConfirmingRestore(false);
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      actionsMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    });
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (
        actionsRef.current &&
        event.target instanceof Node &&
        !actionsRef.current.contains(event.target)
      ) {
        setActionsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setActionsOpen(false);
      actionsTriggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [actionsOpen]);

  const files = useMemo(
    () =>
      changes.map((change) => {
        const parsed = parseUnifiedDiff(
          change.diff,
          change.kind.type === 'add' ? 'add' : change.kind.type === 'delete' ? 'del' : undefined,
        );
        return { path: change.path, adds: parsed.adds, dels: parsed.dels };
      }),
    [changes],
  );
  const totalAdds = files.reduce((sum, file) => sum + file.adds, 0);
  const totalDels = files.reduce((sum, file) => sum + file.dels, 0);

  const handleActionsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      className={`review-bar ${actionsOpen ? 'is-action-menu-open' : ''}`}
      role="region"
      aria-label="Review changes"
    >
      <div className="review-bar-head">
        <button
          type="button"
          className="review-bar-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <ReviewChevron className={`review-chevron ${expanded ? 'is-open' : ''}`} />
          <span className="review-bar-count">
            {files.length} {files.length === 1 ? 'file' : 'files'} changed
          </span>
          <span className="review-bar-totals">
            {totalAdds > 0 ? <span className="diff-count-add">+{totalAdds}</span> : null}
            {totalDels > 0 ? <span className="diff-count-del">−{totalDels}</span> : null}
          </span>
        </button>
        {elapsedLabel ? <span className="review-bar-elapsed">{elapsedLabel}</span> : null}
        {!alwaysKeepAll ? (
          <div className="review-bar-actions">
            <button
              type="button"
              className={`review-undo-all ${confirmingUndoAll ? 'is-confirming' : ''}`}
              title="Restore every workspace file to how it was before this turn (including files changed by shell commands). The current state is checkpointed first."
              onClick={() => {
                if (confirmingUndoAll) {
                  setConfirmingUndoAll(false);
                  onUndoAll();
                } else {
                  setConfirmingUndoAll(true);
                }
              }}
              onBlur={() => setConfirmingUndoAll(false)}
            >
              {confirmingUndoAll ? 'Undo all changes?' : 'Undo all'}
            </button>
            <button
              type="button"
              className="review-always-keep"
              aria-pressed="false"
              title="Automatically keep future edits while continuing to show each turn's change summary and Undo controls."
              onClick={() => onSetAlwaysKeepAll(true)}
            >
              <span className="review-always-keep-mark" aria-hidden="true">
                ✓
              </span>
              Always keep all
            </button>
            <button type="button" className="review-keep-all" onClick={onKeepAll}>
              Keep all
            </button>
          </div>
        ) : null}
        <div className="review-compact-actions" ref={actionsRef}>
          <button
            ref={actionsTriggerRef}
            type="button"
            className={`review-actions-trigger ${actionsOpen ? 'is-open' : ''}`}
            aria-label="Change actions"
            title="Change actions"
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen((open) => !open)}
          >
            <ReviewMenuDots />
          </button>
          {actionsOpen ? (
            <div
              ref={actionsMenuRef}
              className="review-action-menu"
              role="menu"
              aria-label="Change actions"
              onKeyDown={handleActionsKeyDown}
            >
              {onRestoreCheckpoint ? (
                <button
                  type="button"
                  className={`review-action-menu-item ${confirmingRestore ? 'is-confirming' : ''}`}
                  role="menuitem"
                  title="Restore the workspace files to how they were before this turn. The current state is checkpointed first."
                  onClick={() => {
                    if (confirmingRestore) {
                      setActionsOpen(false);
                      onRestoreCheckpoint();
                    } else {
                      setConfirmingRestore(true);
                    }
                  }}
                >
                  <MenuBookmarkIcon className="review-action-menu-icon" />
                  <span className="review-action-menu-label">
                    {confirmingRestore ? 'Confirm restore?' : 'Restore checkpoint'}
                  </span>
                </button>
              ) : null}
              {alwaysKeepAll ? (
                <>
                  <div className="review-action-menu-divider" role="separator" />
                  <button
                    type="button"
                    className="review-action-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setActionsOpen(false);
                      onKeepAll();
                    }}
                  >
                    <MenuCheckIcon className="review-action-menu-icon" />
                    <span className="review-action-menu-label">Keep all</span>
                  </button>
                  <button
                    type="button"
                    className={`review-action-menu-item is-danger ${confirmingUndoAll ? 'is-confirming' : ''}`}
                    role="menuitem"
                    title="Restore every workspace file to how it was before this turn. The current state is checkpointed first."
                    onClick={() => {
                      if (confirmingUndoAll) {
                        setActionsOpen(false);
                        onUndoAll();
                      } else {
                        setConfirmingUndoAll(true);
                      }
                    }}
                  >
                    <MenuUndoIcon className="review-action-menu-icon" />
                    <span className="review-action-menu-label">
                      {confirmingUndoAll ? 'Confirm undo all?' : 'Undo all'}
                    </span>
                  </button>
                  <div className="review-action-menu-divider" role="separator" />
                  <button
                    type="button"
                    className="review-action-menu-item"
                    role="menuitemcheckbox"
                    aria-checked={true}
                    title="Future edits are kept automatically. Click to turn off."
                    onClick={() => {
                      setActionsOpen(false);
                      onSetAlwaysKeepAll(false);
                    }}
                  >
                    <MenuRepeatIcon className="review-action-menu-icon" />
                    <span className="review-action-menu-label">Always keep all</span>
                    <MenuCheckIcon className="review-action-menu-state" />
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="review-files">
          {files.map((file) => {
            const undone = undonePaths.has(file.path);
            return (
              <div key={file.path} className={`review-file ${undone ? 'is-undone' : ''}`}>
                <button
                  type="button"
                  className="review-file-name"
                  title={file.path}
                  onClick={() => scrollToDiffCard(file.path)}
                >
                  <span className="review-file-base">{fileBase(file.path)}</span>
                  <span className="review-file-dir">{fileDir(file.path, workspace)}</span>
                </button>
                <span className="review-file-counts">
                  {file.adds > 0 ? <span className="diff-count-add">+{file.adds}</span> : null}
                  {file.dels > 0 ? <span className="diff-count-del">−{file.dels}</span> : null}
                </span>
                {undone ? (
                  <span className="work-chip chip-muted">undone</span>
                ) : (
                  <button
                    type="button"
                    className="review-file-undo"
                    onClick={() => onUndoFile(file.path)}
                  >
                    Undo
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// Scroll the thread to the file's diff card and flash it (mirrors the agent
// focus affordance). Best-effort: silently no-ops if the card is not mounted.
function scrollToDiffCard(path: string): void {
  const node = document.querySelector(`[data-diff-path="${CSS.escape(path)}"]`);
  if (!(node instanceof HTMLElement)) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.add('is-flash');
  window.setTimeout(() => node.classList.remove('is-flash'), 900);
}

function fileBase(path: string): string {
  const clean = path.replace(/\/+$/, '');
  return clean.split('/').pop() || clean;
}

function fileDir(path: string, workspace: string | null): string {
  const clean = path.replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  const dir = index > 0 ? clean.slice(0, index) : '';
  if (!dir || !workspace) return dir;
  const root = workspace.replace(/\/+$/, '');
  if (dir === root) return '';
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir;
}

function ReviewChevron({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m8.5 6 6 6-6 6" />
    </svg>
  );
}

function ReviewMenuDots(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

function MenuCheckIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function MenuUndoIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function MenuBookmarkIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function MenuTraceIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 19h4V5H4" />
      <path d="M8 8h5a3 3 0 0 1 3 3v0a3 3 0 0 0 3 3h1" />
      <path d="m18 11 3 3-3 3" />
    </svg>
  );
}

function MenuRepeatIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </svg>
  );
}
