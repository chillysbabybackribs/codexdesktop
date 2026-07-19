# Prompt Intake — beginning-phase supervision (design, 2026-07-19)

## The finding this design answers

Live test (long research turn, weak doer): a broad/poorly-scoped prompt is **not a
correctness death sentence — the doer rebounds — but it is a time/token death
sentence**. The waste happens in the detour before the rebound. Therefore:

- The intake system's value is **economic** (cut detours), not safety.
- It must not tax the majority case: most prompts are fine, and a serial
  "planning gate" before every send would cost more latency than the detours it
  prevents.
- The strong model's comparative advantage is highest here: weak models degrade
  far more on intent-inference and scoping than on execution.

This is the **beginning** phase of the three-phase supervision schedule
(beginning = alignment, middle = trajectory watchdog, end = diff-grounded
verdict). One reviewer identity, three trigger moments, three prompts. This doc
specs the beginning; the watchdog and verdict are separate increments (verdict
already ships as the audit pairing).

## Shape: one intake call, three intervention levels, two modes

### The intake call (single strong-model call per eligible prompt)

One call does triage **and** produces the artifact — no separate classifier hop.

- **Model**: the paired reviewer model — the active Reviewer card's model if one
  exists, else `defaultReviewerModel(mainModel, models)` (agent-session-model).
  Never hardcoded; explicit user choices always win; single-provider setups fall
  back to the main model or intake disabled.
- **Vehicle**: headless blocking one-shot — the same mechanism
  `SubagentOrchestrator.spawnAndAwait` already provides (thread-less parent,
  model override, final text back). App-initiated, not model-initiated; a thin
  IPC (`intake/run`) wraps it. No new turn machinery.
- **Input**: the user's draft prompt + minimal context: workspace name, and the
  active thread's last exchange (required — follow-ups like "now fix the other
  one" are only triageable with the thread tail).
- **Output contract** (strict, small):
  `{ verdict: 'pass' | 'enrich' | 'confirm', addendum?, question?, options? }`
  - `addendum` ≤ ~120 words: interpretation, constraints, done-criteria,
    suggested first moves. **Framing, not railroading** — the doer rebounds well,
    so give it a frame, never a step list that overrides its judgment.
  - `confirm` only when the prompt forks into **materially different** tasks.
    Target rate < 10% of prompts; a naggy gate is a dead gate.

### Levels

| Level | Verdict | What happens |
|---|---|---|
| 0 | `pass` | Nothing. Doer proceeds on the verbatim prompt. |
| 1 | `enrich` | Addendum attached behind the scenes (see delivery below). |
| 2 | `confirm` | User sees one compact question with options + "proceed anyway". |
| 3 | — | Ask-first mode: the brief is always shown for approve/edit (plan-mode-lite). |

### Modes (the user-facing dial)

- **Off** — no intake calls.
- **Auto** (default) — behind the scenes; level 2 surfaces only on a real fork.
- **Ask-first** — every eligible prompt returns the sharpened brief to the user
  before sending; the user can adopt the rephrase into the composer, edit, or
  send as-is. This is the natural seed of the roadmap "plan mode".

## The latency trick: parallel intake in Auto mode

Serial gating contradicts the finding (majority of prompts fine ⇒ pure added
latency). In **Auto**:

1. User hits Enter → **doer turn starts immediately**, unchanged.
2. The intake call runs **concurrently**.
3. `pass` → nothing (zero added latency, the common case).
4. `enrich` → the addendum arrives as a **steer** into the running turn (the
   existing steer channel — "Add guidance while Codex works…"). It lands within
   the first seconds, before meaningful waste.
5. `confirm` → interrupt the doer turn (existing interrupt + turn-checkpoint
   revert), show the question, restart with the answer folded in. Waste = a few
   seconds of doer tokens — still far below a detour.

In **Ask-first**, intake is serial by definition (the user wants to see the
brief before anything runs).

## Delivery and honesty rules

- **Never replace the user's text.** The transcript shows the verbatim user
  message; the addendum travels as a delimited `<intake-brief>` block appended
  to the outgoing text (or steered in, in parallel mode) and is stripped from
  display — the exact pattern `stripInjectedMemory` / `stripMentionContext` /
  `stripMainChatContext` already implement. Literal rephrasing is legitimate in
  exactly one place: Ask-first, where the user ratifies it in the composer.
- The end-of-turn audit briefing already carries the user request, so the
  auditor sees the enriched intent at verdict time through the existing path —
  intent context flows beginning → end with no new plumbing.
- Confirm UI reuses the decision-at-moment-of-value card pattern
  (SendPolicyPrompt precedent): options + "proceed anyway" escape hatch. No
  timeouts; an unanswered card just waits (Ask-first) — in Auto the doer was
  interrupted deliberately, so waiting is correct.

## Skip conditions (no intake call at all)

- Steers into an already-running turn.
- Bare confirmations / trivial continuations ("yes", "continue", "run tests").
- Slash-command-like inputs and mention-heavy prompts that are already precise
  file operations.
- Intake model unavailable (no second family configured and main model busy).

Everything else is eligible in Auto/Ask-first. Heuristics stay minimal — the
triage call itself is the classifier; skips exist only to avoid obviously
pointless calls.

## Cost model

Per eligible prompt: one strong call with small output (~hundreds of tokens).
Auto mode adds zero wall-clock in the `pass` case, seconds in `enrich`, and an
interrupt/restart only on rare `confirm`. This spends strong-model tokens at the
point of maximum variance (the start), which is the whole cheap-doer/strong-
reviewer economic premise.

## Build increments

1. **Intake core + Auto parallel enrich**: `intake/run` IPC over the
   orchestrator one-shot; steer delivery; strip helper; `confirm` degrades to an
   enrich addendum that states assumptions explicitly. Smallest honest slice;
   immediately cuts detours.
2. **Confirm path**: interrupt + checkpoint revert + inline question card +
   restart with the answer.
3. **Ask-first mode**: composer surface for approve/edit/adopt; the plan-mode
   seed.
4. (Separate spec) **Mid-turn watchdog**: same reviewer, decaying cadence,
   silence-by-default, steer-only output — shares the steer delivery built in
   increment 1.

## Anchors (verified in code this session)

- Steer channel: main-chat steer + `onSteer` (composer "Add guidance while
  Codex works…").
- Blocking one-shot: `SubagentOrchestrator.spawnAndAwait`
  (src/main/agents/subagent-orchestrator.ts) — model override, cwd, finalText.
- Cross-family model default: `defaultReviewerModel`
  (src/renderer/src/agent-session-model.ts) — "never a lock".
- Prompt-augmentation + display-strip precedent: `stripInjectedMemory`,
  `stripMentionContext`, `stripMainChatContext` (App.tsx / agent-commands.ts).
- Turn checkpoints + revert: `turnCheckpoints` / revert path (App.tsx).
- Decision-card precedent: SendPolicyPrompt (AgentDock.tsx).
