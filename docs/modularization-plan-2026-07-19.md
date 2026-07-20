# Modularization Plan — remaining god files (2026-07-19)

Scope: everything EXCEPT App.tsx (being refactored in a parallel chat). Based on a
3-way structural audit (renderer components / main-browser stack / providers-shared-core)
with importer graphs, test-coupling checks, and `.js`-shadow verification.

## Ground rules (apply to every batch)

1. **Barrel stability.** Every split keeps the original file as a barrel that re-exports
   the moved symbols. No importer's import line changes — this is what keeps the parallel
   App.tsx refactor (and the freshly extracted `ChatTranscript.tsx` / `ThreadScroll.tsx`)
   safe. All existing tests import public API only, so barrels keep every test green.
2. **Shadow guard.** None of the target files has a tracked sibling `.js` shadow (verified;
   the only tracked `.js` under src/shared is generated protocol code). After any file
   move/rename: `npm run clean:source-shadows`. `pretest`/`pretypecheck` run
   `check:source-shadows` and will fail on orphans.
3. **Verify per batch:** `npm run typecheck` (tsgo, real, 0 errors baseline) + tests +
   `electron-vite build`. Never kill the user's running app.
4. **App.tsx coupling (verified small):** only `trace.ts` (buildTurnTrace, isTurnTrace,
   TurnTrace) and `shared/ipc.ts` (BrowserBounds, BrowserState, MemoryPersistParams,
   ChatAttachment) are directly imported by App.tsx among the targets. Both split behind
   barrels → zero churn.

## Hard constraints discovered

- **`research-runner.contract.test.ts` is a source-text regex test.** It asserts literal
  const definitions (`STATIC_PREFLIGHT_TIMEOUT_MS = 2_000`, `PAGE_WORKER_CONCURRENCY = 3`,
  etc.) and the literal call `buildPageExtractionProgram(MAX_ARTIFACT_CHARS, MAX_HTML_CHARS)`
  exist in `research-runner.ts`, and that `TabManager|createTab|activateTab` do NOT.
  Those literals must stay in-file (or the contract test migrates with them).
