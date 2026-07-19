# Phase 5 — Crash, integration, and maintainability (2026-07-19, in progress)

Goal: remove runtime paths that can fail silently, then prove the critical
chat/browser lifecycle seams with focused integration coverage. Development
behavior remains unrestricted; this phase adds recovery and observability, not
model, tool, or user-flow gates.

## Increment 1 — JSON-RPC transport resynchronization (landed)

`AppServerRpc` previously kept any object-shaped malformed stdout fragment as a
possible multi-line response. If the fragment never completed, every later
valid JSON-RPC message was concatenated into it and lost until the 16 MB buffer
limit or a request timeout.

- A later line that independently parses as a routable JSON-RPC response,
  request, or notification now discards the malformed partial and routes the
  valid envelope immediately.
- Genuine multi-line responses remain buffered and reassembled unchanged.
- Regression tests cover recovery of both an awaited response and a
  notification after a malformed partial line.

Verified: focused RPC coverage (10 tests), full suite (344 tests), production
build, and a disposable Electron launch/shutdown smoke all passed. The
verification profile and browser-control socket were removed after shutdown.

## Remaining

1. Continue the silent-failure sweep across the remaining lifecycle seams.
2. Add golden/integration coverage for restart, cancellation, background work,
   and browser ownership.
3. Run focused lifecycle/crash sweeps and simplify only confirmed fragile or
   duplicate paths.
