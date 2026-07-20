# Phase 5 — Worker offload + silent-failure sweep (2026-07-19)

## Worker offload

Finding first: the audit's "page-snapshot parsing in main" concern turned out
to be already solved — snapshot programs execute inside the guest page. The
one real main-thread CPU hazard was the **research static lane**: linkedom
parsing of up to 750 KB of HTML × up to 3 concurrent page workers, on the same
thread that services all 60+ IPC channels.

- [src/main/workers/static-extract.ts](../src/main/workers/static-extract.ts):
  the extraction core as a pure `(program, html, url) → outcome` function
  (parse, content-root check, shared extraction program, verification,
  thresholds) — single implementation used everywhere.
- [static-extract-worker.ts](../src/main/workers/static-extract-worker.ts):
  utilityProcess entry (`init` with the program once, then `extract`/`result`
  messages). Emitted as its own main-build entry
  (electron.vite.config.ts → `out/main/static-extract-worker.js`).
- [static-extract-client.ts](../src/main/workers/static-extract-client.ts):
  lazy fork, pending-job map, 15 s per-job timeout, crash → refork on next
  use; **every failure path falls back to the identical inline
  implementation** (also what node tests exercise), so degradation is slower,
  never silent. `research-static-fetch.ts` now calls the client; its local
  parser was deleted.

Verified: 342/342 tests (fetch tests run the inline path), build emits the
worker entry, and a direct Electron probe forked the built worker and
round-tripped `init`+`extract` → `ok: true` (title/wordCount correct). A live
research_web run against a large page took the Chromium lane (over the static
byte cap), which is correct behavior — the static lane engages on smaller
documents.

## Silent-failure sweep

- **Cold-resume silence (the named target)** was fixed in the parallel
  session, better than originally planned: `markResumeFailure` (App.tsx)
  writes a keyed warning system-item into the failing tab's own session
  (background tabs included), flips the chip to attention, and clears itself
  on successful re-select. Credited here for completeness.
- **`TabManager.find()` listener leak fixed** (tab-manager.ts): a superseded
  find or mid-search navigation never delivered the awaited `finalUpdate`,
  leaking the `found-in-page` listener and hanging the caller forever. Now
  settles via a 2 s timeout and a `destroyed` guard with full listener
  cleanup.
- Plugin connection refresh no longer fails silently (console.warn with
  context).
- **Classified as intentionally quiet** (not converted): store queue-tail
  `.catch(() => {})` guards (the operation's rejection still propagates to the
  caller; the catch only protects the internal chain), thread
  unsubscribe/interrupt cleanup for possibly-dead threads, clipboard auto-copy
  (cosmetic), and tab navigation catches (Chromium renders the error page in
  the tab — the user-visible surface already exists). The cdp-session empty
  catches are detach-race guards annotated in place.

## Build status after Phase 5

All five build phases are complete. Phase 6 (pre-launch security hardening)
remains deliberately locked until the user calls it — dev builds stay fully
unrestricted per the standing directive.
