import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createContext } from 'react';
import { resolveMessageScrollerSnapshot } from './message-scroller-visibility';
import { completionScrollMode } from './thread-scroll-state';

export type MessageScrollerAnchor = {
  id: string;
  label: string;
};

type MessageScrollerVisibility = {
  currentAnchorId: string | null;
  visibleMessageIds: string[];
  jumpToMessage: (id: string) => void;
};

const MessageScrollerVisibilityContext = createContext<MessageScrollerVisibility>({
  currentAnchorId: null,
  visibleMessageIds: [],
  jumpToMessage: () => undefined,
});

export function useMessageScrollerVisibility(): MessageScrollerVisibility {
  return useContext(MessageScrollerVisibilityContext);
}

function ReaderPositionMenu({
  anchors,
}: {
  anchors: MessageScrollerAnchor[];
}): React.JSX.Element | null {
  const { currentAnchorId, visibleMessageIds, jumpToMessage } = useMessageScrollerVisibility();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const visible = useMemo(() => new Set(visibleMessageIds), [visibleMessageIds]);
  const currentIndex = Math.max(
    0,
    anchors.findIndex((anchor) => anchor.id === currentAnchorId),
  );
  const current = anchors[currentIndex];

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (anchors.length < 2 || !current) return null;

  return (
    <div ref={menuRef} className={`reader-position ${open ? 'is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="reader-position-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Conversation position: turn ${currentIndex + 1} of ${anchors.length}. Open jump menu.`}
        title={current.label}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="reader-position-rail" aria-hidden="true">
          <span
            className="reader-position-rail-fill"
            style={
              {
                '--reader-progress': `${(currentIndex / (anchors.length - 1)) * 100}%`,
              } as React.CSSProperties
            }
          />
        </span>
        <span className="reader-position-count">
          {currentIndex + 1}
          <span aria-hidden="true"> / </span>
          {anchors.length}
        </span>
        <svg className="reader-position-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4.75 6.25 3.25 3 3.25-3" />
        </svg>
      </button>

      {open ? (
        <div
          className="reader-position-menu"
          role="dialog"
          aria-label="Jump to a conversation turn"
        >
          <div className="reader-position-menu-head">
            <div>
              <span className="reader-position-eyebrow">Conversation</span>
              <strong>Jump to a turn</strong>
            </div>
            <span className="reader-position-menu-count">{anchors.length} turns</span>
          </div>
          <div className="reader-position-menu-list">
            {anchors.map((anchor, index) => {
              const isCurrent = anchor.id === currentAnchorId;
              const isVisible = visible.has(anchor.id);
              return (
                <button
                  key={anchor.id}
                  type="button"
                  className={`reader-position-item ${isCurrent ? 'is-current' : ''} ${isVisible ? 'is-visible' : ''}`}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => {
                    jumpToMessage(anchor.id);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <span className="reader-position-item-index">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="reader-position-item-label">{anchor.label}</span>
                  <span className="reader-position-item-dot" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Keeps the transcript pinned to the bottom as content streams in, but yields to
// the user the moment they scroll up to read back — re-pinning only when they
// return to the bottom themselves.
export function ThreadScroll({
  children,
  dependencies,
  scrollKey,
  resetKey,
  activeTurnId,
  messageAnchors,
  id,
  labelledBy,
  onReachStart,
}: {
  children: React.ReactNode;
  dependencies: unknown[];
  scrollKey: string;
  resetKey: string | null;
  activeTurnId: string | null;
  messageAnchors: MessageScrollerAnchor[];
  id: string;
  labelledBy: string;
  onReachStart?: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const settleFrameRef = useRef<number | null>(null);
  // The rAF scheduled on a live send to run anchorTop once the new user row has
  // committed. Tracked so the reset effect and unmount cleanup can cancel it
  // (like frameRef/settleFrameRef) — otherwise it can fire against a torn-down
  // or reset component.
  const anchorFrameRef = useRef<number | null>(null);
  // While non-null, this turn's user message is anchored to the top of the
  // viewport (the answer streams into the space below). This mode overrides
  // bottom-follow and releases the moment the reader scrolls.
  const anchorTurnRef = useRef<string | null>(null);
  const prevTurnRef = useRef<string | null>(null);
  // A fresh/restored thread may arrive with activeTurnId already set for an
  // in-progress turn; that must NOT yank it to the top — only a live send does.
  const justResetRef = useRef(false);
  // Programmatic scrollTop writes fire onScroll; without this guard the first
  // anchor write would immediately release the anchor (bottom-pin doesn't need
  // it because it re-pins to the same value).
  const suppressScrollRef = useRef(false);
  const scrollKeyRef = useRef(scrollKey);
  const scrollPositionsRef = useRef(new Map<string, { top: number; pinned: boolean }>());
  const [spacerOn, setSpacerOn] = useState(false);
  const [visibility, setVisibility] = useState<
    Pick<MessageScrollerVisibility, 'currentAnchorId' | 'visibleMessageIds'>
  >({
    currentAnchorId: null,
    visibleMessageIds: [],
  });

  const syncVisibility = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const viewport = el.getBoundingClientRect();
    const readRects = (selector: string, attribute: string) =>
      Array.from(el.querySelectorAll<HTMLElement>(selector)).flatMap((node) => {
        const id = node.dataset[attribute];
        if (!id) return [];
        const rect = node.getBoundingClientRect();
        return [{ id, top: rect.top, bottom: rect.bottom }];
      });
    const next = resolveMessageScrollerSnapshot({
      anchors: readRects('[data-message-anchor-id]', 'messageAnchorId'),
      messages: readRects('[data-message-id]', 'messageId'),
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
    });
    setVisibility((current) =>
      current.currentAnchorId === next.currentAnchorId &&
      current.visibleMessageIds.length === next.visibleMessageIds.length &&
      current.visibleMessageIds.every((id, index) => id === next.visibleMessageIds[index])
        ? current
        : next,
    );
  }, []);

  const rememberScrollPosition = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    scrollPositionsRef.current.set(scrollKeyRef.current, {
      top: el.scrollTop,
      pinned: pinnedRef.current,
    });
  }, []);

  const cancelScheduledFollow = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (settleFrameRef.current !== null) {
      window.cancelAnimationFrame(settleFrameRef.current);
      settleFrameRef.current = null;
    }
    if (anchorFrameRef.current !== null) {
      window.cancelAnimationFrame(anchorFrameRef.current);
      anchorFrameRef.current = null;
    }
  }, []);

  // Scroll the anchored turn's user message to the top of the viewport, sizing
  // a trailing spacer so there is always room to scroll it that far even before
  // the answer fills in.
  const anchorTop = useCallback(() => {
    const el = ref.current;
    const turnId = anchorTurnRef.current;
    if (!el || !turnId) return;

    const node = el.querySelector<HTMLElement>(
      `.message-user[data-turn-id="${CSS.escape(turnId)}"]`,
    );
    if (!node) return;

    // Small breathing room so the message sits just below the viewport top
    // rather than flush against (or clipped above) the edge.
    const topGap = 12;

    // Size the trailing spacer to the exact shortfall of room below the user
    // message, so it can reach the top without leaving more than one viewport
    // of slack. Measured from the DOM, immune to offsetParent/padding quirks.
    const spacer = spacerRef.current;
    if (spacer) {
      const priorSpacer = spacer.offsetHeight;
      const elRect = el.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const nodeTopWithin = nodeRect.top - elRect.top + el.scrollTop;
      const contentBelow = el.scrollHeight - priorSpacer - nodeTopWithin;
      const needed = Math.max(0, el.clientHeight - contentBelow - topGap);
      const nextHeight = `${needed}px`;
      if (spacer.style.height !== nextHeight) spacer.style.height = nextHeight;
    }

    // Scroll by the measured delta between the message top and the viewport top
    // (minus the gap), rather than computing an absolute offsetTop target.
    const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - topGap;
    if (Math.abs(delta) > 1) {
      suppressScrollRef.current = true;
      el.scrollTop += delta;
      rememberScrollPosition();
    }
  }, [rememberScrollPosition]);

  const followTail = useCallback(() => {
    // Top-anchor mode owns the scroll position while active.
    if (anchorTurnRef.current !== null) {
      anchorTop();
      return;
    }
    if (!pinnedRef.current || ref.current === null || frameRef.current !== null) {
      return;
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const el = ref.current;

      if (!el || !pinnedRef.current) {
        return;
      }

      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      if (Math.abs(el.scrollTop - target) > 1) {
        suppressScrollRef.current = true;
        el.scrollTop = target;
      }
      rememberScrollPosition();

      // Markdown code blocks, font metrics, and live diff rows can settle one
      // layout pass after React commits. A second frame catches that growth
      // without making every stream delta pay for a synchronous measurement.
      if (settleFrameRef.current === null) {
        settleFrameRef.current = window.requestAnimationFrame(() => {
          settleFrameRef.current = null;
          const settled = ref.current;
          if (settled && pinnedRef.current) {
            const settledTarget = Math.max(0, settled.scrollHeight - settled.clientHeight);
            if (Math.abs(settled.scrollTop - settledTarget) > 1) {
              suppressScrollRef.current = true;
              settled.scrollTop = settledTarget;
            }
            rememberScrollPosition();
          }
        });
      }
    });
  }, [anchorTop, rememberScrollPosition]);

  const handleScroll = useCallback(() => {
    // Ignore the scroll events our own programmatic writes produce.
    if (suppressScrollRef.current) {
      suppressScrollRef.current = false;
      syncVisibility();
      return;
    }

    const el = ref.current;
    if (!el) {
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom <= 48;
    rememberScrollPosition();

    // A deliberate scroll releases the top-anchor, exactly like it releases
    // bottom-follow — the reader is now driving.
    if (anchorTurnRef.current !== null) {
      anchorTurnRef.current = null;
      setSpacerOn(false);
    }

    // A queued frame from a prior delta must never pull a reader back down
    // after they have deliberately scrolled away from the live edge.
    if (!pinnedRef.current) {
      cancelScheduledFollow();
    }
    if (el.scrollTop <= 96) onReachStart?.();
    syncVisibility();
  }, [cancelScheduledFollow, onReachStart, rememberScrollPosition, syncVisibility]);

  const jumpToMessage = useCallback(
    (messageId: string) => {
      const el = ref.current;
      if (!el) return;
      const node = el.querySelector<HTMLElement>(
        `[data-message-anchor-id="${CSS.escape(messageId)}"]`,
      );
      if (!node) return;

      anchorTurnRef.current = null;
      pinnedRef.current = false;
      cancelScheduledFollow();
      if (messageId !== activeTurnId) setSpacerOn(false);
      const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
      el.scrollBy({
        top: delta,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    },
    [activeTurnId, cancelScheduledFollow],
  );

  const visibilityValue = useMemo<MessageScrollerVisibility>(
    () => ({ ...visibility, jumpToMessage }),
    [jumpToMessage, visibility],
  );

  useLayoutEffect(() => {
    // A tab has its own reading context. Restore its last known position when
    // returning to it; a never-seen tab still begins at its latest content.
    cancelScheduledFollow();
    anchorTurnRef.current = null;
    prevTurnRef.current = null;
    justResetRef.current = true;
    setSpacerOn(false);
    scrollKeyRef.current = scrollKey;
    const saved = scrollPositionsRef.current.get(scrollKey);
    pinnedRef.current = saved?.pinned ?? true;
    if (!saved) {
      followTail();
      return;
    }
    const restore = (): void => {
      const el = ref.current;
      if (!el || scrollKeyRef.current !== scrollKey) return;
      const maximum = Math.max(0, el.scrollHeight - el.clientHeight);
      suppressScrollRef.current = true;
      el.scrollTop = Math.min(saved.top, maximum);
      rememberScrollPosition();
    };
    const frame = window.requestAnimationFrame(restore);
    return () => window.cancelAnimationFrame(frame);
  }, [cancelScheduledFollow, followTail, rememberScrollPosition, resetKey, scrollKey]);

  useLayoutEffect(() => {
    followTail();
    syncVisibility();
    // The caller supplies render-driving state rather than a single scalar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  // A live send (activeTurnId transitions to a new non-null value) anchors that
  // turn's user message to the top. Skip the transition that coincides with a
  // thread switch/restore — that turn is being read, not just asked.
  useLayoutEffect(() => {
    if (activeTurnId !== null && activeTurnId !== prevTurnRef.current && !justResetRef.current) {
      anchorTurnRef.current = activeTurnId;
      pinnedRef.current = false;
      cancelScheduledFollow();
      setSpacerOn(true);
      // The new user row + spacer land next commit; anchor once they exist.
      // Tracked so reset/unmount can cancel it before it fires.
      anchorFrameRef.current = window.requestAnimationFrame(() => {
        anchorFrameRef.current = null;
        anchorTop();
      });
    } else if (activeTurnId === null && prevTurnRef.current !== null) {
      const wasTopAnchored = anchorTurnRef.current !== null;
      const mode = completionScrollMode(wasTopAnchored, pinnedRef.current);
      anchorTurnRef.current = null;

      if (mode === 'follow-tail') {
        // Completion can add controls below the transcript in the same commit
        // (notably the file-review bar), shrinking clientHeight after the last
        // streamed token. Remove the response runway and re-pin through the
        // existing two-frame + ResizeObserver settling path so the complete
        // answer always clears the composer stack.
        cancelScheduledFollow();
        if (spacerRef.current) spacerRef.current.style.height = '0px';
        setSpacerOn(false);
        pinnedRef.current = true;
        followTail();
      } else {
        // Manual scrolling releases both top-anchor and tail-follow before the
        // turn completes. Never pull that reader away from the place they chose.
        setSpacerOn(false);
      }
    }
    prevTurnRef.current = activeTurnId;
    justResetRef.current = false;
  }, [activeTurnId, anchorTop, cancelScheduledFollow, followTail]);

  useEffect(() => {
    const el = ref.current;
    const content = contentRef.current;

    if (!el || !content) {
      return;
    }

    let active = true;
    // The `dependencies` layout effect already calls followTail on every React
    // commit (i.e. every batched streaming flush), which covers text growth.
    // The ResizeObserver catches the reflows React does NOT drive — code-block
    // wrapping, diff rows, and font metrics settling a frame after commit. A
    // subtree characterData MutationObserver would fire on every streamed
    // character for no gain over these two, so it is intentionally omitted.
    const resizeObserver = new ResizeObserver(followTail);
    const visibilityObserver = new ResizeObserver(syncVisibility);
    resizeObserver.observe(el);
    resizeObserver.observe(content);
    visibilityObserver.observe(el);
    visibilityObserver.observe(content);

    // Web fonts can reflow existing markdown after the initial commit without
    // producing a React update. Catch that one late layout pass when supported.
    void document.fonts?.ready.then(() => {
      if (active) {
        followTail();
        syncVisibility();
      }
    });

    return () => {
      active = false;
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      cancelScheduledFollow();
    };
  }, [cancelScheduledFollow, followTail, syncVisibility]);

  return (
    <MessageScrollerVisibilityContext.Provider value={visibilityValue}>
      <div className="thread-scroll-shell">
        <div
          ref={ref}
          id={id}
          role="tabpanel"
          aria-labelledby={labelledBy}
          className="thread-scroll"
          onScroll={handleScroll}
        >
          <div ref={contentRef} className="thread-scroll-content">
            {children}
            {spacerOn ? (
              <div ref={spacerRef} className="thread-scroll-anchor-spacer" aria-hidden="true" />
            ) : null}
          </div>
        </div>
        <ReaderPositionMenu anchors={messageAnchors} />
      </div>
    </MessageScrollerVisibilityContext.Provider>
  );
}
