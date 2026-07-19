import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Thread } from '../../shared/session-protocol';
import {
  findMainChatTabDropTarget,
  maxMainChatTabs,
  type MainChatTab,
} from './main-chat-tabs';
import { splitDropZoneAt, type SplitDropZone } from './chat-split';
import {
  groupThreadsForMenu,
  relativeThreadTime,
  stripSkillMarkerFromTitle,
  threadTitle,
} from './thread-menu-model';

export function MainChatTabStrip({
  tabs,
  activeKey,
  disabled,
  onSelect,
  onReorder,
  onPaneDragUpdate,
  onDropOnPane,
  canSplitForDrop,
  onSplitActivePane,
  canSplitActivePane,
  onClose,
  onNew,
  onOpenSettings,
  title,
  threads,
  activeThreadId,
  isThreadMenuOpen,
  threadsNextCursor,
  threadsLoading,
  threadsError,
  onToggleThreadMenu,
  onResumeThread,
  onLoadMoreThreads,
}: {
  tabs: MainChatTab[];
  activeKey: string;
  disabled: boolean;
  onSelect: (key: string) => Promise<boolean>;
  onReorder: (sourceKey: string, targetKey: string, placement: 'before' | 'after') => void;
  onPaneDragUpdate: (target: { tabKey: string; zone: SplitDropZone } | null) => void;
  onDropOnPane: (sourceKey: string, targetKey: string, zone: SplitDropZone) => void;
  canSplitForDrop: (targetKey: string, sourceKey: string) => boolean;
  onSplitActivePane: (direction: 'right' | 'down') => boolean;
  canSplitActivePane: boolean;
  onClose: (key: string) => Promise<void>;
  onNew: () => void;
  onOpenSettings: () => void;
  title: string;
  threads: Thread[];
  activeThreadId: string | null;
  isThreadMenuOpen: boolean;
  threadsNextCursor: string | null;
  threadsLoading: boolean;
  threadsError: string | null;
  onToggleThreadMenu: () => void;
  onResumeThread: (threadId: string) => Promise<void>;
  onLoadMoreThreads: () => Promise<void>;
}): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    sourceKey: string;
    startX: number;
    startY: number;
    pointerOffsetX: number;
    pointerOffsetY: number;
    sourceLeft: number;
    width: number;
    hasMoved: boolean;
    targetKey: string | null;
    placement: 'before' | 'after';
    paneTarget: { tabKey: string; zone: SplitDropZone } | null;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState<{
    sourceKey: string;
    targetKey: string | null;
    placement: 'before' | 'after';
    previewLeft: number;
    previewTop: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>(
      `[data-main-chat-tab="${activeKey}"]`,
    );
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeKey, tabs.length]);

  const moveFocus = async (
    fromKey: string,
    direction: -1 | 1 | 'first' | 'last',
  ): Promise<void> => {
    const index = tabs.findIndex((tab) => tab.key === fromKey);
    const nextIndex =
      direction === 'first'
        ? 0
        : direction === 'last'
          ? tabs.length - 1
          : (index + direction + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    if (!(await onSelect(next.key))) return;
    requestAnimationFrame(() => {
      stripRef.current
        ?.querySelector<HTMLButtonElement>(`[data-main-chat-tab="${next.key}"]`)
        ?.focus();
    });
  };

  const beginTabDrag = (event: PointerEvent<HTMLButtonElement>, sourceKey: string): void => {
    if (disabled || event.button !== 0) return;
    const tab = event.currentTarget.closest<HTMLElement>('[data-main-chat-tab-key]');
    const rect = tab?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      sourceKey,
      startX: event.clientX,
      startY: event.clientY,
      pointerOffsetX: event.clientX - rect.left,
      pointerOffsetY: event.clientY - rect.top,
      sourceLeft: rect.left,
      width: rect.width,
      hasMoved: false,
      targetKey: null,
      placement: 'before',
      paneTarget: null,
    };
  };

  const updateTabDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.hasMoved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6)
      return;
    drag.hasMoved = true;

    const tabStripBounds = stripRef.current?.getBoundingClientRect();
    const tabbarBounds = stripRef.current
      ?.closest('.main-chat-tabbar')
      ?.getBoundingClientRect();
    // Below the tab bar the drag stops being a reorder and becomes a pane
    // drop: the pane under the pointer plus the zone within it — edges tear
    // the chat out into a new split, the center shows it in that pane.
    const inStrip = tabbarBounds ? event.clientY <= tabbarBounds.bottom : true;
    let paneTarget: { tabKey: string; zone: SplitDropZone } | null = null;
    if (!inStrip) {
      for (const pane of Array.from(
        document.querySelectorAll<HTMLElement>('[data-split-pane-key]'),
      )) {
        const paneKey = pane.dataset.splitPaneKey;
        if (!paneKey) continue;
        const zone = splitDropZoneAt(
          event.clientX,
          event.clientY,
          pane.getBoundingClientRect(),
          canSplitForDrop(paneKey, drag.sourceKey),
        );
        if (!zone) continue;
        // Dropping a chat onto the pane already showing it is a no-op.
        if (!(zone === 'center' && paneKey === drag.sourceKey)) {
          paneTarget = { tabKey: paneKey, zone };
        }
        break;
      }
    }
    if (
      (drag.paneTarget?.tabKey ?? null) !== (paneTarget?.tabKey ?? null) ||
      (drag.paneTarget?.zone ?? null) !== (paneTarget?.zone ?? null)
    ) {
      drag.paneTarget = paneTarget;
      onPaneDragUpdate(paneTarget);
    }

    const minPreviewLeft = inStrip ? (tabStripBounds?.left ?? 0) : 0;
    const maxPreviewLeft = Math.max(
      minPreviewLeft,
      (inStrip ? (tabStripBounds?.right ?? window.innerWidth) : window.innerWidth) - drag.width,
    );
    const previewLeft = Math.min(
      Math.max(event.clientX - drag.pointerOffsetX, minPreviewLeft),
      maxPreviewLeft,
    );
    const previewTop = Math.min(
      Math.max(event.clientY - drag.pointerOffsetY, 0),
      window.innerHeight - 40,
    );
    const dropTarget = inStrip
      ? findMainChatTabDropTarget(
          drag.sourceKey,
          drag.sourceLeft,
          previewLeft,
          drag.width,
          Array.from(
            stripRef.current?.querySelectorAll<HTMLElement>('[data-main-chat-tab-key]') ?? [],
          ).flatMap((tab) => {
            const key = tab.dataset.mainChatTabKey;
            if (!key) return [];
            const rect = tab.getBoundingClientRect();
            return [{ key, left: rect.left, right: rect.right }];
          }),
        )
      : null;

    drag.targetKey = dropTarget?.key ?? null;
    drag.placement = dropTarget?.placement ?? 'before';
    setDragging({
      sourceKey: drag.sourceKey,
      targetKey: drag.targetKey,
      placement: drag.placement,
      previewLeft,
      previewTop,
      width: drag.width,
    });
  };

  const finishTabDrag = (event: PointerEvent<HTMLButtonElement>, shouldReorder: boolean): void => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (drag.hasMoved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (shouldReorder && drag.paneTarget) {
        onDropOnPane(drag.sourceKey, drag.paneTarget.tabKey, drag.paneTarget.zone);
      } else if (shouldReorder && drag.targetKey) {
        onReorder(drag.sourceKey, drag.targetKey, drag.placement);
      }
    }

    onPaneDragUpdate(null);
    dragStateRef.current = null;
    setDragging(null);
  };

  const draggingTab = dragging
    ? (tabs.find((tab) => tab.key === dragging.sourceKey) ?? null)
    : null;

  return (
    <header className="main-chat-tabbar">
      <div ref={stripRef} className="main-chat-tabs-scroll" role="tablist" aria-label="Open chats">
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          const isDragging = dragging?.sourceKey === tab.key;
          const isDropTarget = dragging?.targetKey === tab.key;
          return (
            <div
              key={tab.key}
              data-main-chat-tab-key={tab.key}
              className={`main-chat-tab ${active ? 'is-active' : ''} is-${tab.status} ${
                isDragging ? 'is-dragging' : ''
              } ${isDropTarget ? `is-drop-${dragging?.placement}` : ''}`}
            >
              <button
                type="button"
                role="tab"
                className="main-chat-tab-target"
                data-main-chat-tab={tab.key}
                id={`main-chat-tab-${tab.key}`}
                aria-selected={active}
                aria-controls={`main-chat-panel-${tab.key}`}
                tabIndex={active ? 0 : -1}
                disabled={disabled}
                title={tab.title}
                onClick={(event) => {
                  if (suppressClickRef.current) {
                    event.preventDefault();
                    suppressClickRef.current = false;
                    return;
                  }
                  void onSelect(tab.key);
                }}
                onPointerDown={(event) => beginTabDrag(event, tab.key)}
                onPointerMove={updateTabDrag}
                onPointerUp={(event) => finishTabDrag(event, true)}
                onPointerCancel={(event) => finishTabDrag(event, false)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    void moveFocus(tab.key, event.key === 'ArrowLeft' ? -1 : 1);
                  } else if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    void moveFocus(tab.key, event.key === 'Home' ? 'first' : 'last');
                  }
                }}
              >
                <MainChatGlyph />
                <span className="main-chat-tab-title">{tab.title}</span>
                {tab.status === 'working' ? (
                  <span className="main-chat-tab-spinner" aria-label="Running" />
                ) : tab.status === 'attention' ? (
                  <span className="main-chat-tab-attention" aria-label="Awaiting your attention" />
                ) : null}
              </button>
              <button
                type="button"
                className="main-chat-tab-close"
                aria-label={
                  tab.status === 'working' ? `${tab.title} is running` : `Close ${tab.title}`
                }
                title={
                  tab.status === 'working'
                    ? 'Stop this chat before closing it'
                    : 'Close chat (Ctrl+W)'
                }
                disabled={disabled || tab.status === 'working'}
                onClick={() => void onClose(tab.key)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          );
        })}
      </div>
      {dragging && draggingTab ? (
        <div
          className={`main-chat-tab-drag-preview ${draggingTab.key === activeKey ? 'is-active' : ''} is-${draggingTab.status}`}
          style={{ left: dragging.previewLeft, top: dragging.previewTop, width: dragging.width }}
          aria-hidden="true"
        >
          <MainChatGlyph />
          <span className="main-chat-tab-title">{draggingTab.title}</span>
          {draggingTab.status === 'working' ? (
            <span className="main-chat-tab-spinner" />
          ) : draggingTab.status === 'attention' ? (
            <span className="main-chat-tab-attention" />
          ) : null}
          <span className="main-chat-tab-drag-preview-close">×</span>
        </div>
      ) : null}
      <button
        type="button"
        className="main-chat-tab-action main-chat-tab-new"
        aria-label={tabs.length >= maxMainChatTabs ? 'Chat tab limit reached' : 'New chat tab'}
        title={
          tabs.length >= maxMainChatTabs
            ? `Up to ${maxMainChatTabs} chats can stay open`
            : 'New chat tab (Ctrl+T)'
        }
        disabled={disabled || tabs.length >= maxMainChatTabs}
        onClick={onNew}
      >
        <span aria-hidden="true">+</span>
      </button>
      <div className="main-chat-tabbar-spacer" />
      <button
        type="button"
        className="main-chat-tab-action"
        aria-label="Split right — open a new chat beside this one"
        title="Split right — new chat beside this one (Ctrl+\)"
        disabled={disabled || !canSplitActivePane}
        onClick={() => onSplitActivePane('right')}
      >
        <SplitRightIcon />
      </button>
      <button
        type="button"
        className="main-chat-tab-action"
        aria-label="Split down — open a new chat below this one"
        title="Split down — new chat below this one (Ctrl+Shift+\)"
        disabled={disabled || !canSplitActivePane}
        onClick={() => onSplitActivePane('down')}
      >
        <SplitDownIcon />
      </button>
      <ThreadMenu
        placement="tabbar"
        title={title}
        threads={threads}
        activeThreadId={activeThreadId}
        isOpen={isThreadMenuOpen}
        threadsNextCursor={threadsNextCursor}
        threadsLoading={threadsLoading}
        threadsError={threadsError}
        onToggle={onToggleThreadMenu}
        onResumeThread={onResumeThread}
        onLoadMoreThreads={onLoadMoreThreads}
      />
      <button
        type="button"
        className="main-chat-tab-action"
        aria-label="Open settings"
        title="Settings"
        onClick={onOpenSettings}
      >
        <SettingsIcon />
      </button>
    </header>
  );
}

