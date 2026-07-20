---
name: studio-validate
description: Run a kill-biased validation protocol on one idea from the workspace ideas/ pipeline: competitor sweep, demand check, distribution check, monetization check. Produces a verdict memo (PROCEED, KILL, or PARK) with cited evidence and flips the idea's status. Invoke with $studio-validate <idea-slug>, or with no slug to validate the highest-scored seed.
---

# Studio Validate

The purpose of validation is to **kill ideas cheaply**. Default verdict is KILL; an idea must earn PROCEED with evidence. A wrong KILL costs one idea; a wrong PROCEED costs weeks of build time — bias accordingly.

## Input

Target one idea: the slug given after `$studio-validate`, else the highest-scored `status: seed` in `ideas/`. Read its `idea.md` first; validate the *problem*, not the sketch — a bad sketch on a real problem is still a PROCEED with a revised sketch.

## Protocol

Run four checks. Use `browser_live_search` with `background: true` for public evidence (live verification plus artifact-first background evidence; cite artifact paths) and `browser_snapshot`/`browser_flow` on logged-in tabs for anything gated (communities, marketplaces, competitor apps you can trial), with `browser_run` only for bespoke extraction. Bounded: one research pass per check at most, one final gap-fill overall.

1. **Competitors.** Who solves this today? For the top 3: pricing, last shipped update, and the loudest user complaint about each. A crowded market with paying users and hated incumbents is a *good* sign; an empty market is a red flag, not an opportunity.
2. **Demand.** Is the pain recurring and current? Fresh complaints (90 days), search-suggest phrases, community thread frequency. Distinguish "annoying" from "worth money": look for people already paying (tools, humans, hours).
3. **Distribution.** Name the specific channel where the first 100 users will come from (a subreddit, a directory, a marketplace, SEO phrase, an audience you can reach). "Product Hunt and hope" does not count. If no reachable channel can be named, that alone is a KILL.
4. **Monetization + fit.** Who pays, how much, one-time or recurring? Can one person build the smallest sellable version in ≤4 weeks? Does it exploit any unfair advantage (this app's automation, your access, your niche knowledge)?

## Hard kill criteria

Any one of these forces KILL or PARK regardless of enthusiasm:

- No evidence anyone pays for an adjacent solution (no spend anywhere in the problem space).
- Requires marketplace liquidity, network effects, or a sales team on day one.
- Two or more well-funded incumbents actively shipping with satisfied users.
- No nameable first-100-users channel.
- Depends on platform access that can be revoked (single API/ToS chokepoint) with no fallback.

PARK (not KILL) when the problem is real but timing or dependencies are wrong; note the re-check trigger.

## Output

Write `ideas/<slug>/validation.md`:

```markdown
---
verdict: PROCEED | KILL | PARK
date: <YYYY-MM-DD>
---

# Verdict: <one sentence>

## Scorecard
| Check | Finding | Grade |
|---|---|---|
| Competitors | ... | strong/weak/fail |
| Demand | ... | |
| Distribution | ... | |
| Monetization | ... | |

## Evidence
- <claim> — <URL or artifact path>

## If PROCEED
Smallest sellable version, 4-week scope, first channel, price point.

## If KILL/PARK
The one decisive reason, and (PARK only) what would reopen it.
```

Update `idea.md` frontmatter: `status: validated` on PROCEED, `status: parked` on PARK; on KILL set `status: killed` and move the folder to `ideas/_killed/<slug>/`. Report the verdict and the single decisive finding in chat in 3–6 sentences — the memo holds the detail.
