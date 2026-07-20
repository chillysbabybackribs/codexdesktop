import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

// Keeps the transcript pinned to the bottom as content streams in, but yields to
// the user the moment they scroll up to read back — re-pinning only when they
// return to the bottom themselves.
export function ThreadScroll({
  children,
  dependencies,
  scrollKey,
  resetKey,
  activeTurnId,
  id,
  labelledBy,
  onReachStart,
}: {
  children: React.ReactNode;
  dependencies: unknown[];
  scrollKey: string;
  resetKey: string | null;
  activeTurnId: string | null;
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
  }, [cancelScheduledFollow, onReachStart, rememberScrollPosition]);

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
    } else if (activeTurnId === null && anchorTurnRef.current !== null) {
      // The turn finished. Stop actively re-anchoring, but FREEZE the current
      // scroll position so the message/answer don't snap back down. Removing the
      // spacer entirely would shrink scrollHeight below the current scrollTop and
      // the browser would clamp it (the snap). Instead, size the spacer to the
      // exact minimum that preserves scrollTop — 0 if the answer already fills
      // the viewport, otherwise just enough to hold position (no excess).
      anchorTurnRef.current = null;
      const el = ref.current;
      const spacer = spacerRef.current;
      if (el && spacer) {
        const priorSpacer = spacer.offsetHeight;
        const contentWithoutSpacer = el.scrollHeight - priorSpacer;
        const needed = Math.max(0, el.scrollTop + el.clientHeight - contentWithoutSpacer);
        if (needed <= 0) {
          setSpacerOn(false);
        } else {
          spacer.style.height = `${needed}px`;
        }
      } else {
        setSpacerOn(false);
      }
      // The reader is no longer following the live edge; leave bottom-follow off
      // until they scroll back down themselves.
      pinnedRef.current = false;
    }
    prevTurnRef.current = activeTurnId;
    justResetRef.current = false;
  }, [activeTurnId, anchorTop, cancelScheduledFollow]);

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
    resizeObserver.observe(el);
    resizeObserver.observe(content);

    // Web fonts can reflow existing markdown after the initial commit without
    // producing a React update. Catch that one late layout pass when supported.
    void document.fonts?.ready.then(() => {
      if (active) {
        followTail();
      }
    });

    return () => {
      active = false;
      resizeObserver.disconnect();
      cancelScheduledFollow();
    };
  }, [cancelScheduledFollow, followTail]);

  return (
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
  );
}
