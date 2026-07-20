---
name: studio-scout
description: Mine logged-in communities, marketplaces, and review sites for recurring pain points worth building an app around. Produces deduplicated idea seed files with verbatim evidence in the workspace ideas/ pipeline. Invoke with $studio-scout, optionally followed by a niche or source to focus on.
---

# Studio Scout

Hunt for **pain, not ideas**. An idea seed is only worth recording when real people repeatedly describe the same problem, and at least one signal suggests they would pay to make it go away.

## Pipeline spine

Operate on the current workspace. Initialize if missing:

```text
ideas/<slug>/idea.md      one seed per problem, slug is short-kebab
ideas/_killed/            killed ideas move here (never delete; they are anti-duplication memory)
```

Before writing any seed, `grep` existing `ideas/*/idea.md` (including `_killed/`) for overlapping keywords. Update an existing seed with new evidence rather than creating a near-duplicate.

## Where to look

Prefer sources the embedded browser is logged into — that is this system's edge over generic research:

- Complaint-rich communities: subreddits for the niche, Hacker News, X/Twitter searches, niche Discourse/forums.
- Money-adjacent surfaces: app-store and Chrome-store reviews of paid tools (1–3 star reviews of a *paid* product are pre-validated demand), G2/Capterra gripes, Upwork/Fiverr job posts describing repetitive manual work.
- Search phrases that mark unmet demand: "is there a tool that", "I wish there was", "why is there no", "how do I automate", "spreadsheet to do X".

Use `browser_live_search` with `background: true` for public discovery (live verification plus artifact-first background evidence; author short single-angle queries). Behind auth, read with `browser_snapshot` on the visible logged-in tab, interact with `browser_flow`, and reserve `browser_run` for bespoke extraction. Reuse open tabs; do not open tab bursts.

## What qualifies as a seed

Record a seed only when you have:

1. **Recurrence** — the same complaint from 3+ distinct people, at least one within the last 90 days.
2. **A payability signal** — people already pay for a bad alternative, pay a human to do it, or describe hours of recurring manual work.
3. **Solo-buildable shape** — plausibly shippable by one person; no marketplace liquidity or network effects required on day one.

## Seed format

`ideas/<slug>/idea.md`:

```markdown
---
status: seed
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
score: <pain 1-5>/<frequency 1-5>/<payability 1-5>
---

# <Problem statement in one sentence, from the sufferer's point of view>

## Evidence
- "<verbatim quote>" — <source URL> (<date>)
- ...3-8 items, verbatim, linked. Cite saved research artifact paths where used.

## Who pays
<the specific person/role and what they pay today (tool, human, or hours)>

## Sketch
<2-4 sentences: smallest product that removes the pain; obvious distribution channel>
```

## Budget and stopping

- One `browser_live_search` pass with `background: true` (3–6 short single-angle queries) plus bounded logged-in browsing. At most one gap-fill pass.
- Cap output at 5 new seeds per run. Quality over count: zero seeds is an acceptable, honest result.
- Finish with a compact table in chat: slug, one-line problem, score, strongest single quote. No prose dumps.
