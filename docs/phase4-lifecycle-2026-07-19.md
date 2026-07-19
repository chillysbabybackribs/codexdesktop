# Phase 4 — Persistence and browser/CDP lifecycle (2026-07-19, in progress)

Goal: make browser and chat restoration durable across close/reopen cycles while
ensuring native Chromium and CDP resources do not survive their owning tab.
No model, tool, or user-flow restrictions are part of this phase.

## Slice 1 — explicit CDP and native-tab teardown (landed)

- `CdpSession.dispose()` now detaches the debugger, rejects pending event
  waiters, stops transient diagnostics, and releases its event listeners.
- `disposeCdpSession()` removes a disposed session from the per-WebContents
  cache, so a future surface cannot inherit stale CDP state.
- Closing a browser tab disposes its CDP session before closing WebContents.
  Full `TabManager.dispose()` performs the same cleanup for every native view
  during a window close without creating fallback tabs.
- The main window persists its browser snapshot before that teardown, so a
  normal close still restores tabs while no hidden WebContentsView survives.

## Slice 2 — resilient chat resume (landed)

- A failed resume no longer clears the remembered thread pointer.
- The cached transcript stays visible, with a temporary warning row explaining
  the reconnect failure. The affected tab is marked for attention, not erased.
- Selecting an affected tab retries its server resume; success removes the
  warning and clears the retry marker. New, closed, and repurposed tabs clear
  the marker so it cannot cross conversation boundaries.
- Background tab resume failures use the same marker and recovery path.

## Verification

- Added lifecycle coverage that proves disposal detaches CDP, rejects a pending
  waiter, releases listeners, and refuses subsequent commands.
- `npm test`: 342 passing tests.
- `npm run typecheck`, `npm run build`, and `npm run verify:app`: clean.
- The isolated verification instance was closed after launch; its user-data
  directory and browser-control socket were removed.

## Remaining

- Add a focused close/reopen smoke that exercises persisted browser tabs while
  a CDP operation is active, then confirm the restored target owns a fresh CDP
  session.
