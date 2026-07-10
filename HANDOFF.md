# Codex Desktop Token-Bloat Audit Handoff

Updated: 2026-07-10

## Objective

Reduce extreme Codex token growth during tool-heavy tasks and multi-turn conversations without weakening the model, removing CDP, or degrading task quality.

The user requested an audit first. The audit is complete; no token-optimization implementation has been made yet.

## Current State

- Repository: `/home/dp/Desktop/soloapps/codexdesktop`
- Codex CLI inspected: `0.144.1`
- Worktree was clean before this handoff was added.
- `npm test`: 33 tests passed.
- `npm run typecheck`: passed for main and renderer.
- Current app architecture: Electron/React client over `codex app-server --stdio`.

## Bottom Line

The bloat is real, but normal multi-turn conversation is not the main cause. Tool-heavy history is retained and processed again on every model call. The app currently combines that behavior with inherited/sticky reasoning effort and no early app-specific compaction or output budget.

The highest-value work is:

1. Make reasoning effort explicit on every turn instead of inheriting global `xhigh`.
2. Configure automatic compaction and tool-output limits for new and resumed threads.
3. Return compact artifact metadata from research/browser workflows instead of retaining generated scripts and large results.
4. Add per-call context telemetry so regressions can be attributed to specific tools.

## Measured Evidence

| Workload | Model calls | Per-call input growth | Cumulative input | Cached input | Compactions |
|---|---:|---:|---:|---:|---:|
| Saved research task | 8 | 15.8K to 35.2K | 204K | 81.5% | 0 |
| Tool-heavy, 5 turns | 55 | 14.9K to 213.4K | 5.19M | 94.5% | 0 |
| Tool-heavy, 11 turns | 37 | 14.8K to 73.7K | 1.54M | about 91% | 0 |
| No-tool, 5 turns | 5 | 17.7K to 18.1K | 89.7K | mostly cached | 0 |

Important interpretation: cumulative input is the sum across model calls, not a single context window. The large cached share means cumulative tokens overstate fresh-token cost, but the per-call context still grew to more than 200K and was repeatedly processed.

Primary evidence:

- `docs/codex-trace-019f4a41-241.json`
  - 204,125 accumulated input tokens across 8 calls.
  - Latest call input: 35,190.
  - Cached input: 166,400, or 81.5%.
- `/home/dp/.codex/sessions/2026/07/09/rollout-2026-07-09T21-33-29-019f49a8-870d-73a1-b677-42632470cb2e.jsonl`
  - Five turns and 55 token events.
  - First call input: 14,932.
  - Last call input: 213,426.
  - Total input: 5,194,387.
  - Cached input: 4,907,776.
- `/home/dp/.codex/sessions/2026/07/10/rollout-2026-07-10T00-26-31-019f4a46-f488-7a71-ba31-094b263f0662.jsonl`
  - Two turns and 35 token events.
  - Last call input: 198,558.
  - Total input: 4,222,696.
  - 118 retained tool calls.

An optimistic replay-cap calculation on the 5.19M-input thread produced:

| Hypothetical per-call cap | Replayed input | Reduction before compaction overhead |
|---|---:|---:|
| 64K | 2.89M | 44.3% |
| 80K | 3.35M | 35.5% |
| 96K | 3.77M | 27.4% |

These are directional estimates, not guaranteed savings. Real compaction itself consumes tokens.

## Findings

### P0: Reasoning policy inherits and sticks to the wrong effort

Relevant code: `src/main/codex/codex-config.ts`, `resolveTurnPolicy()`.

The global Codex config currently defaults to `model_reasoning_effort = "xhigh"`. `resolveTurnPolicy()` only returns `effort: "low"` for a narrow research regex; otherwise it omits effort and inherits the global value.

The research-skill classifier recognizes `search`, `reddit`, `forum`, `reviews`, and similar terms, but the effort classifier does not. A Reddit research task was therefore assigned the research skill while running at `xhigh`.

Turn effort is sticky for subsequent turns. This produced both failure modes in observed threads:

- A missed research classification left the entire thread at `xhigh`.
- A thread that started at `low` remained low during later implementation work.

Recommended change:

- Use one shared task classifier for skill routing and effort routing.
- Always return an explicit effort for every turn.
- Suggested defaults:
  - `low`: lookup, search, extraction, simple edits.
  - `medium`: normal implementation.
  - `high`: complex audit/debug/security work.
  - `xhigh`: explicit user opt-in only.
- Prefer `summary: "concise"` or `summary: "none"` unless detailed reasoning summaries are required.

