import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Thread } from '../../shared/session-protocol';
import {
  groupThreadsForMenu,
  headerMenuCommands,
  relativeThreadTime,
  stripSkillMarkerFromTitle,
  threadTitle,
  type HeaderMenuCommandId,
} from './thread-menu-model';

type MenuView = 'options' | 'history';

export function ThreadMenu({
  placement = 'toolbar',
  title,
  threads,
  activeThreadId,
  threadsNextCursor,
  threadsLoading,
  threadsError,
  disabled = false,
  isBrowserMiddle = false,
  canSplitActivePane = false,
  canOpenTrace = false,
  showGlobalActions = true,
  onToggleBrowserMiddle,
  onSplitActivePane,
  onOpenTrace,
  onOpenSettings,
  onResumeThread,
  onLoadMoreThreads,
}: {
  placement?: 'toolbar' | 'composer' | 'tabbar';
  title: string;
  threads: Thread[];
  activeThreadId: string | null;
  threadsNextCursor: string | null;
  threadsLoading: boolean;
  threadsError: string | null;
  disabled?: boolean;
  isBrowserMiddle?: boolean;
  canSplitActivePane?: boolean;
  canOpenTrace?: boolean;
  showGlobalActions?: boolean;
  onToggleBrowserMiddle?: () => void;
  onSplitActivePane?: (direction: 'right' | 'down') => boolean;
  onOpenTrace?: () => void;
  onOpenSettings?: () => void;
  onResumeThread: (threadId: string) => Promise<void>;
  onLoadMoreThreads: () => Promise<void>;
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<MenuView>(placement === 'tabbar' ? 'options' : 'history');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const { groups, flatIds } = useMemo(() => groupThreadsForMenu(threads, query), [threads, query]);
  const commands = useMemo(
    () =>
      headerMenuCommands({
        isBrowserMiddle,
        canSplitActivePane,
        canOpenTrace,
        disabled,
        showGlobalActions,
      }),
    [isBrowserMiddle, canSplitActivePane, canOpenTrace, disabled, showGlobalActions],
  );
  const allCommandsDisabled = commands.every((command) => command.disabled);

  const close = (restoreFocus = false): void => {
    setIsOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const open = (): void => {
    setView(placement === 'tabbar' ? 'options' : 'history');
    setQuery('');
    setActiveIndex(null);
    setIsOpen(true);
  };

  useEffect(() => {
    if (!isOpen) return;
    const id = window.requestAnimationFrame(() => {
      if (view === 'history') searchRef.current?.focus();
      else {
        wrapRef.current
          ?.querySelector<HTMLButtonElement>('.header-options-item:not(:disabled)')
          ?.focus();
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [isOpen, view]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) close();
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [isOpen]);

  const resume = (threadId: string): void => {
    close();
    void onResumeThread(threadId);
  };

  const runCommand = (id: HeaderMenuCommandId): void => {
    if (id === 'history') {
      setView('history');
      return;
    }
    close();
    if (id === 'trace') onOpenTrace?.();
    else if (id === 'browser-layout') onToggleBrowserMiddle?.();
    else if (id === 'split-right') onSplitActivePane?.('right');
    else if (id === 'split-down') onSplitActivePane?.('down');
    else if (id === 'settings') onOpenSettings?.();
  };

  const handleOptionsKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(
      wrapRef.current?.querySelectorAll<HTMLButtonElement>('.header-options-item:not(:disabled)') ?? [],
    );
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    items[(current + direction + items.length) % items.length]?.focus();
  };

  const handleHistoryKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (placement === 'tabbar') setView('options');
      else close(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => {
        if (!flatIds.length) return null;
        return index === null ? 0 : Math.min(index + 1, flatIds.length - 1);
      });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => {
        if (!flatIds.length) return null;
        return index === null ? flatIds.length - 1 : Math.max(index - 1, 0);
      });
      return;
    }
    if (event.key === 'Enter' && activeIndex !== null) {
      event.preventDefault();
      if (flatIds[activeIndex]) resume(flatIds[activeIndex]);
    }
  };

  return (
    <div ref={wrapRef} className={`thread-select-wrap is-${placement}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`thread-select ${isOpen ? 'is-open' : ''}`}
        aria-label={placement === 'tabbar' ? 'Open chat and layout options' : 'Open chat history'}
        title={placement === 'tabbar' ? 'Chat and layout options' : 'Chat history'}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={allCommandsDisabled}
        onClick={() => (isOpen ? close() : open())}
      >
        {placement === 'tabbar' ? (
          <VerticalDotsIcon />
        ) : placement === 'composer' ? (
          <ChatBubbleIcon />
        ) : (
          <span className="thread-title">{stripSkillMarkerFromTitle(title)}</span>
        )}
        <span className="chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>

      {isOpen && view === 'options' ? (
        <div className="thread-menu header-options-menu" role="menu" onKeyDown={handleOptionsKeyDown}>
          <div className="header-options-heading">Chat workspace</div>
          <div className="header-options-list">
            {commands.map((command) => (
              <button
                type="button"
                role="menuitem"
                key={command.id}
                className={`header-options-item ${command.id === 'history' ? 'starts-global-section' : ''}`}
                disabled={command.disabled}
                onClick={() => runCommand(command.id)}
              >
                <span className="header-options-icon" aria-hidden="true">
                  <CommandIcon id={command.id} />
                </span>
                <span className="header-options-copy">
                  <span className="header-options-label">{command.label}</span>
                  {command.hint ? <span className="header-options-hint">{command.hint}</span> : null}
                </span>
                {command.id === 'history' ? (
                  <span className="header-options-disclosure" aria-hidden="true">
                    <ChevronRightIcon />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {isOpen && view === 'history' ? (
        <div className="thread-menu is-history-view" role="menu" onKeyDown={handleHistoryKeyDown}>
          {placement === 'tabbar' ? (
            <div className="thread-menu-view-header">
              <button
                type="button"
                className="thread-menu-back"
                aria-label="Back to chat and layout options"
                onClick={() => setView('options')}
              >
                <ChevronLeftIcon />
              </button>
              <span>Chat history</span>
            </div>
          ) : null}
          <div className="thread-menu-search">
            <SearchIcon />
            <input
              ref={searchRef}
              type="text"
              className="thread-menu-search-input"
              placeholder="Search chats…"
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(null);
              }}
            />
          </div>

          <div className="thread-menu-scroll">
            {flatIds.length ? (
              groups.map((group) => (
                <div className="thread-menu-group" key={group.label}>
                  <div className="thread-menu-label">{group.label}</div>
                  {group.threads.map((thread) => {
                    const index = flatIds.indexOf(thread.id);
                    return (
                      <button
                        type="button"
                        key={thread.id}
                        role="menuitem"
                        className={`thread-menu-item ${
                          thread.id === activeThreadId ? 'is-active' : ''
                        } ${index === activeIndex ? 'is-highlighted' : ''}`}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => resume(thread.id)}
                      >
                        <span className="thread-menu-item-icon" aria-hidden="true">
                          <ChatBubbleIcon />
                        </span>
                        <span className="thread-menu-item-title">{threadTitle(thread)}</span>
                        <time className="thread-menu-item-time">
                          {relativeThreadTime(thread.recencyAt ?? thread.updatedAt)}
                        </time>
                      </button>
                    );
                  })}
                </div>
              ))
            ) : (
              <div className="thread-menu-empty">
                {query
                  ? `No chats matching “${query.trim()}”`
                  : threadsError
                    ? `Could not load chats: ${threadsError}`
                    : 'No chats yet'}
              </div>
            )}

            {threadsError && flatIds.length ? (
              <div className="thread-menu-status thread-menu-status-error">{threadsError}</div>
            ) : null}

            {threadsNextCursor && !query ? (
              <button
                type="button"
                className="thread-menu-load-more"
                disabled={threadsLoading}
                onClick={() => void onLoadMoreThreads()}
              >
                {threadsLoading ? 'Loading…' : 'Load more chats'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CommandIcon({ id }: { id: HeaderMenuCommandId }): React.JSX.Element {
  if (id === 'trace') return <TraceIcon />;
  if (id === 'browser-layout') return <BrowserMiddleIcon />;
  if (id === 'split-right') return <SplitRightIcon />;
  if (id === 'split-down') return <SplitDownIcon />;
  if (id === 'history') return <ChatBubbleIcon />;
  return <SettingsIcon />;
}

function TraceIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.5 2.5h5.75L13 5.25v8.25H4.5v-11Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      <path
        d="M10 2.75V5.5h2.75M6.5 7.5h4M6.5 9.5h4M6.5 11.5h2"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}

function VerticalDotsIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="5" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="19" r="1.5" fill="currentColor" />
    </svg>
  );
}

function BrowserMiddleIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="3" height="11" rx="0.75" stroke="currentColor" />
      <rect x="6.5" y="2.5" width="3" height="11" rx="0.75" stroke="currentColor" />
      <rect x="11.5" y="2.5" width="3" height="11" rx="0.75" stroke="currentColor" />
      <path d="M7.5 4.5h1M7.5 6.5h1" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function SplitRightIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" />
      <path d="M9.5 3.5v9" stroke="currentColor" />
    </svg>
  );
}

function SplitDownIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" />
      <path d="M2.5 9h11" stroke="currentColor" />
    </svg>
  );
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.25" stroke="currentColor" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.58 3.58l1.06 1.06M11.36 11.36l1.06 1.06M3.58 12.42l1.06-1.06M11.36 4.64l1.06-1.06" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg className="thread-menu-search-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ChatBubbleIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v8A1.5 1.5 0 0 1 18.5 15H9l-4 3.5V15H5.5A1.5 1.5 0 0 1 4 13.5v-8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronLeftIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
