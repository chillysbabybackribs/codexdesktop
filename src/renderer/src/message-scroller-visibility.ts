export type MessageScrollerRect = {
  id: string;
  top: number;
  bottom: number;
};

export type MessageScrollerSnapshot = {
  currentAnchorId: string | null;
  visibleMessageIds: string[];
};

// Resolve the reader's current turn from a quiet reading line near the top of
// the viewport. Once a turn crosses that line it remains current until the next
// turn reaches it, even when the user is midway through a long answer.
export function resolveMessageScrollerSnapshot({
  anchors,
  messages,
  viewportTop,
  viewportBottom,
  readingLineOffset = 72,
}: {
  anchors: MessageScrollerRect[];
  messages: MessageScrollerRect[];
  viewportTop: number;
  viewportBottom: number;
  readingLineOffset?: number;
}): MessageScrollerSnapshot {
  const visibleMessageIds: string[] = [];
  const seenVisible = new Set<string>();

  for (const message of messages) {
    if (
      message.bottom > viewportTop &&
      message.top < viewportBottom &&
      !seenVisible.has(message.id)
    ) {
      seenVisible.add(message.id);
      visibleMessageIds.push(message.id);
    }
  }

  if (!anchors.length) {
    return { currentAnchorId: null, visibleMessageIds };
  }

  const readingLine = viewportTop + readingLineOffset;
  let currentAnchorId = anchors[0].id;
  for (const anchor of anchors) {
    if (anchor.top > readingLine) break;
    currentAnchorId = anchor.id;
  }

  return { currentAnchorId, visibleMessageIds };
}
