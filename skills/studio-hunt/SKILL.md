---
name: studio-hunt
description: Creative, evidence-informed opportunity hunt for solo-buildable web apps. Uses current market motion, buyer behavior, and operational friction as creative material; generates many wedges early, reality-checks them quickly, and ranks the strongest for later validation. Invoke with $studio-hunt, optionally followed by a bias hint.
---

# Studio Hunt

Find surprising, useful web-app opportunities that a solo builder could plausibly ship and distribute. The hunt is a creative discovery workflow, not a validation study.

Evidence should improve the model's imagination, expose real language and changing behavior, and prevent obvious fantasy. It is not paperwork an idea must complete before it may be considered. Generate ideas early, make reasonable inferences explicit, and reserve rigorous demand validation for `$studio-validate`.

A successful hunt normally returns:

- a compact map of interesting market movements and recurring work;
- 10–20 distinct product wedges;
- lightweight reality checks on the most promising wedges;
- 3–5 ranked finalists, including at most one high-upside wildcard when warranted;
- honest evidence labels and clear next validation questions.

Zero finalists is allowed when the available material is genuinely barren, but lack of exhaustive coverage is not itself a reason to return zero.

## Run state

Read recent `hunts/*/runlog.md`, `ideas/` (including `_killed/`), `sources/DIRECTORY.md`, and relevant `market-motion/` snapshots first. Avoid repeating known ideas unless new evidence materially changes the wedge. Treat previous source exhaustion and failed extraction as routing hints, not permanent prohibitions.

Use a lightweight durable structure:

```text
hunts/<YYYY-MM-DD>-<n>/
  state.md
  discovery/
    intent.json
    agents/<lane>/
    signals.jsonl
    source-notes.md
  candidates.md
  reality-checks.md
  dossier.md
  dossier.html
  runlog.md
```

Existing `phase-0/` layouts remain valid for backward compatibility. Never overwrite historical snapshots. Read `references/phase0-agent-contract.md` and `references/phase0-record-schema.json` when using extraction agents.

## Phase 1 — Creative discovery

Collect a varied but bounded sample of current signals. Look for changes, awkward work, new responsibilities, workaround residue, pricing shocks, platform shifts, regulation, new capabilities, abandoned niches, and underserved user groups.

Useful lanes include:

1. **Market motion** — new or growing products, startup sales, category formation, pricing changes, and adoption shifts.
2. **Buyer and operator reality** — repeated tasks, spreadsheets, exports, handoffs, reconciliation, approvals, services, templates, and complaints.
3. **Catalysts and edge cases** — regulation, platform changes, newly feasible automation, incumbent retreat, demographic change, and unusual specialist workflows.

When subagents are available, run lanes in parallel. Agents may suggest candidate themes and rough wedges as long as they label inference separately from sourced facts. They must not promote ideas or fabricate evidence.

Merge early after a modest first batch. Use the strongest vocabulary and surprises to direct one focused follow-up pass. Do not collect hundreds of generic records before attempting synthesis.

### Source handling

- Prefer primary discussions, structured endpoints, public records, job/service listings, and product pages with concrete details.
- Search snippets are leads, not quotations or firsthand proof.
- Keep founder claims, buyer reports, and the model's inference distinguishable.
- Preserve a URL, short excerpt or metric, observed date, and source type for evidence used in finalists.
- Deduplicate obvious cross-posts and founder portfolios.
- Do not require a particular source, complete directory pagination, global coverage percentage, or longitudinal baseline.
- When a source is blocked, move on unless it is uniquely important to a finalist.

TrustMRR, HN, Reddit, directories, forums, support communities, services, templates, and job boards are optional sensors. Use the sources that are productive for the current hunt rather than satisfying a fixed source checklist.

### Adaptive stopping

Stop broad discovery when either:

- the first pass plus one focused follow-up has produced enough material for at least 10 meaningfully different wedges; or
- two successive searches add no new mechanism, buyer, or distribution angle.

Time and API budgets are normal controls, not emergency-only failures. Record meaningful blind spots, then continue creatively with the evidence available.

