# Codex Desktop — Capability Audit & Direction (2026-07-19, branch `master`)

> **Refreshed 2026-07-19 (same day, post-merge):** `stacked-subagents` was merged into
> `master`, and three capabilities shipped after the original audit was written — the
> `spawn_subagent` primitive (blocking single, both providers), the dock-card **Role
> radio** (Reviewer / Helper / read-only Worker), and the **conversational prompt-intake
> protocol** (paired-thread restate → confirm → reviewer-authored plan). All three are
> live-verified; the test count is now **590/590**. The capability claims below were
> re-verified against the current `master` checkout — earlier "missing" items that have
> since shipped are corrected in place.
>
> Purpose: an accurate, current map of what this app can do, plus a working hypothesis
> about where it's headed. Verified against the working tree — typecheck clean,
> **590/590 tests pass**, no TODO/FIXME markers in app source (two live in vendored
> `codex-protocol` wire types), every non-trivial source file has a sibling test. Supersedes `docs/codebase-audit-2026-07-19.md`, which predates the
> Claude runtime, the 1–4 pane split, turn checkpoints, and the doer/auditor loop and
> is therefore materially stale on capabilities (it remains useful as a dated
> file-by-file reference).

---

## 1. What this app actually is

Not "a Codex chat client." As built today it is a **two-runtime, browser-native agent
workstation with a self-reviewing agent mesh and a fully reversible workspace.** The
chat-client surface is the least differentiated part of it.

Three facts reframe the product:

1. **It is two-runtime, not single-provider.** A `SessionProvider` abstraction
   (`src/main/providers/session-provider.ts:35`) hosts both the OpenAI Codex app-server
   and the Claude Agent SDK behind one interface, routed by model-id prefix. The app
   "never branches on 'is this codex?' — it branches on capabilities"
   (`ProviderCapabilities`, `src/shared/session-protocol/provider.ts:9`). The Claude
   adapter (`src/main/providers/claude-provider.ts`, ~900 lines) is real and
   live-verified, with the app's own browser toolset injected as an in-process MCP
   server. Both runtimes wire the checkpoint system identically.

2. **The browser is the moat, and it is deep.** This is not a Playwright/Puppeteer
   wrapper. It drives Electron's own `WebContentsView` tabs via in-process CDP
   (`webContents.debugger`) — no launch/attach overhead, native screenshots, native
   PDF, a persistent logged-in Chromium profile. On top:
   - An **objective-aware page snapshot with a coverage contract**
     (`src/main/browser/page-snapshot.ts`, ~1200 lines): composed-tree traversal that
     pierces shadow DOM/slots, ranks items against the objective, reports named
     coverage gaps, and emits an explicit `answer` vs `targeted-gap-fill` next-action.
   - A **self-terminating research runner** (`src/main/browser/research-runner.ts`) with
     line/column-anchored exact-passage citations, a bounded static-HTML lane before
     Chromium fallback, and model-authored coverage-need stopping.
   - **Rated Web Vitals + tracing + network journaling** via CDP
     (`performance-diagnostics.ts`, `cdp-session.ts`) — Lighthouse-lite LCP/CLS/INP.
   - **Coherent anti-fingerprint identity** (UA + `navigator` + UA Client Hints in
     lockstep, `browser-identity.ts`) and a **bundled Brave-style Tor tunnel** scoped to
     the guest partition with DNS and WebRTC leak closure (`vpn-manager.ts`).
   - **One tool dispatch, three transports**: the same `runBrowserTool`
     (`src/main/tools/browser-tool-registry.ts:37`) backs Codex dynamic tools, a
     Unix-socket HTTP API for agent shell scripts (`CODEX_BROWSER_SOCK`), and an MCP
     stdio shim an *external* Claude Code can drive.

