---
name: studio-hunt
description: BETA. Deep, evidence-gated opportunity hunt for solo-buildable web apps. Begins with a parallel market-motion observatory, intersects commercial acceleration with paid operational work, and only then invents and falsifies product wedges. Invoke with $studio-hunt, optionally followed by a bias hint.
---

# Studio Hunt (beta)

Find app opportunities the model could not have invented from its prior. The hunt succeeds only when it can defend one of two conclusions:

1. a commercially accelerating behavior is creating a verified, paid operational consequence with plausible white space; or
2. current evidence does not support one, so the correct result is zero promoted ideas.

Every niche, metric, job sentence, and wedge component must trace to harvested evidence. Startup activity is market-direction evidence, not buyer demand. Founder enthusiasm, a high-revenue outlier, or a crowded launch category can never substitute for firsthand work reality.

The former 40–80-page budget applies only as a loose downstream harvest guide. **Phase 0 has no page quota.** It is the make-or-break research program and is bounded by source completion, longitudinal windows, adaptive saturation, API limits, and hard evidence gates.

## Run state and durable snapshots

Read `hunts/*/runlog.md`, `ideas/` (including `_killed/`), `sources/DIRECTORY.md`, and prior `market-motion/` snapshots first. Rotate away from exhausted sources, never re-propose a known idea, and use earlier snapshots to measure change rather than treating a current leaderboard as momentum.

```text
market-motion/
  trustmrr/snapshots/       immutable cross-run snapshots
  trustmrr/deltas/
  hn/snapshots/
  directories/snapshots/
  clusters/                 longitudinal cluster histories

hunts/<YYYY-MM-DD>-<n>/
  state.md
  phase-0/
    intent.json
    schema.json
    queries.jsonl
    discovery.jsonl
    agents/
      commercial-motion/
      formation-feedback/
      buyer-reality/
    pages/<source>/
    normalized.jsonl
    entities.jsonl
    job-sentences.jsonl
    clusters.jsonl
    intersections.jsonl
    rejected-clusters.jsonl
    coverage.json
    directions.md
    gate.md
    runlog.md
  corpus/
  mined.md
  dossier.md
  dossier.html
  runlog.md
```

Checkpoint `state.md` at every phase boundary. Never overwrite historical snapshots.

Read `references/phase0-agent-contract.md` and `references/phase0-record-schema.json` before running Phase 0.

## Phase 0 — Market-motion observatory (make or break)

Phase 0 is the primary discovery engine, not a preliminary sample and not an idea-generation phase. It must produce an evidence-backed market map before downstream hunting begins. If coverage is weak or no qualifying intersection exists, stop successfully with `INSUFFICIENT COVERAGE` or zero survivors; never backfill with generic vendor pages.

### Parallel agent topology

When subagents are available, the parent must run three non-overlapping extraction agents in parallel:

1. **Commercial motion** — TrustMRR, startup-sale markets, public traction/revenue records, product survival, and external enrichment.
2. **Formation and feedback** — Show HN cohorts, Ask HN, launch comments, founder forums, launch directories, persistence, objections, and residue jobs.
3. **Buyer reality** — occupational Reddit/forums, support communities, public jobs/services, paid templates, automation recipes, purchases, frequency, and workarounds.

Agents extract evidence; they do not propose ideas or make the final gate decision. Each writes only inside its assigned `phase-0/agents/<lane>/` directory and returns a compact manifest. Required agent files are `records.jsonl`, `queries.jsonl`, `failures.jsonl`, and `metrics.json`. The parent alone merges, deduplicates, clusters, scores, runs gap fills, and decides the gate.

Do not let agents write the same index, snapshot, or state file. After the first merge, the parent may issue focused gap-fill assignments based on explicit coverage gaps; agents must not invent confirmation searches for their favorite cluster.

If subagents are unavailable, run the same three isolated capsules concurrently where possible and preserve the same artifact contract.

### Brave discovery (broad, aggressive, secret-safe)

Use the Brave Search API broadly for frontier discovery, discussion search, external enrichment, and gap fills. Resolve `BRAVE_API_KEY` in order from `process.env`, workspace-root `.env`, then app-repo `.env`. Load it only inside the collector process, pass it only in the `X-Subscription-Token` header, throttle to the account limit, and never print, serialize, log, interpolate into commands, place in agent prompts, or write it to artifacts.