## Phase 2 — Generate wedges early

Generate 10–20 candidates from the collected signals. Combine evidence with explicit inference. Do not require a complete job sentence, exact spending observation, multiple startups, or three-domain corroboration before generating a candidate.

Explore several position types:

- a narrow workflow tool;
- an exception, approval, reconciliation, or audit layer;
- an interoperability or migration utility;
- a trust, quality, or verification layer;
- a measurement or reporting product;
- a post-adoption consequence of a growing platform or behavior;
- a prosumer tool carved out of institutional work;
- a service-to-software transition;
- a small-data or local-first alternative;
- an underserved-role or edge-case adaptation.

For each candidate record:

```text
name
user
problem or opportunity
two-sentence product
why now
source signals
creative leap
likely acquisition channel
main risk
evidence label
```

Use one of these evidence labels:

- `evidence-backed` — multiple concrete signals directly support the user and problem;
- `plausible` — grounded in at least one concrete signal with a meaningful but reasonable inference;
- `wildcard` — a larger creative leap with a coherent mechanism and testable premise.

Wildcards are welcome in the candidate pool. Promote at most one wildcard to the final ranking, and only when its upside and cheap first test are unusually compelling.

## Phase 3 — Lightweight reality checks

Shortlist roughly 6–10 candidates and perform cheap checks. The goal is comparative judgment, not proof.

Check:

- **User:** Can a specific user be named?
- **Pain or pull:** Is there a repeated annoyance, desired outcome, or behavioral change?
- **Buildability:** Could one strong builder ship a useful first version in roughly 2–6 weeks?
- **Reachability:** Is there at least one believable way to reach the first 100 users?
- **Differentiation:** Is the wedge more specific than an obvious commodity clone?
- **Dependency:** Is there an immediate fatal data, platform, legal, liquidity, or network-effect dependency?
- **Competition:** Does a quick search reveal that the exact wedge is already comprehensively served?

Only the following are hard kills:

- no identifiable user;
- no coherent problem, pull, or changing behavior;
- clearly infeasible for a solo web-app v1;
- no plausible user-acquisition route;
- an obvious undifferentiated clone;
- an immediate fatal dependency or legal obstacle.

Everything else affects ranking rather than eligibility. Missing exact-money data, incomplete workflows, uncertain market size, a first-run baseline, or limited source coverage are validation questions—not hunt failures.

Do not deeply investigate every candidate. Spend most follow-up effort on facts that could change the top-five ordering.

## Phase 4 — Rank and present

Rank 3–5 finalists using editorial judgment supported by a simple scorecard. Suggested dimensions are user pain/pull, distinctiveness, buildability, reachability, timing, and upside. Scores aid comparison; they never override a clear qualitative judgment and are not hard gates.

Each finalist includes:

- sharp name and one-line thesis;
- target user and triggering situation;
- two-sentence v1;
- the strongest source signals;
- the creative leap from signal to product;
- first-100-users channel;
- why it could work now;
- evidence label and confidence;
- biggest risk;
- cheapest validation test.

Create `dossier.md` and a readable self-contained `dossier.html`. Include the full candidate list, concise rejection reasons, sources used, blind spots, and which findings most influenced the ranking. Open `dossier.html` in a browser tab.

Promote finalists to `ideas/<slug>/idea.md` with `status: seed` and a hunt pointer unless they duplicate an existing idea. Promotion means “worth validating,” not “validated.” Every promoted seed still goes through `$studio-validate` before build.

In chat, show the finalist ranking, candidate and rejection counts, the strongest wildcard, and the most surprising market signal.

## Calibration

Update `sources/DIRECTORY.md` with sources that were unusually productive or wasteful. End `runlog.md` with:

- signals collected;
- candidates generated;
- finalists promoted;
- productive and failed sources;
- creative leaps that worked or felt forced;
- scoring sensitivity and blind spots;
- proposed improvements to the skill.

The principal success metric is not corpus size or gate pass rate. It is whether the hunt produces novel, understandable, solo-buildable ideas that are worth spending a separate validation run on.
