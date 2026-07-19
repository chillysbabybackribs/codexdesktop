# Bleeding-Edge Scan — where this workstation stands vs. the 2025–2026 frontier

> Deep-research pass, 2026-07-19. 5 search angles → 25 sources fetched → 125 claims
> extracted → top 25 adversarially verified (3-vote, 2/3 to kill) → 24 confirmed, 1
> refuted, synthesized to 8 findings. Sources span Nov 2025–Feb 2026. This doc is a
> dated snapshot of a fast-moving field; treat citations as of that window.

## One-paragraph verdict

The frontier **validates this product's core bets and exposes one urgent gap.** The
core doer/reviewer supervision stack is not just sound — it is now *production-validated
by peer-reviewed work we hadn't seen* (Meta's Wink). Crystallization, which we designed
from first principles, turns out to have two direct academic precedents (AgentRR, ASI)
that hand us vocabulary, a verification recipe, and a benchmark. Raw CDP browser control
has become a Google-shipped commodity — confirming the browser must differentiate
exactly where it already does (logged-in identity, coverage snapshots, anti-fingerprint,
Tor). The one genuine hole: **security for the logged-in browser must be enforced in the
execution/network layer, not by the model** — and the planned request-interception layer
is the right place to build it, but it should be scoped as security infrastructure, not
a routing convenience.

---

## Bucket 1 — Fundamentally must-have, we lack it (ranked by leverage)

### #1 — Execution-layer browser security (reframe the planned interception layer as security infra) · HIGH confidence, 3-0

**The finding.** LLM-level prompt-injection defenses only *reduce* attack probability;
they never eliminate attack classes. The joint OpenAI/Anthropic/DeepMind study "The
Attacker Moves Second" bypassed twelve published detection/separation defenses — ones
reporting near-zero attack success — at >90% under adaptive attack. And this product
category is *already exploited in the wild*: Brave demonstrated indirect prompt injection
against Perplexity's Comet browser via invisible page content (white-on-white text, HTML
comments, spoiler tags), driving authenticated cross-site actions including reading a
Gmail OTP and exfiltrating it.

**Why it matters for us specifically.** Our single biggest differentiator — the
logged-in-as-the-user browser — is *precisely the exposed surface* in that exploit. We
currently have no execution-layer containment; safety is prompt-level only.