Add focused tests for search/Reddit/forum tasks, implementation after research, and research after implementation.

### P0: No app-specific context governor

Relevant code:

- `src/main/codex/codex-config.ts`: `newThreadConfig` and `legacyResumeConfig`.
- `src/main/codex/codex-client.ts`: `startThread()`, `resumeThread()`, and `sendMessage()`.
- Generated protocol: `src/shared/codex-protocol/v2/ThreadCompactStartParams.ts`.

The app sets no automatic compaction threshold and no global tool-output token limit. It also exposes no manual `thread/compact/start` action despite the installed app-server protocol supporting it.

Recommended initial experiment:

```ts
const tokenBudgetConfig = {
  model_auto_compact_token_limit: 64_000,
  model_auto_compact_token_limit_scope: 'body_after_prefix',
  tool_output_token_limit: 4_000
}
```

Apply the same policy to new and resumed threads. Treat 64K/4K as starting points for an A/B evaluation, not unquestionable final values.

Also add:

- A manual **Compact context** action.
- A context warning before a call exceeds the selected budget.
- A **Start new thread with summary** path for major topic or model changes.
- Handling/telemetry for the `thread/compacted` notification.

### P0: Tool arguments and outputs dominate retained history

Relevant code:

- `src/main/browser/browser-agent.ts`
  - Default browser result: 24,000 characters.
  - Maximum: 100,000 characters.
- `src/main/codex/codex-client.ts`, `handleDynamicToolCall()`
  - Serializes the full result into a model-visible `inputText` tool response.
- `skills/artifact-first-web-research/SKILL.md`
  - Directs the model to generate a full Node task capsule.

Even when the script prints compact stdout, the generated source itself remains as a tool-call argument. Subsequent outputs are also retained. Some sampled rollouts contained 40K-character tool results, and screenshot flows stored multi-megabyte base64 payloads in the rollout.

Recommended changes:

- Reduce the default browser result to roughly 6K-8K characters.
- Reduce the ordinary maximum to roughly 24K.
- Return compact previews plus artifact paths for larger content.
- Do not return base64 screenshot payloads as replayable text history.
- Crop or downscale images before model use when full resolution is unnecessary.
- Track argument and output sizes per tool call.

### P0/P1: A compact research implementation exists but is not declared

Relevant code:

- `src/main/codex/codex-client.ts` handles `research_web` and `browser_extract_page`.
- `src/main/browser/research-runner.ts` stores extracted pages as artifacts and returns mostly metadata.
- `src/main/codex/codex-config.ts` declares only `browser_run` and `browser_cdp` in `browserDynamicTools`.

The model cannot call the compact research path because it is not in the declared dynamic tool list. Instead, the attached skill often generates long scripts through shell calls.

Recommended direction:

- Keep `browser_cdp`; the user explicitly considers CDP essential.
- Declare a compact artifact-returning research primitive, either the existing `research_web` or a redesigned capsule tool.
- Keep its schema and returned envelope small.
- Use it for common research, while leaving `browser_run` and CDP available for irregular or interactive work.
- Avoid adding a large permanent tool wall; deferred discovery is preferable if supported cleanly by the app-server path.

### P1: The fixed starting context is already large

One saved first call started at 15,818 input tokens before meaningful task execution. Visible prompt components included approximately:

- 21.6K characters of model base instructions.
- 16.7K characters of memory guidance.
- 7.1K characters of skill-system guidance on GPT-5.5.
- 7K characters for the selected research skill.
- App/plugin/task-shaping instructions and tool schemas.

The app starts `codex app-server --stdio` with inherited environment/configuration. The global configuration enables memories, apps/plugins, and multi-agent capabilities. These features add instructions even when the app task does not use them.

Recommended direction:

- Create a lean Codex Desktop runtime profile using app-server config overrides, while preserving authentication.
- Disable memory injection by default if cross-thread recall is not needed for the current thread.
- Disable multi-agent, apps, and remote-plugin instruction surfaces unless enabled by an app feature or user choice.
- Do not replace the model's base instructions as an early optimization; that is higher risk.
- Do not assume `memories.disable_on_external_context` removes injected memories. It controls whether externally grounded work is used for memory generation; `memories.use_memories` controls injection.

### P1: Model switches duplicate instruction bundles

Observed evidence:

- `/home/dp/.codex/sessions/2026/07/10/rollout-2026-07-10T00-17-07-019f4a3e-56a8-7a91-9b1d-4febcd4954ff.jsonl`
- A model switch appended another roughly 39.5K-character developer/instruction bundle to an already-large thread.