- **`pageSnapshotRuntime` (937 of page-snapshot.ts's 1196 lines) is irreducible.** It is
  `.toString()`-serialized and injected into pages; its 44 nested closures cannot be
  moved to other modules. Only the Node-side ~250 lines are extractable.
- **Renderer convention is flat** (`src/renderer/src/*`), with pure logic peeled to sibling
  `*-model.ts` + `.test.ts` (vitest). Follow it; don't introduce `components/` dirs.
- **Cross-file icon edges:** `SendArrowIcon` (AgentDock→Composer), `PluginGlyph`
  (PluginBrowser→Composer), `NewAgentIcon` (Composer→App). Duplicated icons:
  `ChevronDownIcon` ×3, `ChatBubbleIcon` ×2.

## Phase 1 — Pure-logic peels (zero UI risk, each gains a `.test.ts`)

Mechanical, high-value, safe to do immediately and in any order:

| New module | Pulled from | Contents |
|---|---|---|
| `activity-format.ts` | TaskActivity.tsx 163–283 | fmtDuration, fmtTokens, formatBytes, truncate, stripAnsi, previewJson, itemDurationMs, blockStatus |
| `turn-summary.ts` | TaskActivity.tsx 1355–1471 | currentActionLabel, turnSummaryParts, tokenTooltip |
| `cdp-artifacts.ts` | TaskActivity.tsx 1039–1168 (data half) | cdpScreenshotArtifact(s), cdpFileArtifact |
| `thread-menu-model.ts` | MainChatTabStrip.tsx 675–764 | groupThreadsForMenu, threadTitle, relativeThreadTime, ThreadGroup |
| `composer-draft.ts` | Composer.tsx 26–36 | ComposerDraft, composerDrafts singleton, discardComposerDraft |
| `agent-window-props.ts` | AgentDock.tsx 265–296, 862–887 | AgentWindowProps, areAgentWindowPropsEqual, isSameLiveGlance |
| `agent-column-scroll.ts` | AgentDock.tsx (AgentColumn) | updateChevrons / scrollByWindow math |

Plus the two type-hub splits (pure re-org, no logic):

- **`shared/ipc.ts` (380 lines, 33 importers)** → `shared/ipc/` : `browser-types.ts`,
  `session-types.ts`, `attachment-types.ts`, `feature-types.ts`, `channels.ts`
  (ipcChannels). `shared/ipc.ts` stays as `export * from` barrel — all 33 importers
  (incl. App.tsx ×2 sites, preload, main) byte-identical.
- **`trace.ts` (792 lines)** → `trace-types.ts` (TurnTrace schema, lets TraceModal import
  types from a dependency-light module) + `trace-sources.ts`, `trace-artifacts.ts`,
  `trace-timeline.ts`, `trace-usage.ts`, `trace-truncation.ts`. `trace.ts` keeps
  buildTurnTrace + isTurnTrace + type re-exports (App.tsx line 37 unchanged).

## Phase 2 — Renderer component splits (biggest fat-trim)

Do TaskActivity LAST in this phase, or after the App.tsx refactor lands — it is the most
shared surface (App.tsx, ChatTranscript.tsx, AgentDock.tsx, trace.ts all import it).

1. **AgentDock.tsx (1360)** — biggest single win is the 560-line `AgentWindow`:
   - `AgentComposer.tsx` (composer form + submit/autosize/paste/drop, ~120 lines)
   - `AgentWindowMenu.tsx` (title dropdown, lines 568–688)
   - `agent-row-render.tsx` (renderAgentRow, AgentActivity, AssistantMessage, ExchangeCapsule)
   - `agent-audit-ui.tsx` (AuditStandby, AuditBriefDoc, GlanceActionLine, AgentContextPill)
   - icons → shared module (below). Barrel keeps: AgentColumn, AgentTabStrip,
     SendArrowIcon, AgentSession. Keep `emptyAgentRenderState` singleton with the
     store-subscription code (referential stability).
2. **Composer.tsx (728)** — `FileMentionMenu.tsx`, `PluginMentionMenu.tsx` (+MentionGlyph),
   optional `useMentionMenu` hooks. Barrel keeps: Composer, NewAgentIcon, discardComposerDraft.
3. **MainChatTabStrip.tsx (814)** — `ThreadMenu.tsx` (449–673, fully self-contained).
   Tab-drag pointer geometry could join `main-chat-tabs.ts` later (DOM-coupled, lower priority).
4. **PluginBrowser.tsx (616)** — `PluginSetupPanel.tsx` (521–616), `usePluginBrowser.ts`
   (refreshConnections/load/verifyAuthentication). Barrel keeps: PluginBrowserView, PluginGlyph.
5. **`icons.tsx` (shared)** — single renderer icon module; dissolves the 3 cross-file icon
   edges and the duplicated Chevron/ChatBubble icons. Old files re-export the 3 crossers.
6. **TaskActivity.tsx (1600)** — after the above:
   - `work-blocks.tsx` (~950 lines: all *Block renderers + ToolRow/StatusChip + WorkBlock
     dispatcher + WorkGroup; optionally split DiffCard.tsx further)
   - `CdpArtifactPreview.tsx` (render half of CDP artifacts)
   - `TurnTail.tsx`
   - `file-review-context.ts` (FileReviewContext + FileReviewActions — DiffCard consumes
     via useContext; move context to its own module so both sides import it)
   - Reconcile `AutoFollow`/`useNow` with the new `ThreadScroll.tsx` rather than creating
     a third scroll module. Barrel keeps: WorkGroup, TurnTail, AutoFollow,
     FileReviewContext + ItemMeta/TurnMeta/TurnPlanItem/WorkItem/FileReviewActions types.

## Phase 3 — Main process

1. **browser-agent.ts (1498) → `page-extraction-program.ts`** — TOP structural payoff:
   moves buildPageExtractionProgram + executePageProgram + wrap/unwrap/require +
   PAGE_PROGRAM_ENVELOPE_KEY/PAGE_SIGNAL_CODES + PAGE_EXTRACTION_* consts +
   assessBrowserExtractionResult/Value. Severs the research-runner→browser-agent edge
   (static-extract-client too). Re-export the 7 test-referenced names from
   browser-agent.ts (browser-agent.test.ts is public-API-only). NOTE: the call text in
   research-runner.ts must stay per contract test.
   Then, internal: `browser-agent-cdp.ts` (CDP plumbing behind CdpOperationContext),
   `browser-agent-fanout.ts`, `browser-agent-config.ts`.
2. **main/index.ts (576) → composition root.** Follow the existing `codex/codex-ipc.ts`
   precedent: `main/app-context.ts` (service container for the module singletons),
   `main/create-window.ts`, `main/app-lifecycle.ts`, `main/browser-persist.ts`,
   `main/instance-bootstrap.ts`, and `main/ipc/` split by domain: window, clipboard,
   attachment, browser, trace, checkpoint, mention, notification. index.ts becomes
   bootstrap → context → registerIpc groups → createWindow.
3. **tab-manager.ts (613)** — lowest-risk split of all (no dedicated test, importers
   type-only): `tab-layout-controller.ts`, `tab-navigation-controller.ts`,
   `tab-find-controller.ts`; TabManager stays as facade. Keep the
   `export { BrowserTarget }` re-export line.
4. **cdp-session.ts (602)** — `cdp-perf-expressions.ts` (4 injected-JS strings; co-locate
   with performance-diagnostics), `cdp-event-buffer.ts` (ring buffer + waiters + matchers).
   The `sessions` WeakMap registry stays single-owner in cdp-session.ts.
5. **research-runner.ts (935)** — `research-run-net.ts` (SSRF guard, loadPage, evaluate,
   waitForResearchContent, linkAbortSignals) and `research-run-metrics.ts` are safe pure
   peels. The 518-line `execute` decomposition needs a RunState class — do it only with
   the contract-test constraint honored (or migrate the contract test deliberately).

## Phase 4 — Providers/shared (lower priority: single-importer, cohesive)

1. **claude-events.ts (851)** → `claude-tool-translation.ts` (~250 lines: classifyClaudeTool,
   enrichToolCall, synthesizeReplaceDiff, planStepsFrom, extractToolResultText),
   `claude-error-classify.ts`, `claude-events-util.ts`, `claude-user-items.ts`. Barrel
   keeps ClaudeTurnTranslator + claudeContextWindowFor + turnStartedNotification + types
   (provider and the 533-line test both import via the barrel).
2. **command-narrate.ts (680)** → `command-verbs.ts` (VERBS/IMPERATIVES data),
   `shell-parse.ts` (quote/pipe tokenizer), `command-classify.ts` (~230-line classifier).
   Barrel keeps narrateCommand, cleanCommand, commandDescriptionOf, CommandNarration.
3. **claude-provider.ts (902)** → `claude-user-content.ts` (pure, testable),
   `claude-session-scheduler.ts` (cap-3 slot + idle-kill state machine),
   `claude-session-store.ts` (persistence + input stream), `claude-turn-notifications.ts`
   (co-locate vocabulary with claude-events). Only importer is codex-ipc.ts — keep class
   + ctor signature stable.
4. **codex-client.ts (566)** — optional; already cohesive. If touched:
   `codex-thread-state.ts`, `codex-auto-compact.ts`, `codex-turn-policy.ts`,
   `codex-notification-router.ts`, `codex-server-requests.ts`.

## Explicitly out of scope / do-not-touch

- App.tsx (parallel refactor owns it). TaskActivity.tsx barrel exports it consumes must
  not move without re-export.
- `src/shared/codex-protocol/**`, `src/shared/session-protocol/**` (generated).
- `pageSnapshotRuntime` internal structure.

## Cleanup candidates noticed (verify first)

- Externally-orphaned TaskActivity exports: `fmtDuration`, `fmtTokens`,
  `CdpScreenshotPreview`, `cdpScreenshotArtifacts`, `currentActionLabel` are exported but
  only used in-file (likely pre-refactor App.tsx leftovers). Keep exported through the
  Phase 1/2 moves; de-export in a later pass once the App.tsx refactor is merged.

## Suggested batch order

1. Phase 1 pure peels + ipc/trace barrels (one PR-sized batch; mechanical).
2. AgentDock + Composer + MainChatTabStrip + PluginBrowser + icons.tsx.
3. page-extraction-program + tab-manager + cdp-session extractions.
4. main/index.ts composition-root split.
5. TaskActivity work-blocks split (after App.tsx refactor merges).
6. research-runner execute decomposition; claude-events/provider/command-narrate splits.

Each batch: typecheck + tests + electron-vite build + clean:source-shadows.
