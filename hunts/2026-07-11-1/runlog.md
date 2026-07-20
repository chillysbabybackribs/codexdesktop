# Run log

## Baseline

- Prior hunt logs found: 0
- Existing ideas excluded: 2
- Dirty worktree observed and left untouched outside `hunts/` and new survivor idea directories.

## Harvest log

- 52 verified pages captured across 7 discovery/gauntlet batches; challenge pages and insufficient-content results excluded.
- Lane allocation: demand 8, spend 9, workaround 19, incumbent weakness 9, why-now 7.
- Rich sources: Etsy category/listing pages (prices, review counts, buyer language), official CFPB pages, vendor pages with concrete workflow descriptions, QuickBooks Community, focused SaaS pricing pages.
- Dead weight: authenticated Upwork bodies (challenge pages), Reddit pages (insufficient content), broad generic comparison posts, and search-result snippets without page verification.

## Mining and gauntlet

- Mechanical corpus pass: 52 files; 8 theme dictionaries; dollar, date, count, and cross-theme extraction saved to `mechanical.json`.
- 10 candidates entered; 3 survived; 7 were killed; 3 two-lane near misses retained.
- Direct-duplication checks were especially productive: they killed the QuickBooks cleanup packet and no-show tooling quickly.

## Beta calibration

- Signal per page was highest in workaround marketplaces and primary regulatory pages. Spend marketplaces were useful for discovery but poor for verification because job bodies challenged the browser.
- The 52-page budget was enough to expose three plausible wedges, but not enough to quantify 1071 demand or confirm willingness to pay for Review Cycle Builder.
- Next run should diversify workaround sources beyond Etsy and reserve 8–10 pages for direct first-person complaints after niches emerge.
- Suggested skill change: distinguish “verified corpus pages” from “discovered-but-blocked spend listings,” and require at least one verified money artifact rather than counting a discovered job URL.

```app-improvement
Research discovery found high-value Upwork job URLs, but public navigation repeatedly returned challenge pages. A source adapter that stores search-result metadata as explicitly low-strength discovery evidence—never as verified page evidence—would preserve useful budget/rate snippets without overstating verification.
```