Use recency windows, `result_filter=discussions`, source-form queries, category/index traversal, and harvested phrases. Do not seed familiar industries. Valid generic discovery forms include:

```text
"What do you use for"
"What do you pay for"
"We built an internal"
"still use a spreadsheet"
"looking for feedback"
"how do you handle"
"what replaced"
"we still export"
```

Brave results are `discovered` leads until the underlying page or structured endpoint is captured and verified. Snippets never receive firsthand, commercial, or triangulation credit.

### Phase 0A — Verified commercial motion

Treat TrustMRR as a longitudinal commercial-motion sensor, not a leaderboard.

- `TRUSTMRR_API_KEY` is separate from `BRAVE_API_KEY`. Never use the Brave key as TrustMRR authentication.
- If `TRUSTMRR_API_KEY` resolves, fully paginate `GET https://trustmrr.com/api/v1/startups`, preserve raw values, respect response rate-limit headers, and fetch details selectively for new, changed, accelerating, declining, or newly-for-sale products plus a rotating baseline.
- If no TrustMRR key resolves, collect verified public TrustMRR profiles and record reduced coverage. Do not claim full-market or full-directory coverage.
- Snapshot weekly and at the start of every hunt. Compare 7-, 30-, 90-, and when available 180-day windows. On the first run label change claims `baseline-unavailable`.
- Retain revenue, MRR, total revenue, customers, active subscriptions, absolute and percentage growth, founding/first-seen dates, rank, traffic/search provenance, revenue per visitor, profit margin, sale status, asking price, founder, audience, channels, and technology when available.
- Preserve raw units. TrustMRR monetary values are cents; test and record any documented request/response growth-unit difference rather than silently converting it.

Use product- and cluster-level deltas: unique founders, entrant velocity, nonzero-revenue breadth, median and trimmed-mean MRR movement, customer/subscription breadth, cohort survival, concentration in the largest product, founder concentration, time to revenue, sale/exit pressure, and external discussion breadth. Require absolute movement alongside percentage growth and separate tiny-revenue cohorts from meaningful revenue bands.

Bias controls are mandatory: TrustMRR is opt-in, payment-provider-verifiable, indie/public-building-skewed, survivor-biased, and unevenly enriched. Founder descriptions are positioning, not buyer-workflow proof. Penalize missingness, founder portfolios, launch studios, renamed domains, tiny-base growth, one-product concentration, and clusters visible only on founder surfaces.

### Phase 0B — HN formation, problems, and residue

Use the official HN Algolia API before search engines:

- `search_by_date?tags=show_hn` for formation, positioning, domains, founders, and persistence.
- `search_by_date?tags=ask_hn` for own problems, purchases, internal tools, workarounds, and replacement searches.
- `search_by_date?tags=comment,story_<ID>` for objections, missing segments, integrations, approval work, exports, trust failures, and manual residue.
- Use `numericFilters=created_at_i>X,created_at_i<Y` and paginate explicitly. Collect recent 30 vs prior 30, recent 90 vs prior 90, and prior-year comparison windows when available.

Preserve story/comment IDs, parent IDs, author, timestamp, points, comment counts, domain, title, story/comment text, and window. Points and comments prioritize inspection but never establish demand. Normalize domains and founder handles so repeated launches do not mimic independent entrants. A launch is supply evidence; it becomes work-reality evidence only when a speaker describes their own workflow, purchase, implementation, or workaround.

### Phase 0C — Reddit, forums, and buyer language

Use Brave discussion discovery with harvested phrases and site/community filters. Hydrate Reddit leads in this order:

1. thread `.json`;
2. `old.reddit.com` or subreddit search JSON;
3. logged-in visible browser;
4. an authorized alternate copy or quoted primary discussion;
5. discovered-only status with no triangulation credit.

Do not retry challenge pages. Record status, content classification, and fallback. For other forums prefer native JSON/RSS APIs, then public pages, then the visible browser.

Keep founder and occupational communities separate. Founder posts reveal formation, positioning, and distribution attempts. Buyer/operator and service-provider voices reveal actual work and spending. A founder pitch is never demand evidence, although a buyer response inside that thread may qualify independently.

Every post/comment needs evidence-backed `actorType` and `statementType`; prefer `unknown` to invented precision. Firsthand is true only for the speaker's own purchase, workflow, implementation, or workaround.