**The concrete pattern (maps onto the roadmap's interception item).** The security paper
names two mechanisms: (1) strict **per-agent-role physical domain allowlisting** — an
agent scoped to one workflow can only reach that workflow's domains; (2) execution-layer
**blocking of sensitive-keyword actions** ("refund", "delete", "transfer", "password")
pending explicit confirmation. This is exactly the "verdict-gated irreversible actions at
the network layer" idea from our own interception discussion — the research says build it
as security, not speed.

Sources: [arxiv 2511.19477](https://arxiv.org/html/2511.19477v1) ·
[Brave/Comet disclosure](https://brave.com/blog/comet-prompt-injection/) ·
[The Attacker Moves Second, arxiv 2510.09023](https://arxiv.org/abs/2510.09023)

*Caveat: 2511.19477 is a solo-practitioner preprint; every load-bearing point is
corroborated by peer-reviewed / first-party sources. Comet's specific mitigations have
already been through a disputed fix cycle — the attack/defense balance moves monthly.*

### #2 — Give the completion auditor tools (run tests/linters, screenshot), don't just read diffs · HIGH confidence, mostly 3-0

**The finding.** The field has moved from single-pass "LLM-as-Judge" to
"**Agent-as-a-Judge**": judges that plan, use tools, and inspect the actual artifact,
because a single-pass judge cannot verify its assessment against real observations. The
number that matters: an agentic judge inspecting the real workspace hit **90.4%/92.1%
alignment with human consensus vs 60.4%/70.8% for LLM-as-Judge** on OpenHands outputs —
and a judge given the *full trajectory* still trailed workspace-inspection by ~21 points.
That is direct evidence that **reading conversation + diff alone is insufficient.**

**Why it matters for us.** Our completion audit is diff-grounded — genuinely better than
transcript-only, but it sits at the *weaker* end of this spectrum. Named extensions from
the surveys (CodeVisionary): let the auditor **run code, static linters, and unit tests,
and capture screenshots / browse** as audit evidence. We already have the substrate for
this — the auditor shares the workspace and has shell + browser tools; the audit briefing
just doesn't yet *instruct* it to run them. This is a briefing-contract upgrade, not new
infrastructure — the highest-ROI cheap win in the report.

Sources: [Agent-as-Judge survey, arxiv 2601.05111](https://arxiv.org/abs/2601.05111) ·
[Agent-as-a-Judge, arxiv 2410.10934](https://arxiv.org/abs/2410.10934) ·
[CodeVisionary, arxiv 2504.13472](https://arxiv.org/abs/2504.13472)

*Caveat: the 90/60 numbers carried one 2-1 vote — the LLM baseline also saw the
workspace, so the measured effect is specifically* active inspection*, not mere access.*

---

## Bucket 2 — We already have this (or better); several now externally validated

### #3 — The mid-turn watchdog is production-validated by Meta's Wink (peer-reviewed) · HIGH, 3-0

We built the watchdog from an intuition. Meta's **Wink** paper (ACM AIware 2026) validates
it at production scale: misbehaviors (specification drift, reasoning problems, tool-call
failures) occur in **~30% of production coding-agent trajectories** (29.2% of 42,920 over
five weeks). Their watchdog recovered **90.9% of single-intervention misbehaviors**; a
15-day 50/50 A/B test showed statistically significant drops in tool-call failures
(−4.2%, p=0.0096), tokens/session (−5.3%, p=0.003), and engineer interventions/session
(−4.2%, p=0.014). Their mechanism mirrors ours almost exactly: an **asynchronous
off-critical-path observer invoked every k=5 steps**, injecting plain-text DO/DONT
guidance into the conversation inside `system-reminder` XML tags. This independently
validates our cadence (we gate on ≥5 steps) and our steer-injection channel. *Actionable
crib:* their DO/DONT structured format and every-k-steps trigger are worth adopting over
our looser prose briefing.

Sources: [Wink, arxiv 2602.17037](https://arxiv.org/pdf/2602.17037) ·
[ACM AIware 2026](https://dl.acm.org/doi/10.1145/3805760.3814911)

### #4 — Crystallization has direct prior art: AgentRR (record→summarize→replay + check-function TCB) · HIGH, 3-0

The pattern we called "crystallization" is formalized as **AgentRR** (SJTU IPADS, May
2025): record a trace → summarize into multi-level "experience" → replay to guide future
similar tasks. It independently specifies the two mechanisms we arrived at: (1)
**multi-level abstraction with escalation-on-failure** — replay the most concrete/fastest
experience that still works, fall back to higher abstractions needing stronger models
when it breaks, including a large-records/small-replays collaboration mode (our
"frontier records, cheap replays" economics); (2) **"check functions" as a trusted
computing base** validating execution-flow integrity, state preconditions, and safety
invariants — our "assertion checkpoints." We now have vocabulary and a design reference.

Source: [AgentRR, arxiv 2505.17716](https://arxiv.org/html/2505.17716v1)

### #5 — Crystallization has an empirical recipe + benchmark: ASI (CMU, COLM 2025) · HIGH, 3-0 on result

**ASI** compiles successful web-agent trajectories into executable **Python skill
functions**, admitting them to the library only after **execution-based verification**
(neural-eval task correctness + at least one new-skill call + every call causing an env
change). The "code vs text" answer we needed: programmatic skills beat text-based skill
memory (AWM) by **11.3% relative success (40.4% vs 36.3%)** on WebArena while cutting
solution steps 15.3% — gain attributed mainly to the induction-time verification
guarantee. This is the closest published recipe to "compile to deterministic scripts with
assertion checkpoints," and gives crystallization a benchmarkable baseline.

Source: [ASI, arxiv 2504.06821](https://arxiv.org/html/2504.06821v1)

### #8 — Raw CDP browser control is now a Google commodity; our moat is confirmed to be elsewhere · HIGH, 3-0

Google's Chrome DevTools team ships an official **chrome-devtools-mcp** (v1.6.0, Jul 2026,
20+ integrated clients incl. Antigravity, Claude, Cursor, Copilot). Decisively: Google's
own guidance **disclaims the logged-in/sensitive-data use case** — it "exposes content of
the browser instance to the MCP clients," users are told not to share sensitive info, and
Chrome blocks attaching the debug port to the default profile. So the commodity stack
*structurally avoids* exactly what we do: **in-process logged-in identity, coverage-contract
snapshots, anti-fingerprint, Tor lane, citation-grounded research runner.** Raw CDP
driving is no longer a moat; our specific browser choices still are. *(One adjacent claim —
that WebDriver login-refusal is itself evidence for our approach — was refuted 0-3 and
must not be reused.)*

Sources: [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) ·
[Chrome DevTools blog](https://developer.chrome.com/blog/chrome-devtools-mcp)

---

## Bucket 3 — Emerging; watch, don't build yet

### #6 — Learned step-level verifiers (process reward models) beat prompted judges per token · HIGH, 3-0

**AgentPRM** (WWW 2026) scores agent actions by "promise"/progress rather than per-step
correctness, reports >8× compute-efficiency over verification baselines, and steers
running agents mid-trajectory via PRM-scored beam search — a *learned* analog of our
watchdog. **ThinkPRM** (TMLR 2026), fine-tuned on ~1% of PRM800K labels, beats same-base
LLM-as-Judge by 7.2% under equal token budget. **Why watch, not build:** these are
benchmark results on math/web tasks with small open models — not production code review
with frontier judges. But they mark where the reviewer stack's *economics* will move: our
prompted reviewer is not the per-dollar ceiling.

Sources: [AgentPRM, arxiv 2511.08325](https://arxiv.org/abs/2511.08325) ·
[ThinkPRM, arxiv 2504.16828](https://arxiv.org/abs/2504.16828)

### #7 — Supporting signal: math-trained PRMs transfer to code · MEDIUM, 3-0

An AAAI study found math-trained PRMs perform comparably to code-specific PRMs on
HumanEval+/MBPP+/LiveCodeBench/BigCodeBench (e.g., 91.5 vs 89.0 on HumanEval+), lowering
the eventual adoption cost of the learned-verifier direction — off-the-shelf verifiers may
apply to coding without domain-specific training. Reinforces #6's "watch" status.

Source: [arxiv 2506.00027](https://arxiv.org/abs/2506.00027)

---

## Honest coverage gaps (what this scan did NOT establish)

- **Agent identity / delegated auth / payments standards (research angle d): zero claims
  survived.** Google AP2, Web Bot Auth / IETF drafts, agent-scoped OAuth — either not
  surfaced or failed verification. The report is **silent, not negative**, here. This is
  the biggest hole in our own knowledge and directly relevant to the "delegated, not
  covert" account/payments direction we discussed — it deserves its own targeted pass.
- **Agent memory / context-management advances (angle f):** also thin — no durable claims.
- The **learned-verifier per-token advantage on *code review* specifically** (vs math with
  small models) is unproven — the key open question before acting on #6.

## Suggested next actions (from the evidence, not hype)

1. **Cheap win now:** upgrade the audit briefing to instruct the auditor to run
   tests/linters and (for UI/browser work) screenshot — Bucket-1 #2, pure prompt change on
   existing tools.
2. **Watchdog crib:** adopt Wink's DO/DONT structured guidance format and confirm our k=5
   cadence against theirs — #3, small.
3. **Reframe the interception build** as execution-layer security (per-role domain
   allowlist + sensitive-action gate), not routing — #1, the roadmap item that just became
   urgent.
4. **When crystallization starts:** use AgentRR's check-function TCB framing and ASI's
   execution-verified induction as the design spec + benchmark — #4/#5.
5. **Commission a focused follow-up** on agent-identity/auth/payment standards — the one
   area this scan left blank.
