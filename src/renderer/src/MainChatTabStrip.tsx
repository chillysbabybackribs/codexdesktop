import { type PointerEvent, useEffect, useRef, useState } from 'react';
import type { Thread } from '../../shared/session-protocol';
import {
  findMainChatTabDropTarget,
  maxMainChatTabs,
  type MainChatTab,
} from './main-chat-tabs';
import { splitDropZoneAt, type SplitDropZone } from './chat-split';
import { ThreadMenu } from './ThreadMenu';

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
