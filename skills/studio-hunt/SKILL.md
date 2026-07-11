---
name: studio-hunt
description: BETA. Deep, vertical-agnostic opportunity hunt for solo-buildable web apps. Harvests a multi-lane web corpus (complaints, spend, paid workarounds, weak incumbents, why-now shocks), mines it with scripts, kills candidates through a falsification gauntlet, and delivers a dossier of triangulated opportunity cards. Invoke with $studio-hunt, optionally followed by a bias hint (a niche, audience, or lane to overweight).
---

# Studio Hunt (beta)

Find app opportunities the model could NOT have invented from its prior. Every niche, candidate, and number must be traceable to a harvested page. The output is a small set of survivors that each answer: what's the pain, who pays today, why is the incumbent beatable, why now, and what's the two-sentence v1 web app.

Beta budgets are deliberately capped: ~40–80 corpus pages, 8–14 candidates into the gauntlet, 3–6 survivors, target ~20 minutes. Note actual counts in the run log.

## Run state (checkpoint everything)

Work in the current workspace under `hunts/<YYYY-MM-DD>-<n>/`:

```text
state.md         phase checkpoint + decisions; update at each phase boundary so an interrupted run resumes
corpus/          harvested artifacts (or pointers to research_web artifact paths)
mined.md         candidate clusters with source references
dossier.md       final report
dossier.html     same report as a self-contained HTML page
runlog.md        lanes swept, sources that were rich vs. dead, calibration notes for the next run
```

Read `hunts/*/runlog.md` and `ideas/` (including `_killed/`) first: rotate away from lanes/sources already mined, and never re-propose a known idea.

## Phase 1 — Harvest (wide, dumb, cheap; NO judging)

Sweep five signal lanes. Collect pages into artifacts without evaluating them — judgment during harvest reintroduces the model's prior bias.

1. **Demand exhaust** — complaint threads, 1–3★ reviews of PAID tools, incumbents' own support forums.
2. **Spend evidence** — Upwork/Fiverr gig listings for repetitive digital work, "virtual assistant" job posts describing browser/spreadsheet routines, tool pricing pages.
3. **Workaround evidence** (highest signal, least mined) — spreadsheet/Notion/Airtable template bestsellers on Etsy and Gumroad with visible sales or review counts, popular Zapier/Make recipes, high-view "how to do X in Google Sheets" tutorials.
4. **Incumbent weakness** — tools with live complaint traffic but no updates in 18+ months, acquired-and-neglected products, price-hike backlash threads, shutdown/sunset announcements.
5. **Why-now shocks** — platform/API policy changes, compliance deadlines, fast-growing platforms whose sellers/creators lack tooling.

Vertical-agnosticism rule: niches are HARVESTED, not generated. Lanes 2 and 3 are the niche discoverers — browse their category/bestseller indexes and let each listing point at a niche. If the user gave a bias hint, overweight it in queries but still sweep all lanes.

Source tactics (learned from prior runs): Reddit renders thin for plain fetches — hit `old.reddit.com` or the thread's `.json` endpoint from capsule scripts. Diversify the workaround lane beyond Etsy: Gumroad, Notion and Airtable template galleries, Creative Market, Google Sheets template roundups. Reserve 8–10 pages of the budget for a SECOND demand pass — first-person complaints inside the niches lanes 2/3 surface — instead of front-loading generic complaint searches. Classify every artifact as **verified** (content captured) or **discovered** (URL/snippet known but page blocked or unfetched); discovered evidence never counts toward triangulation — record it in `mined.md` as leads only.

Execution: push I/O into one or two batched capsule scripts (see the artifact-first-web-research skill): a Node script that fetches public pages with 10–15-way concurrency via plain HTTPS, uses hidden browser work through `CODEX_BROWSER_SOCK` only for JS-heavy or logged-in pages, writes each page's cleaned text to `corpus/`, and prints a one-line JSON envelope (counts, failures, paths). Use `research_web` for SERP discovery of lane sources. Do not fetch pages one tool-call at a time.

## Phase 2 — Mine (scripts, not vibes)

Run scripts over `corpus/` to surface mechanical patterns: dollar amounts, dates, sales counts, recurring noun phrases, and co-occurrences ACROSS lanes. A candidate is born from an intersection — e.g., an Upwork gig cluster + a matching complaint cluster + a template with sales — never from a single loud thread. Record each candidate in `mined.md` with its supporting artifact paths and which lanes it draws from.

Hard rule: a candidate needs **verified** signals from **at least 3 of the 5 lanes**, including **at least one verified money artifact** — a real price with evidence people pay it (sales counts, review counts on a paid product, a signed quote range). Lane count without evidence strength is not triangulation; a $4 template with 7 reviews does not anchor a candidate. List 2-lane near-misses at the bottom of `mined.md` as future-run leads.

## Phase 3 — Gauntlet (kill-biased falsification)

For each candidate, actively try to kill it:

- **Incumbent scan** (one targeted search): who already does this? Funded + shipping + liked ⇒ KILL unless the corpus shows a specific exploitable weakness (hated pricing, abandoned, missing segment).
- **Why-now / why-not-already**: name the concrete reason this is newly winnable (shock, vacuum, newly-AI-feasible, underserved segment). No reason ⇒ KILL.
- **Web-app gate**: browser-deliverable, one person can ship v1 in ≤4 weeks, no marketplace liquidity or network effects on day one, required data reachable without a revocable single-point API dependency. Fail any ⇒ KILL.
- **Sellability gate**: name the specific buyer and a realistic solo-dev sales path to them. Institutional buyers with procurement, vendor-security review, or compliance sign-off (banks, insurers, hospitals, enterprises) ⇒ KILL, unless the actual purchaser is an intermediary who buys like a prosumer (consultants, fractional officers, bookkeepers) — and then the card must name that intermediary as the customer.
- **Quantification pass**: attach only numbers that exist in artifacts (thread counts, review counts, sales counts, prices, dates). "Unquantified" is an acceptable value; an invented number is never acceptable.

Expect most candidates to die. Every kill gets a one-line epitaph — the rejected list is part of the product.

## Phase 4 — Dossier

`dossier.md` + `dossier.html` (self-contained, inline CSS, readable) with:

1. **Opportunity cards** (3–6), each: sharp name · the single killer verbatim quote with link · quantified demand (artifact-sourced) · the money row (what people pay today, for what) · incumbent + its specific weakness · the v1 wedge in two sentences · first-100-users channel · why-now · confidence grade + the single fact that would kill it.
2. **Rejected candidates** — every gauntlet death, one line + reason.
3. **Coverage note** — lanes swept, page counts, what was NOT covered (no silent truncation).

Open `dossier.html` in a browser tab for the user. Promote each survivor into the pipeline as `ideas/<slug>/idea.md` with `status: seed` and a pointer back to the hunt (they still owe a full `$studio-validate` before any build).

In chat: one compact table of survivors (name, one-liner, strongest number, confidence), the rejected count, and anything surprising from the run. The dossier holds the detail.

## Beta calibration duty

This skill is under test. End `runlog.md` with honest notes: which lanes produced signal per page fetched, which sources were dead weight, where budgets pinched, what you would change in this SKILL.md. If app-level friction blocked you (tool defaults, missing capability), emit an `app-improvement` block.
