# D5 spike result: the Claude adapter uses the Agent SDK (2026-07-19)

Empirical spike per `claude-prep-step7-process-policy-2026-07-19.md` D5.
Environment: isolated scratch install of `@anthropic-ai/claude-agent-sdk@0.3.215`;
two live micro-turns + one resume turn against the user's subscription.

## Findings against the three criteria

### 1. Binary sourcing — composes with D4 better than planned

The SDK vendors the FULL Claude Code runtime as a platform-specific optional
dependency (`@anthropic-ai/claude-agent-sdk-linux-x64@0.3.215` → a standalone
265 MB `claude` binary, verified `--version` = 2.1.215, exactly version-paired
with the SDK). It does not touch the PATH-installed CLI. Consequences:

- Lockfile-pinning the SDK pins the runtime binary — D4's requirement is met
  natively, with no self-updater to disable (the vendored binary isn't the
  auto-updating install).
- `pathToClaudeCodeExecutable` exists as an override, keeping the raw-binary
  door open if ever needed.
- D4 cost restated precisely: ~265 MB of DISK per platform dependency; zero
  RAM until spawned.

### 2. Process behavior — composes exactly with D1–D3

Observed live: a streaming-input session runs ONE persistent `claude` child
(same pid across both messages; RSS 270→287 MB — validating the policy doc's
150–250 MB estimate at the high end) which exits when the query closes.
`resume: sessionId` reconnected to the SAME session id and answered a
continuity probe correctly ("SPIKE"). So: one process per live session,
killable at idle, resumable on demand — the D1–D3 policy maps 1:1 onto SDK
primitives.

Adapter requirement discovered: `system/init` fires PER MESSAGE in
streaming-input mode (and again on resume). Init must be handled as a
repeatable event, not a once-per-process gate — the first integration's
init-gating bug, now formalized as a contract.

### 3. Streaming completeness — everything the reducer needs, plus a bonus

Captured event vocabulary with `includePartialMessages: true`:
`system/init` (session id, model, tool list, permission mode) ·
`stream_event:message_start / content_block_start / content_block_delta /
content_block_stop / message_delta / message_stop` (token-level text deltas) ·
`assistant` (full message) · `system/status` · `system/post_turn_summary` ·
`result/success` (usage incl. cache-read tokens, num_turns, cost) ·
**`rate_limit_event`** — a first-class rate-limit signal, which feeds the
policy's requirement that quota pressure back off rather than enter the
auto-recovery retry loop.

Mapping to `reduceSessionNotification` inputs: turn start (message_start),
agentMessage deltas (content_block_delta), item completion (assistant /
content_block_stop), turn completion + telemetry (result + message_delta
usage), errors (result subtypes + rate_limit_event). Tool calls arrive as
standard `tool_use`/`tool_result` content blocks (not exercised live; shape is
the stable Anthropic Messages format).

## Extras confirmed

- `createSdkMcpServer` is exported: the browser tools can run as an
  IN-PROCESS MCP server inside Electron's main process — the stdio shim
  (step 6) becomes the fallback/interop path rather than the primary.
- `settingSources: []` gives SDK isolation mode — the adapter fully controls
  its context; the user's `~/.claude` settings don't bleed into app sessions
  (managed-policy tier still applies, which is correct).

## Decision

**Agent SDK.** Under D4, pinning was mandatory either way, and the SDK's
vendored pairing does it natively; on top it adds a typed event stream,
in-process MCP for the tool layer, isolation mode, and resume/session
primitives that match the approved lifecycle policy 1:1. The raw-CLI lane
retains no unique advantage; it remains reachable via
`pathToClaudeCodeExecutable` + the stdio shim if ever needed.

Spike cost: 3 micro-turns; scratch install disposable at
`scratchpad/d5-spike` (not in the app repo — the real dependency lands with
the adapter build).
