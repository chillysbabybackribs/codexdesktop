# Run log

## Baseline

- Prior hunt logs found: 1
- Existing ideas excluded: 5
- This run rotates away from the prior hunt's Etsy-heavy evidence and its five known ideas.

## Harvest log

- 63 verified substantive pages captured across 12 discovery/gauntlet batches.
- Primary lane allocation: demand 7, spend 9, workaround 16, incumbent weakness 18, why-now 13.
- Rich sources: Gumroad product bodies, Notion-template roundups with prices, official/industry regulatory guides, direct vendor comparisons, and focused pricing pages.
- Dead weight: Reddit fetches, authenticated Upwork bodies, thin Notion shells, Fiverr challenge text, and generic platform-policy pages without primary corroboration.

## Mining and gauntlet

- Mechanical corpus pass began with 49 harvest files and 10 theme dictionaries; money, date, count, and theme co-occurrence extraction is in `mechanical.json`.
- 14 substantive direct-competitor pages extended the corpus during falsification.
- 10 candidates entered; 3 survived, 7 were killed, and 3 two-lane near misses were retained.
- Direct scans killed generic chargeback, coaching-onboarding, offboarding, reporting, and brand-monitoring concepts. Failure to verify an alleged Amazon policy against a primary source killed the agent-ledger concept.

## Beta calibration

- Signal per page was best in targeted regulatory/industry guides and product/pricing comparisons. Gumroad bodies were useful; Notion marketplace pages themselves were often too thin, while independent template roundups exposed much more pricing detail.
- The spend lane remained the hardest to verify: Upwork challenged and some Fiverr pages returned only a human-check shell. Vendor pricing and paid-template catalogs carried most of the money evidence.
- The 63-page budget produced three narrow wedges, but no survivor has direct customer-interview evidence; confidence was capped accordingly.
- Next run should use structured marketplace/category APIs where permitted, add public podcast/newsletter transcripts for first-person operator complaints, and treat vendor-authored regulatory statistics as claims requiring primary confirmation during `$studio-validate`.
- Suggested skill change: require the dossier to distinguish “money paid for the exact job” from “adjacent implementation/platform spend”; both are useful, but they should not receive equal confidence.

```app-improvement
Public research extraction repeatedly labeled 48–95 word challenge or shell pages as verified. A configurable minimum substantive-word threshold and shell-pattern rejection in research_web would prevent these pages from consuming the verified-page budget.
```
