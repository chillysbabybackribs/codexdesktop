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

## Verification

- Added lifecycle coverage that proves disposal detaches CDP, rejects a pending
  waiter, releases listeners, and refuses subsequent commands.
- `npm test`: 342 passing tests.
- `npm run typecheck`, `npm run build`, and `npm run verify:app`: clean.
- The isolated verification instance was closed after launch; its user-data
  directory and browser-control socket were removed.

## Remaining

- Harden resume failure semantics: retain the visible cached transcript and
  make a failed cold resume observable and retryable instead of silently
  clearing the remembered thread pointer.
- Add a focused close/reopen smoke that exercises persisted browser tabs while
  a CDP operation is active, then confirm the restored target owns a fresh CDP
  session.
