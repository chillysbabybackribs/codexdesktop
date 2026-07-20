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
