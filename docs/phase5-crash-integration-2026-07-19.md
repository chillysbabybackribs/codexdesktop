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

## Increment 2 — lifecycle golden coverage (landed)

`src/main/lifecycle-golden.test.ts` and
`src/renderer/src/background-lifecycle-golden.test.ts` compose the production
boundaries that previously had only component-level coverage:

- app-server process + RPC restart: an incomplete response from a crashed
  process rejects stale work, then the replacement process resumes cleanly;
- dynamic tool router + turn-owned browser queue: cancelling a turn while its
  browser call is queued prevents any execution against the shared tab;
- keyed session store replay: a background completion remains available under
  its own session without mutating the focused transcript; and
- popup target registry + CDP session: close-time cleanup detaches once,
  releases CDP listeners, and removes the registered target.

The suite is deterministic and uses fakes only at Electron/process edges; the
ownership, routing, queueing, persistence-model, and cleanup implementations
under test are the real production code.

Verified: the focused golden suite (4 tests), full suite (348 tests), and
typecheck pass. The isolated Electron verifier also completed its production
build, launched a labeled verification instance, and removed its temporary
profile and browser-control socket during controlled shutdown. The top-level
`npm run verify:app` invocation still reports exit 1 when deliberately
interrupted to end the otherwise interactive verifier; that is a harness exit
reporting limitation, not an observed boot or cleanup failure.

## Remaining

1. Continue the silent-failure sweep across the remaining lifecycle seams.
2. Run focused lifecycle/crash sweeps and simplify only confirmed fragile or
   duplicate paths.
