# Claude adapter — v1 landed (2026-07-19)

Codex Desktop is now a two-runtime app. Selecting **"Claude (Agent SDK)"** in
the ModelPill routes that conversation to the Claude Code runtime; everything
downstream — session store, transcript cache, checkpoints, tabs, dock — works
unchanged because the adapter speaks the shared notification vocabulary.

## Pieces

- **`src/shared/claude-events.ts`** — pure, stateful-per-turn translator: SDK
  stream messages → `ServerNotification`s (`ClaudeTurnTranslator`). Text blocks
  → agentMessage deltas/completions; thinking → reasoning summaries; tool_use/
  tool_result → mcpToolCall items; `result` → tokenUsage (cumulative via an
  injected accumulator) + turn/completed. Injected clock; init treated as
  repeatable (spike contract). Tested end-to-end THROUGH
  `reduceSessionNotification` in `src/renderer/src/claude-events.test.ts` — if
  those pass, a Claude turn renders.
- **`src/main/providers/claude-provider.ts`** — `SessionProvider` #2 under the
  approved policy: bounded per-session processes (cap 3 live; oldest-idle
  eviction; slot queue), 15-min idle-kill never mid-turn, resume via a
  persisted threadId → claudeSessionId map (`userData/claude-sessions.json`),
  streaming-input sessions (one persistent process per live session), stream
  death surfaced as a failed turn (never a silent hang). Checkpoint-on-send
  parity with codex (fire-and-forget + turn binding). Non-supported facets
  fail closed with clear errors (steering, goals, plugins) or benign empties.
  SDK options per spike: `includePartialMessages`, `settingSources: []`
  (isolation), `permissionMode: 'bypassPermissions'` (unrestricted dev parity
  with codex `danger-full-access`; Phase 6 revisits).
- **Routing** (`registerSessionIpc`): by thread-id prefix (`claude-…`) for
  existing threads, by model-id prefix for new ones; both providers' events
  fan into the same `session:event` channel; `listModels` merges both.
- **Runtime**: `@anthropic-ai/claude-agent-sdk@0.3.215` exact-pinned (D4);
  the platform package vendors the version-paired `claude 2.1.215` binary.

## Verified

- 366/366 tests (translator replay suite included; the session-protocol
  boundary ratchet caught and forced one import fix during the build —
  working as designed).
- Typecheck + build clean.
- **Live end-to-end**: fresh instance → ModelPill "Claude (Agent SDK)" → send
  → "BRIDGE" streamed into the standard transcript, thread id `claude-…`,
  zero errors → second message answered "BRIDGE" (same persistent SDK
  session, real continuity) → context gauge showed usage (token telemetry
  through the full chain).

## v1 limits (facts)

- **Model catalog follow-up complete:** the provider now discovers the
  account/policy-specific catalog through the SDK's `supportedModels()` control
  API. SDK values are exposed as provider-qualified picker ids (`claude:…`) so
  aliases such as `sonnet` cannot route to Codex; the SDK `default` row retains
  the persisted `claude-default` compatibility id. Display names, descriptions,
  resolved ids, effort levels, adaptive-thinking support, and fast-mode support
  come from the runtime rather than a hand-maintained list. Discovery failure
  falls back to the Claude Code account default without hiding Codex models.
- Model and effort changes on a live thread are applied through `setModel()`
  and `applyFlagSettings()` before the next input. Model, effort, and fast-mode
  state persist with the Claude session mapping. Result `modelUsage` supplies
  the actual context window instead of relying only on the model-name fallback.
- Text-only modality — image attachments are still blocked by the composer.
- No mid-turn steering (capability-declared; composer steer attempts surface
  a clear error). No goals/plugins/compaction. Skills auto-attach is
  codex-only.
- Claude history pages are empty on resume — the transcript cache paints
  history; live turns stream. Claude threads don't appear in the thread-menu
  history list (codex-only listing).
- ~~Browser tools not yet exposed~~ **DONE (same session)**: Claude sessions
  get all 10 browser tools via an in-process MCP server
  (`src/main/providers/claude-mcp-tools.ts` — JSON-schema→zod conversion of
  the canonical specs, handlers calling `runBrowserTool` directly, ownerless
  like the socket transport; wired through `mcpServers` in the provider).
  Verified: 369/369 tests (converter/required-ness/handler-mapping suite) and
  live — a Claude turn called `browser_navigate` through the in-process
  server, the EMBEDDED browser actually navigated (ground-truthed via the
  control socket's tab list), and Claude answered with the page title.
  Claude's shell can also reach the socket transport (`CODEX_BROWSER_SOCK`
  is inherited), matching codex's two-lane tool access exactly.
