export type TurnAnchorDecision = {
  anchor: boolean
  skipNext: boolean
}

export type TurnCompletionScrollMode = 'follow-tail' | 'preserve-reader'

// Thread creation and turn creation are separate app-server notifications.
// Preserve the one-shot skip through the intermediate null turn so the first
// message in a new/restored thread never enters mid-thread top-anchor mode.
export function decideTurnAnchor(
  activeTurnId: string | null,
  previousTurnId: string | null,
  skipNext: boolean
): TurnAnchorDecision {
  if (activeTurnId === null || activeTurnId === previousTurnId) {
    return { anchor: false, skipNext }
  }

  if (skipNext) {
    return { anchor: false, skipNext: false }
  }

  return { anchor: true, skipNext: false }
}

// Completion may shrink the transcript viewport as post-turn controls (for
// example the file-review bar) enter the composer row. Automatic top-anchor
// mode is still app-owned, so it must settle to the completed tail. A reader
// who deliberately released both anchor and bottom-follow keeps control.
export function completionScrollMode(
  wasTopAnchored: boolean,
  wasPinnedToTail: boolean
): TurnCompletionScrollMode {
  return wasTopAnchored || wasPinnedToTail ? 'follow-tail' : 'preserve-reader'
}

export type ReaderScrollIntent = 'up' | 'down'

// Bare scroll events may re-pin at the live edge but never release a mode:
// they also fire for browser clamps and for the app's own scrollTop writes
// racing content growth, so only explicit reader input (wheel, keys, touch,
// selection drag) counts as a takeover. Re-pinning is the one transition that
// is safe under spurious events — they end at the edge anyway — and the
// up-hold latch keeps a reader who just scrolled up from being re-captured
// by their own wheel tick settling at the bottom.
export function shouldRepinOnScroll(
  upHold: boolean,
  anchored: boolean,
  distanceFromBottom: number
): boolean {
  return !upHold && !anchored && distanceFromBottom <= 48
}

export function wheelIntent(deltaY: number): ReaderScrollIntent | null {
  if (deltaY < 0) return 'up'
  if (deltaY > 0) return 'down'
  return null
}

export function keyScrollIntent(key: string, shiftKey: boolean): ReaderScrollIntent | null {
  switch (key) {
    case 'ArrowUp':
    case 'PageUp':
    case 'Home':
      return 'up'
    case 'ArrowDown':
    case 'PageDown':
    case 'End':
      return 'down'
    case ' ':
      return shiftKey ? 'up' : 'down'
    default:
      return null
  }
}

// Height for the trailing runway that lets the newest user message reach the
// viewport top before the answer has streamed in. Padded 2px past the exact
// shortfall: at an exact fit the anchored scrollTop sits at max scroll, where
// subpixel rounding makes the browser clamp-scroll on its own — events the
// reader never produced.
export function anchorSpacerHeight(
  clientHeight: number,
  contentBelow: number,
  topGap: number
): number {
  const shortfall = Math.ceil(clientHeight - contentBelow - topGap)
  return shortfall > 0 ? shortfall + 2 : 0
}
