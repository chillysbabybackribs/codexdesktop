# Phase 5 — Crash, integration, and maintainability (2026-07-19, complete)

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
profile and browser-control socket during controlled shutdown.

## Increment 3 — lifecycle silent-failure sweep (landed)

The remaining lifecycle-oriented suppressed failures were classified rather
than broadly converted into noise:

- a failed Stop request now leaves an actionable message in the still-visible
  agent session, rather than appearing to stop a turn that may still run;
- failures to interrupt or unsubscribe a background agent after its UI closes
  now log the operation and thread id;
- failures to unsubscribe a reset or closed main-chat thread now log the
  detached thread id; and
- invalid or unreadable saved browser state now logs recovery context (except
  the expected first-run `ENOENT` case) before starting a fresh browser
  session.

Queue-tail guards, expected native-view/CDP detach races, Chromium's
user-visible navigation failures, and best-effort post-EOF stream cleanup
remain intentionally quiet: they preserve a reusable internal queue or have a
separate visible/error-bearing outcome already.

Regression coverage pins Stop feedback, closed-agent cleanup logging, and
corrupt browser-state recovery.

Verified: focused lifecycle coverage (14 tests), full suite (351 tests),
typecheck, and production build pass. An isolated Electron instance launched
and removed its temporary profile on controlled shutdown; its browser-control
socket was also removed.

## Increment 4 — controlled restart/crash sweep (landed)

The disposable verifier now waits for both browser-control readiness and the
completed browser-tab restore path before closing its window through Electron's
normal lifecycle. It no longer depends on terminal interruption, so
`npm run verify:app` reports the app's real exit status.

The final sweep passed:

- a clean production verifier run exits 0 after browser-control startup and
  normal browser/CDP/persistence cleanup; and
- two retained-profile verification launches both exit 0 and preserve a valid
  saved browser-state payload containing at least one tab across the restart.

Together with the deterministic golden flows for cancellation, background
work, and browser ownership, this completes the Phase 5 lifecycle/crash sweep.

## Increment 5 — terminal browser target ownership (landed)

When a browser operation returns `targetClosed` or `targetChanged`, the dynamic
tool router now records that target loss against the owning thread and turn.
Every later browser tool call in that same turn is rejected with the original
structured lifecycle failure and an instruction to start a new user request;
it cannot default to a different tab that has become active in the meantime.

The guard is released on turn completion (and interruption). The regression
test reproduces a no-tab `browser_flow` after the original active target is
closed, asserts that the next active tab receives no execution, and verifies
that turn cleanup releases the guard.

## Remaining

None. Phase 5's silent-failure, integration, lifecycle/crash, and fragile-path
completion criteria are met.