3. **The workspace is fully reversible and self-reviewing.**
   - `src/main/turn-checkpoint.ts` snapshots every turn into a hidden git ref
     (`refs/codexdesktop/checkpoints`) via a temporary git index — worktree-invisible,
     per-file undo, whole-worktree revert (itself checkpointed), and ground-truth change
     detection that catches shell writes protocol events miss.
   - A **cross-provider doer/auditor loop** (`src/renderer/src/audit-trigger.ts`): the
     main chat does the work on one model family; a dock agent in audit mode (defaulting
     to the *other* family) reads the actual diff in the shared workspace and returns a
     `VERDICT: pass|flag`, gated to one bounce per turn so it cannot loop infinitely.
     Workspace-grounded, not transcript-piped.

### Capability surface at a glance

| Layer | Real and working |
|---|---|
| **Runtimes** | Codex (shared app-server child) + Claude Agent SDK (per-session; 3-slot cap, non-mid-turn idle-kill, resume via session-id map). Capability-declared divergence. |
| **Browser tools** | `browser_snapshot`, `browser_navigate`, `browser_screenshot`, `app_screenshot`, `ui_review` (desktop/tablet/mobile + audit), `browser_flow`, `browser_run`, `browser_extract_page`, `browser_cdp` (15 sub-ops), `research_web`. |
| **Chat UI** | Up to 12 tabs; **1–4 pane split** with drag-to-tear, each pane independently live; Shiki code, inline chart fences, live diff cards, terminal cards, thought/reasoning blocks, plan checklists, turn-tail receipts. |
| **Review** | Keep/Undo bar (per-file + whole-turn + "always keep"), checkpoint revert, deep per-turn Trace modal (per-call token/context-growth attribution). |
| **Agent dock** | Born-a-reviewer cards with a **Role radio** (Reviewer / Helper; spawned Workers show a read-only role line), cross-provider model auto-derivation, audit mode, report-to-main auto-feedback (Send / Always send / Keep), model-spawned worker cards via `spawn_subagent` (blocking single; orchestrator in `src/main/agents/`), promote-to-main, extend/zoom, recency-weighted capsules. |
| **Context** | @file/@folder/@plugin mentions (git-indexed), attachments/images, mid-turn steering (Codex), auto-compaction watchdog at 80%, prior-chat memory, local skills, conversational prompt-intake on paired fresh threads (doer restates → user confirms in chat → reviewer plans; `main-chat-intake.ts`). |
| **Studio** | 10 skills, filesystem venture pipeline (`$studio-scout/hunt/validate/launch/pulse`), autosnapshot git watcher, disposable `verify:app` instance. |

---

## 2. What's ahead of the incumbents, and what's missing

Compared against Cursor 2.x/3.5, Claude Code (2026), and the OpenAI Codex app (2026):

**Genuinely ahead**
- **Logged-in, DOM-native agent browser** with a coverage-contract snapshot and
  evidence-grounded research. Incumbents' in-editor browsers are shallower; agentic
  browsers (Atlas/Comet/Claude-for-Chrome) match the *reach* but not the structured
  tool depth (CDP, network/perf journals, artifact-backed traces).
- **Reversible, cross-provider multi-agent review**: checkpoint-backed undo of even
  shell writes, plus a different-family reviewer by construction. No incumbent pairs
  these.
- **Reviewer-authored plans with an enforcer** (shipped in the post-merge refresh): on
  a paired fresh thread the doer restates the ask, the user confirms in natural
  language — no buttons — and the reviewer writes the plan *in its own thread*, so its
  later audits hold the doer to that plan's done-criteria (live-verified: "✓ pass …
  matches the plan's done-criteria"). Incumbents' plan modes produce inert documents.

**Conspicuously missing (build map in §4)**
- Subagent spawn is **Phase-1 blocking single only** — `spawn_subagent` (shipped
  post-audit: `src/main/agents/subagent-orchestrator.ts` + `agent-tool-router.ts`,
  both providers, interrupt cascade) runs one child to completion and returns its
  answer; no parallel fan-out/gather yet, and spawned workers are turn-ephemeral.
