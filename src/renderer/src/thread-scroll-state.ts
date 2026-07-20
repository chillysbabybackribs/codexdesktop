export type TurnAnchorDecision = {
  anchor: boolean
  skipNext: boolean
}

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
