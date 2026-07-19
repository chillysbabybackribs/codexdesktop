# Claude Code integration prep — status (2026-07-19)

Tracking against the 7-step prep plan. The 6-phase performance/usability build
delivered the deep prerequisites; this file tracks the remaining boundary work.

| Step | Status | Evidence / finish line |
|---|---|---|
| 1. Perf floor + measurement | **Functionally done, formally partial** | Markdown split, row virtualization, worker offload, pre-spawn, instant-restore cache all landed + live-verified (docs/phase1..5). Missing: automated streaming-render benchmark with checked-in numbers. |
| 2. Routing/reducer extraction | **Done, exceeded** | External SessionStore; one `reduceSessionNotification` for all surfaces incl. dock; O(1) tab switch. |
| 3. Type quarantine | **DONE (this session)** | `src/shared/session-protocol/` boundary module (re-exports the 22 consumed types; divergence point for future adapters). 24 renderer files migrated; `codex-protocol` appears 0 times under src/renderer; enforced forever by `session-protocol-boundary.test.ts`. |
| 4. ProviderAdapter boundary | **DONE (this session)** | `src/main/providers/session-provider.ts`: `SessionProvider` interface (full runtime surface incl. goal/plugin facets) + `codexCapabilities`; `ProviderCapabilities`/`ProviderId` in `shared/session-protocol/provider.ts`; `CodexClient implements SessionProvider`; all 21 channels renamed `codex:*` → `session:*`; preload group `api.codex` → `api.session` (renderer migrated, mocks included); `SessionEvent` envelope (CodexEvent kept as deprecated alias); provider registry map in `registerSessionIpc` — a Claude adapter registers there and inherits the whole IPC surface. Verified: 353/353 tests, build clean, live send round-trip over the renamed channels. Deferred to adapter #2 by design: per-request provider routing field, neutral main-side wire types. |
| 5. Golden replay tests | **Done** | `session-replay.test.ts` + `session-store.test.ts` pin the notification → render-model contract. |
| 6. Neutral tool registry + MCP facade | Not started | Tools still declared in codex-config.ts; unix-socket server already provider-neutral; MCP facade = thin shim over it. |
| 7. Claude process-lifecycle policy | Not started | Decision doc: spawn-per-session vs pool, cap, idle-kill + resume, vendored vs PATH. |

Bonus provider-neutral assets from the phase build: transcript cache (local
instant-restore works for any provider), turn checkpoints/revert (snapshots the
workspace, not provider edits), pre-spawn/warm-up pattern (template for the
Claude process pool).

Recommended order for the rest: 4 → 6 → 7 (4 is the prerequisite for both).
