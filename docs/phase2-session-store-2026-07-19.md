# Phase 2 — External session store (2026-07-19, in progress)

Goal: one render model for every conversation surface, held outside React in
`src/renderer/src/session-store.ts`; surfaces subscribe by key. No behavior or
restriction changes.

## Landed

**Core module** (`session-store.ts` + 10 tests):
- `SessionRenderState` — generalizes the old `MainChatSnapshot`.
- `reduceSessionNotification` — the single notification → state path
  (deterministic: injected clock, no refs). One deliberate upgrade over the old
  background path: compaction `beforeTokens` is recorded in item meta
  (active-path fidelity).
- `SessionStore` — subscribable key → state map with stable snapshot refs.

**Slice 1 — background main-chat tabs** run through the store;
`backgroundMainChatSnapshot` / `reduceBackgroundTurnSnapshot` deleted.

**Slice 2 — active main-chat path** runs through the store:
- `useSyncExternalStore(subscribeAll, get(activeTabKey))` feeds the UI; the 10
  migrated `useState`s and 12 mirror refs are now **store-backed shims**
  (`activeSessionShims` in App.tsx) with identical call-site APIs — getters and
  setters route to `store.update(activeKey, …)`.
- `updateMainChatTabs` applies eagerly against the ref so
  `activeMainChatTabKeyRef` is correct the moment it returns (shim writes in
  the same handler must target the new key).
- All in-place `Map`/`Set` ref mutations converted to immutable assignments;
  the one setter-updater that wrote a ref inside its callback (tokenUsage
  handler) was hoisted — nested `store.update` inside `store.update` would
  revert the inner write (comment at the site).
- Hydration semantics: `needsMainChatTabHydration(tab, cachedThreadId)` — a
  session counts as cached only when it holds THIS tab's thread. Auto-created
  empty sessions (from `store.get`) never block a resume.

## Verified

- 328/328 tests, typecheck + build clean.
- Live smokes (disposable instances): active-path streaming (ALPHA/BRAVO two-tab
  isolation both directions, switch-back restore), background mid-stream
  completion → attention chip → intact restore, and 3 consecutive cold-boot
  restart restores after graceful close.

## Findings from verification (not regressions; noted for later phases)

- `resumeThreadById`'s `silent: true` catch swallows cold-start resume
  failures entirely (App.tsx, catch block: `persistLastThreadId(null)` and
  nothing else) — one nondeterministic empty-transcript boot was observed and
  traced to this pre-existing path. Phase 5's silent-failure sweep should
  surface it; Phase 3's instant-restore cache makes it mostly moot.
- Test-harness note: SIGTERM does NOT run Electron's graceful quit on Linux —
  localStorage and before-quit flushes are lost. Close via the app
  (`window.api.window.close()`) when testing persistence.

## Slice 3 — swap machinery deleted (landed)

- `captureActiveMainChatSnapshot` (13-field copy) → `flushActiveMainChatSession`
  (just flushes pending rAF item mutations; every other write is already live
  in the store). `applyMainChatSnapshot` (27 ref/state writes) →
  `focusMainChatTab` (composer model/effort projection, `watchThreadIdRef`,
  title continuity for uncached tabs). Tab switching is now a pure active-key
  change; the store IS the state.
- Uncached-tab title seeding writes title only — never threadId — so a
  title-only session can never suppress hydration.
- Verified: 331/331 tests, build clean, live two-tab ALPHA/BRAVO smoke on the
  rewritten switch flow (isolation both directions, switch-back restore).

## Slice 4 — replay contract tests (landed)

`session-replay.test.ts`: full notification sequences (turn lifecycle with
deltas, work-item grouping into activity/tail rows via `buildRows`, compaction +
goal + terminal error) through `reduceSessionNotification`, asserting the
render-model shape the UI draws. This is the regression net for the dock
migration and future provider adapters.

## Remaining in Phase 2

- Dock agent sessions onto the store (lite path in `useAgentSessions.ts` /
  `agent-session-model.ts`): route dock threads through
  `reduceSessionNotification` under the dock session key, keep dock-only
  metadata (watchesMain, model override, open/selected) separate, synthesize
  the `AgentSession[]` prop AgentDock already consumes. Side effects (OS
  notification, auto-recovery) stay caller-side. Consider batching dock store
  notifies per rAF (dock deltas currently coalesce per frame; keep that
  property).
