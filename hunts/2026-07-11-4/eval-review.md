# Eval review — hunt 2026-07-11-4

## Verdict

The final decision—promote nothing—was safe, but the run itself fails the evidence-quality eval. It should be treated as a baseline collection and pipeline diagnostic, not a completed market-motion hunt.

## Findings

### Critical

1. **Retrieval verification was reported as evidence qualification.** All 750 records had captured bodies, but collectors did not store classification confidence/reasons. The eval audit therefore qualifies zero records toward firsthand, repeated-workflow, exact-job-money, or complete-job floors.
2. **Intersections were impressionistically scored.** Six clusters received subscale scores without requirement-level supporting record IDs. The revised artifacts remove numeric scores from unjoined/failed intersections and encode each hard requirement with `pass`, `recordIds`, and `reason`.
3. **The buyer lane did not satisfy the source or stopping contract.** It used Stack Exchange plus Ask HN, skipped Reddit/services/templates, did not run two saturation batches, and still declared lane completion after exceeding numerical floors.

### High

4. **Money extraction was materially inflated.** The buyer collector counted percentages, valuations, revenue handled, hypothetical arithmetic, and adjacent costs. The original `67 exact-money` claim was not exact-job spend. Revised logic separates currency mentions, adjacent spend, revenue/valuation, hypothetical money, and exact-job spend/wages.
5. **Firsthand classification was regex-inflated.** A first-person pronoun anywhere in a long post plus a workflow noun was enough. Revised collectors emit low-confidence leads and cannot count them as qualified until audited.
6. **Time windows were wrong.** The buyer collector labeled every record `current`; 79 records were published before 2025, including records back to 2012. Revised collection derives windows from `publishedAt`.

### Medium

7. **Independence was overstated.** Raw host counts treated Stack Exchange subdomains and duplicate HN collection lanes as broad diversity. The contract now requires normalized parent-ecosystem concentration.
8. **Job sentences were structurally manufactured.** Question titles and forum destinations were placed into output/destination fields. The revised collector leaves unknown fields null; incomplete evidence remains incomplete.
9. **Commercial coverage was not source-complete.** TrustMRR stopped at 100/8,272 rank-ordered records and had no historical baseline. The final gate acknowledged this correctly.

## What was good

- Source bodies and structured API artifacts were preserved and traceable.
- TrustMRR units and rate-limit coverage were documented honestly.
- The final hard-gate outcome did not promote weak ideas.
- The two retained WATCH records are useful gap-fill leads, especially `br-0147`; neither is promoted.

## Optimizations implemented

- Added `skills/studio-hunt/scripts/audit-phase0.mjs` for artifact existence, stale-window detection, qualified-vs-retrieved metrics, complete-job checks, score recomputation, and intersection provenance checks.
- Strengthened the Phase 0 agent contract with qualified metric definitions, time/provenance rules, confidence requirements, and adaptive-stopping enforcement.
- Extended the record schema with `classificationConfidence`, `classificationReason`, and `moneyType`.
- Changed the skill so lexical clusters cannot be numerically scored before a validated join and every intersection must carry requirement-level provenance.
- Reworked the buyer collector for publication-derived windows, currency-only extraction, money-type classification, null unknown job fields, and low-confidence lead accounting.
- Replaced the run's unsupported numeric intersection scores with `UNJOINED` or `HARD_REQUIREMENTS_FAILED` plus record-level requirement evidence.

## Retest criteria

A new hunt passes only if the audit reports qualified counts above the diagnostic floors, zero stale-current records, zero score/provenance errors, source/ecosystem diversity sufficient for every GO cluster, and two consecutive independent saturation batches. This run intentionally remains `FAIL`; changing the audit to pass without recollection would hide the defect.