### Structured records and independence

Every normalized record must retain provenance, verbatim evidence, verification status, actor/statement classification, product/startup identity, commercial metric and period, buyer, trigger, input, repeated action, output, destination, frequency, time, price/wage, current tools, remaining manual work, caveats, and artifact path.

Set an `independenceKey` from normalized domain + actor/author + product/founder ecosystem + originating dataset. Cross-posts, syndicated launches, copied reviews, one founder's portfolio, and multiple records from one product cannot masquerade as independent corroboration.

### Coverage floors and adaptive stopping

Phase 0 has no low ceiling. A credible first pass normally includes at least:

- 75 verified commercial-motion startup observations across multiple clusters;
- 100 formation/feedback records including comments, not launch titles alone;
- 75 buyer-reality records;
- 25 exact-money observations;
- 25 firsthand repeated-workflow observations;
- 15 source domains;
- no single domain providing more than 20% of a qualifying cluster's core evidence.

These are diagnostic floors, not completion targets. Hundreds of launches with no buyer/operator evidence still fail.

Continue collecting while a new independent batch materially changes top-cluster ordering or more than 20% of promising clusters lack a required evidence side. Stop only after two consecutive independent batches produce all of:

- less than 5% new qualified job sentences;
- no new top-tier cluster;
- less than 10% movement in top-cluster scores;
- no resolution of a material evidence gap.

Use time/API-call ceilings only as emergency controls and report them. If a critical lane is blocked, record missing coverage; never compensate with vendor pages.

### Two independent cluster systems

Build these separately before intersection:

**Market-motion signature**

```text
buyer + new product/job vocabulary + platform/catalyst + commercial outcome
```

**Work-reality job sentence**

```text
buyer + trigger + input + repeated action + output + destination
```

Semantic or lexical similarity may suggest joins, but the parent must validate concrete fields and quotes. Shared nouns such as `AI`, `inventory`, `marketing`, or `compliance` are insufficient.

### Intersection contract

A cluster can direct later research only with:

- three independent domains and at least two actor types;
- two independent products/startups demonstrating motion;
- one verified commercial metric;
- two firsthand work-reality records;
- one exact-job money observation;
- a structural catalyst or measurable longitudinal acceleration;
- a traceable job sentence;
- no more than one vendor-authored core source;
- a plausible solo-accessible buyer channel.

Founder feedback remains market-supply evidence unless a buyer/operator supplies their own workflow, purchase, or workaround.

### Explosion Potential scoring

Keep raw inputs and transparent 0–100 subscales:

```text
Explosion Potential =
  0.35 * Market Motion
+ 0.35 * Work Reality
+ 0.20 * White Space
+ 0.10 * Structural Catalyst
- penalties
```

Market Motion measures formation acceleration, breadth of verified revenue/customer growth, survival, discussion acceleration, founder breadth, monetization efficiency, and catalyst strength. Work Reality measures firsthand repeated work, exact-job spend, burden/frequency, workaround adoption, cross-source residue, buyer reachability, and concrete artifacts. White Space measures repeated missing segments, fragmented workflows, incumbent dissatisfaction, dedicated-product density, attainable data, solo-buildability, and distribution.

Apply cumulative penalties for a dominant outlier (-10), founder echo chamber (-10), clone saturation (-15), revocable single-platform dependency (-10 to -20), mature funded incumbents without a demonstrated gap (-20), procurement-heavy buyers (-15), launch growth without customer breadth (-10), and declining survival/high sale pressure (-10). One extraordinary MRR value can never compensate for missing work reality.

### Hard Phase 0 gate

Classify every intersection:

- `GO` — Explosion Potential >=70, Market Motion >=65, Work Reality >=65, White Space >=55, all intersection requirements pass, no fatal dependency/sellability failure, confidence B or better.
- `WATCH` — score 55–69 or one remediable evidence gap; preserve longitudinally.
- `NO-GO` — weak, saturated, non-independent, or structurally unsuitable.
- `INSUFFICIENT COVERAGE` — source access/extraction prevents a defensible conclusion.

The hunt continues only when at least one `GO` exists. Otherwise stop successfully, retain `WATCH` clusters, and promote nothing. Never weaken thresholds to keep the pipeline moving.