function MainChatGlyph(): React.JSX.Element {
  return (
    <svg className="main-chat-tab-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4.75A1.75 1.75 0 0 1 5.75 3h4.5A1.75 1.75 0 0 1 12 4.75v3.5A1.75 1.75 0 0 1 10.25 10H7l-2.4 2v-2.15A1.75 1.75 0 0 1 4 8.5V4.75Z" />
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

function SplitRightIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" />
      <path d="M9.5 3.5v9" stroke="currentColor" />
      <path d="M11.5 8h-2M11 6.9 12.1 8 11 9.1" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" opacity="0.75" />
    </svg>
  );
}

function SplitDownIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke="currentColor" />
      <path d="M2.5 9h11" stroke="currentColor" />
      <path d="M8 11.5v-2M6.9 11 8 12.1 9.1 11" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" opacity="0.75" />
    </svg>
  );
}

// The thread selector opens a searchable recent-thread popover. The tab-bar
// trigger opens below the header; the legacy toolbar/composer placements retain
// their respective centered and upward menu geometry.
function ThreadMenu({
  placement = 'toolbar',
  title,
  threads,
  activeThreadId,
  isOpen,
  threadsNextCursor,
  threadsLoading,
  threadsError,
  onToggle,
  onResumeThread,
  onLoadMoreThreads,
}: {
  placement?: 'toolbar' | 'composer' | 'tabbar';
  title: string;
  threads: Thread[];
  activeThreadId: string | null;
  isOpen: boolean;
  threadsNextCursor: string | null;
  threadsLoading: boolean;
  threadsError: string | null;
  onToggle: () => void;
  onResumeThread: (threadId: string) => Promise<void>;
  onLoadMoreThreads: () => Promise<void>;
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  // Highlighted row for keyboard/hover navigation. `null` is the resting state;
  // `0..n` indexes the flat, filtered thread list.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Filter by title/preview, then bucket into recency groups. `nowSeconds` is
  // sampled once per open so relative labels ("2h", "Yesterday") stay stable.
  const { groups, flatIds } = useMemo(() => groupThreadsForMenu(threads, query), [threads, query]);

  // Reset transient state whenever the menu opens; focus the search field so the
  // user can immediately type to filter (Cursor-style).
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setQuery('');
    setActiveIndex(null);
    const id = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        onToggle();
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
    };
  }, [isOpen, onToggle]);

  const resume = (threadId: string): void => {
    onToggle();
    void onResumeThread(threadId);
  };

  const handleKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onToggle();
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
    if (event.key === 'Enter') {
      // With nothing highlighted, let Enter fall through (no-op here).
      if (activeIndex === null) {
        return;
      }
      event.preventDefault();
      if (flatIds[activeIndex]) {
        resume(flatIds[activeIndex]);
      }
    }
  };

  return (
    <div ref={wrapRef} className={`thread-select-wrap is-${placement}`}>
      <button
        type="button"
        className={`thread-select ${isOpen ? 'is-open' : ''}`}
        aria-label={
          placement === 'tabbar'
            ? 'Open conversation history'
            : placement === 'composer'
              ? 'Chat history'
              : 'Open thread menu'
        }
        title={
          placement === 'tabbar'
            ? 'Conversation history'
            : placement === 'composer'
              ? 'Chat history'
              : undefined
        }
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        {placement === 'tabbar' ? (
          <VerticalDotsIcon />
        ) : placement === 'composer' ? (
          <ChatBubbleIcon />
        ) : (
          <span className="thread-title">{stripSkillMarkerFromTitle(title)}</span>
        )}
        <span className="chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path
              d="m6 9 6 6 6-6"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {isOpen ? (
        <div className="thread-menu" role="menu" onKeyDown={handleKeyDown}>
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

function SearchIcon(): React.JSX.Element {
  return (
    <svg
      className="thread-menu-search-icon"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ChatBubbleIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v8A1.5 1.5 0 0 1 18.5 15H9l-4 3.5V15H5.5A1.5 1.5 0 0 1 4 13.5v-8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SettingsIcon(): React.JSX.Element {
  return (
    <svg
      className="icon-settings"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