Recommended direction:

- Offer to switch models in a new thread with a concise handoff.
- Otherwise compact before switching a long thread.
- In `sendMessage()`, only send a model override when it differs from the app's tracked effective model.
- Avoid resending `developerInstructions` on resume unless the instruction version has changed. Confirm this behavior with a controlled resume test before changing it.

### P1: Current telemetry loses the per-call growth curve

Relevant code:

- `src/renderer/src/turn-telemetry.ts`
- `src/renderer/src/trace.ts`
- `src/renderer/src/TraceModal.tsx`

The current trace correctly separates whole-turn accumulated usage, the latest model call, and the final thread counter. However, it retains only the latest call rather than a bounded list of exact per-call samples.

Add a bounded sample list containing:

- Sequence number and timestamp.
- Input, cached input, uncached input, output, and reasoning output.
- Context-window percentage.
- Closest preceding tool/item ID and type.
- Tool argument/result character counts.
- Compaction marker.
- Delta from the previous model call.

The UI should lead with **current/latest context size**, then show accumulated consumption separately. Add a small context-growth chart and highlight cache-miss spikes.

## Not a Model-Token Cause

`resumeThread()` asks for up to 500 full turns using `initialTurnsPage`. This can produce renderer memory, IPC payload, and resume-latency problems, but the renderer does not resubmit those turns as model input. Reducing this page is useful for UI performance, not the primary token fix.

Likewise, switching `historyMode` from `legacy` to `paginated` should not be presented as a model-token optimization without evidence. That contract primarily affects persisted history retrieval.

## Recommended Implementation Sequence

Keep changes measurable and reversible:

1. **Per-call telemetry first**
   - Preserve the exact usage curve and tool-size attribution.
   - Add reducer and trace tests.
2. **Effort-policy correction**
   - Shared classifier.
   - Explicit effort every turn.
   - Concise/none reasoning summaries.
3. **Context/output budgets**
   - Add compaction and tool-output config to start/resume.
   - Handle compaction events.
   - Add manual compact UI.
4. **Research/tool contraction**
   - Expose the compact artifact-returning research path.
   - Lower browser result limits.
   - Preserve CDP.
5. **Lean runtime profile**
   - Make memory, apps/plugins, and multi-agent surfaces opt-in where practical.
6. **Model-switch/thread-lifecycle controls**
   - Compact or fork with a summary before carrying a large thread across models/topics.

Do not combine all six into one unmeasured rewrite.

## Verification Plan

Run the same controlled scenarios before and after each phase:

1. Short no-tool conversation across five turns.
2. One research task requiring several sources.
3. Research followed by a code implementation request in the same thread.
4. A tool-heavy code audit.
5. Resume the thread and send another turn.
6. Switch models after context growth.

Record for every scenario:

- First, maximum, and final per-call input.
- Accumulated input.
- Cached and uncached input.
- Model call count.
- Reasoning-output tokens.
- Tool argument/output characters.
- Compaction count and cost.
- Task correctness, citations, tests, and wall time.

Suggested acceptance targets for the first optimization pass:

- No ordinary call exceeds the configured context budget without compaction or a visible warning.
- Search/Reddit/forum prompts never inherit `xhigh` accidentally.
- Normal implementation defaults to `medium`, not sticky `low` or global `xhigh`.
- Large browser/research payloads are artifact-backed rather than replayed inline.
- The trace can identify the exact call where context grew.
- Existing test/typecheck suites remain green.

## Useful Commands

```bash
npm test
npm run typecheck
git status --short
```

For source discovery:

```bash
rg -n "resolveTurnPolicy|newThreadConfig|legacyResumeConfig|browserDynamicTools" src/main/codex
rg -n "tokenUsage|latestCall|modelCallCount|thread/compacted" src/renderer/src
rg -n "research_web|browser_extract_page|maxResultChars" src/main
```

## Constraints and User Preferences

- Treat the live checkout as the source of truth.
- Preserve CDP as a first-class capability.
- Do not solve token bloat by silently selecting a weak model.
- Distinguish cumulative input, current context, cached input, and uncached input.
- Prefer compact artifact-backed workflows over large inline transcripts.
- Verify with real app-server token events, not only estimated character counts.
- Keep the first implementation phase narrow and benchmark it before proceeding.

## Recommended Opening Prompt for the New Chat

> Read `HANDOFF.md` and inspect the current checkout. Continue the Codex token-bloat work from the recommended implementation sequence. Start with per-call telemetry and the explicit turn-effort policy, verify both with tests, and do not remove or hide CDP.