`phase-0/directions.md` must list accelerating commercial clusters, early-formation clusters, launch-heavy/revenue-light clusters, saturated/declining clusters, operational-residue hypotheses, evidence gaps, and exact downstream research directives. Phase 0 produces directions, not app ideas.

## Phase 1 — Deepen purchased jobs

Research only the job sentences and evidence gaps attached to Phase 0 `GO` directions. Do not rediscover arbitrary niches.

Collect exact-job spend, repeated workflows, paid workarounds, complaint exhaust, incumbent weakness, and catalysts. Browse job/service/template/category indexes and then use harvested actor and job language for focused demand passes. Vendor pricing is adjacent spend unless evidence shows the buyer pays for the exact job.

Classify artifacts as verified, discovered, blocked, thin, duplicate, or stale. Verified content still needs evidence-quality classification; page length alone is not signal.

Require at least three independent actor/source combinations: someone doing or buying the work, someone describing pain or residue, and someone selling a workaround/service. Require firsthand buyer pain and exact-job money. Do not count one product ecosystem as several lanes.

Use batched Node capsules for public APIs/repeated extraction and the artifact-first workflow for pages. Save artifacts first; inspect with targeted `rg -n -i -C` and narrow reads. Never dump full corpora into context.

## Phase 2 — Invent positions from operational exhaust

Only now may the model derive product positions from each qualified job:

- enabler;
- intermediary/operator layer;
- interoperability layer;
- trust/quality layer;
- measurement layer;
- post-adoption consequence;
- approval, reconciliation, audit, or migration residue.

Every element of the proposed job sentence must trace to Phase 0/1 evidence. Reject core-category clones unless evidence identifies a concrete underserved segment. Record candidates, supporting record IDs, independence keys, exact money, and unresolved risks in `mined.md`.

Each candidate carries:

```text
phase0_provenance:
  intersection_id
  score_version
  supporting_record_ids
  snapshot_dates
  catalyst
  job_sentence
  unresolved_risks
```

## Phase 3 — Kill-biased falsification

For each candidate, actively try to kill it:

- **Incumbent saturation:** funded + shipping + liked means KILL unless a verified gap remains.
- **Why now:** no concrete shock, acceleration, vacuum, or newly feasible capability means KILL.
- **Web-app gate:** one person can ship v1 in <=4 weeks; no day-one liquidity/network effects; required data is reachable without a fatal revocable dependency.
- **Sellability:** name the buyer and realistic solo channel. Procurement/security-heavy institutional buying means KILL unless a prosumer intermediary is the customer.
- **Independence audit:** duplicated actors, domains, ecosystems, or founder portfolios do not count separately.
- **Quantification:** use only artifact-sourced numbers; `unquantified` beats invention.

Every kill gets a one-line epitaph. Direct competitor checks occur once cheaply after Phase 0 clustering and again deeply here; do not waste downstream research on obvious saturated categories.

## Phase 4 — Dossier and promotion

Create `dossier.md` and self-contained `dossier.html` with zero or more survivors. Each card includes: sharp name, killer firsthand quote, quantified market motion, exact-job money, incumbent gap, two-sentence v1, first-100-users channel, why now, Phase 0 provenance, confidence, and the fact that would kill it.

Include rejected candidates, WATCH directions, lane/source coverage, comparison windows, blocked sources, and what was not covered. Open `dossier.html` in a browser tab.

Promote only confidence B or better to `ideas/<slug>/idea.md` with `status: seed` and a hunt pointer. B-/C ideas remain validation leads; never promote them to satisfy an output count. All promoted seeds still require `$studio-validate` before build.

In chat, show a compact survivor table, rejected count, WATCH count, and the most surprising directional finding. A zero-survivor result is valid.

## Calibration duty

Update `sources/DIRECTORY.md` after the run. Yield is:

```text
records captured -> qualified job clusters -> research directives -> candidates -> survivors
```

Track verified signal density, actor diversity, independence, blocked lanes, and which sources changed the Phase 0 gate. Flag three consecutive zero-yield runs for pruning. Add frontier sources that create a qualified cluster.

End `runlog.md` with honest notes on market-motion coverage, signal per source, failed extraction, budget/rate limits, scoring sensitivity, false joins, and proposed skill changes. If app-level friction blocks a critical source, emit an `app-improvement` block.