- Plan mode is **conversational only** — the paired-thread intake protocol (doer
  restates → user confirms in chat → reviewer authors the plan the doer executes;
  `main-chat-intake.ts`, shipped post-audit) covers the confirm-before-work moment,
  but there is no file-by-file plan-edit/approve surface.
- No **scheduling / background turns** (the studio doc's own first-pulled feature; Codex
  ships Automations).
- Browser network layer is **read-only** (no request interception/routing/mocking).
- No **file upload** or programmatic **cookie/session API** (auth rides the human's
  existing session only).
- No **slash-command palette / global quick-open**; only `@` mentions.
- No **message edit / retry-from-here / conversation branch**.

**Deliberately NOT pursuing** (enterprise-safety theater that does not serve a solo
operator running unrestricted by design): per-command approval/permission-mode UI (the
disabled "Auto" control in `Composer.tsx` should stay disabled or be removed),
cloud/sandboxed isolated VMs (the whole edge is the *local* logged-in browser + full
filesystem), and managed-settings/org/compliance layers.

---

## 3. Differentiators & direction (working hypothesis — NOT a committed northstar)

The team has not committed a single northstar, and this doc does not impose one. What
follows is the current thinking, to be validated by real use rather than treated as
settled.

**Differentiator 1 — Browser-first (durable moat).** The logged-in, agent-drivable
browser is real, shipped, and hard to replicate. This is the safest thing to lean into
because it is true today. Nearly every unbuilt studio capability (launch automation,
pulse monitoring, crystallized site scripts) is browser-automation work this layer is
already built to do.

**Differentiator 2 — Cross-provider RSI loop (promising, one working loop from proven).**
"RSI" here means the narrow, buildable thing: **the two runtimes reviewing and
correcting each other's work until a task is done.** The concrete base model:

- The **main chat runs a weaker/cheaper model** doing the work.
- A **stronger reviewer** spends comparatively few tokens reviewing the diff/output,
  and **auto-sends its report** back to the doer.
- The two **loop to completion** through an always-on ("ubiquitous") mechanism, rather
  than a one-shot audit.

This inverts the usual economics — cheap model does volume, expensive model does
high-leverage review — and is a direct generalization of the existing doer/auditor loop
(`audit-trigger.ts`), which today fires once per turn with a one-bounce cap. The
**beginning phase shipped** in the post-merge refresh: conversational intake gives the
loop its alignment gate (doer restates, user confirms, reviewer authors the plan it
will later audit against — see `docs/prompt-intake-2026-07-19.md`). The missing pieces
are the **mid-turn watchdog** (sparse, silence-by-default trajectory checks steered
into the running turn) and the **loop-to-done controller**: a bounded, converging cycle
(doer produces → reviewer flags → doer fixes → reviewer re-checks → …) with a clear
termination condition (reviewer passes, or a max-iteration / budget ceiling), built on
the existing checkpoint machinery so every iteration is reversible.

**The optimistic-but-possible horizon** these two combine into: a **long-running,
high-quality, start-to-finish pipeline** — a cheap doer + strong reviewer loop that can
carry a task (or eventually a studio idea) from start to a reviewed, verified finish with
minimal babysitting. Optimistic, explicitly. Documented as a direction to build toward
and measure, not a promise.

**Why no northstar is committed yet:** browser-first is proven; the RSI loop is not yet
validated end-to-end; the studio venture-pipeline is a third, largely-unbuilt thread
(see §5). Committing one northstar in writing now would over-constrain a solo project
still finding its shape. Revisit once the RSI loop is validated in real use.

---

## 4. Build priorities (serves both differentiators)

Ordered by leverage. The top three are also precisely the features that would let the
studio back-half run itself.

