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

- Single "Claude (Agent SDK)" model entry (SDK default model; no model-list
  API). Text-only modality — image attachments are blocked by the composer.
- No mid-turn steering (capability-declared; composer steer attempts surface
  a clear error). No goals/plugins/compaction. Skills auto-attach is
  codex-only.
- Claude history pages are empty on resume — the transcript cache paints
  history; live turns stream. Claude threads don't appear in the thread-menu
  history list (codex-only listing).
- Browser tools are not yet exposed to Claude sessions (Claude's built-in
  Bash/Edit tools work); wiring the in-process MCP server
  (`createSdkMcpServer` over the neutral registry) is the designated
  fast-follow.