**Tier 1**
1. **Subagent spawn primitive.** *Shipped 2026-07-19 (Phase 1, post-audit):*
   `SubagentOrchestrator.spawnAndAwait` in main, provider-neutral router, `agentSpawned`
   announce, interrupt cascade, dock worker cards — blocking single. Remaining scope:
   **parallel gather** (Phase 2) and any spawn-tree persistence.
2. **RSI loop-to-done controller.** The bounded, converging doer↔reviewer cycle described
   in §3, with cheap-doer/strong-reviewer economics, checkpoint-reversible iterations,
   and explicit termination (reviewer pass or budget/iteration ceiling). Start from
   `audit-trigger.ts`; the hard part is convergence and stop conditions, not the plumbing.
   The beginning phase (intake) is shipped; next increment is the mid-turn watchdog
   (`docs/prompt-intake-2026-07-19.md` §build increments).
3. **Plan mode.** *Conversational form shipped 2026-07-19 (post-audit):* paired-thread
   intake — doer restates, user confirms buttonlessly, reviewer authors the plan and
   audits against it. Remaining scope, if real use demands it: a file-by-file
   plan-edit/approve surface on top of the existing checkpoint + diff machinery.
4. **Scheduling / background turns.** The unlock for the studio back-half and for
   long-running RSI runs. The harness already exposes scheduled-task tooling; wire the
   app to it.

**Tier 2 (when the substrate is solid)**
5. **Network interception / request routing** (`page.route` equivalent) — the one thing
   Playwright-based agents do that this browser can't.
6. **File upload + cookie/session API** — concrete blockers for studio-launch.
7. **Slash-command palette + global quick-open (Ctrl+K/P).**
8. **Message edit / retry-from-here / conversation branch** — natural extension of the
   checkpoint ref-namespace model; more achievable here than anywhere.

**Tier 3**
9. **Finish the neutral protocol** — the Claude adapter fabricates Codex wire shapes via
   pervasive `as unknown as` casts; `session-protocol/` still re-exports raw Codex types.
   Do this before a third runtime, not before shipping features.
10. **Steering fallback for Claude** (queue-until-next-turn vs throw) and **first-class
    persistence for Claude threads** (currently absent from history; depend entirely on
    the transcript cache).

---

## 5. Studio layer — honest status

The "operations department of a one-person app studio" pipeline (`docs/studio-system.md`)
is, today, **a funnel with only its mouth built.** Discovery (`$studio-scout`/`$studio-hunt`)
has run — 11 evidence-cited idea seeds, a serious source methodology
(`sources/DIRECTORY.md`), honest run-logs. But:

- **Nothing has advanced past `status: seed`.** No `validation.md`, `launch.md`, or
  `pulse.md` anywhere.
- **The crystallization convention** — the "LLM as compiler, scripts as runtime"
  `automations/` library described as the system's compounding asset — **does not exist.**
  The hunts that ran used throwaway per-run scripts, the opposite of a durable library.
- The discovery engine's **own gates are rejecting recent output** (latest hunt:
  "INSUFFICIENT COVERAGE, zero promoted ideas"; a prior run: "eval-failed").
- All studio artifacts are dated a single day (2026-07-11) and are static.

This is partly by design (the doc's "pull rule" defers app features until two real runs
demand them), and the design is honest about it. The takeaway for direction: the studio
is a compelling *application* of the substrate, but it is not the proof of the product —
the substrate is. The three Tier-1 build priorities (subagent primitive, RSI loop,
scheduling) are exactly what the studio back-half needs to run itself, so finishing the
substrate and unblocking the studio are the same work.

---

## 6. One-line summary

The substrate — logged-in agent browser + reversible cross-provider review, now with a
shipped subagent primitive and a reviewer-authored plan loop — is ahead of the
incumbents on the things that matter most for solo autonomous work; the gap between it
and "unstoppable" is the mid-turn watchdog, the RSI loop-to-done controller, and
scheduling, which are also exactly what would let the studio pipeline run itself.
