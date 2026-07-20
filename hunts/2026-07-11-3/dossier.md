# Studio Hunt 2026-07-11-3

## Survivors

### 1. Inventory Exception Desk — confidence B-

> “A good software but extremely expensive. My company has invested close to $40,000 AUD over the years in the software and we keep hitting limitations where they make you pay extra.” — [Shopify App Store review](https://apps.shopify.com/unleashed-software/reviews)

- **Demand:** Unleashed has 25 Shopify reviews and a 2.8 rating; six are one-star. Another reviewed app describes restock alerts, reorder quantities, automated POs, and supplier tracking as core jobs.
- **Money:** Unleashed lists $399/month Core and $729/month Pro. One merchant reports nearly $40,000 AUD spent and an $800 bill; a Qoblex customer reports choosing a $49/month package.
- **Incumbent weakness:** buyers report add-on pricing, weak support, and surprise charges; broad suites are expensive and complex.
- **V1 wedge:** Import Shopify CSVs, supplier confirmations, and PO exports, then show only mismatches: late receipts, duplicate orders, uncertain SKU matches, stale reorder suggestions, and stock-value anomalies. Produce an auditable exception queue and a clean CSV back out.
- **First 100 users:** Shopify inventory consultants and operators searching replacement pages for Unleashed, Qoblex, and PO apps.
- **Why now:** merchants are paying for AI-heavy suites while complaining that pricing and support worsened; CSV/email ingestion avoids owning a marketplace integration.
- **Kill fact:** KILL if ten target merchants say their current app already exposes a trustworthy exception queue and they would not pay separately for auditability.

### 2. M365 Renewal Sweep — confidence C+

> “Seats for people who left. A license assigned to a departed employee keeps billing until someone removes it.” — [CloudSecureTech](https://www.cloudsecuretech.com/insights/microsoft-365-price-increase-2026/)

- **Demand:** Microsoft publishes a multi-step former-employee license removal procedure; this hunt did not capture direct small-MSP interview evidence.
- **Money:** documented examples put Business Basic at $7/user/month, Business Standard at $14, and Apps for Business at $10. One worked 40-person example calculates 12 idle Business Standard seats at $2,016/year.
- **Incumbent weakness:** free scripts and broad SaaS-management platforms exist, but the scan did not surface a small-MSP, multi-client renewal evidence packet designed for owner approval.
- **V1 wedge:** Upload tenant license/activity exports and a payroll roster, flag departed, inactive, duplicate, and over-tiered seats, then produce a client-ready renewal decision packet. Keep it read-only: recommendations and auditable CSV, not automated tenant mutation.
- **First 100 users:** small MSP owner communities and Microsoft renewal-season checklists; sell per client packet first.
- **Why now:** multiple sources document Microsoft commercial price changes taking effect around July 2026/renewal.
- **Kill fact:** KILL if five small MSPs confirm AdminDroid or their PSA already generates an owner-ready, multi-tenant renewal packet at no marginal cost.

### 3. AR Reconcile Desk — confidence C+

> “This role is numbers-focused and spreadsheet-driven. Accuracy, consistency, and the ability to reconcile data correctly are more important than speed.” — [OnlineJobs.ph listing](https://www.onlinejobs.ph/jobseekers/job/Invoicing-Bookkeeping-Virtual-Assistant-Spreadsheet-Based-1535460)

- **Demand:** the listing asks for invoice preparation, payment tracking, bank reconciliation, duplicate/unmatched transaction flags, and weekly unpaid/overdue summaries; a staffing page separately describes client contact and discrepancy checks.
- **Money:** the job lists 5/hour for 30 hours/week. A VA invoice guide gives a $900 retainer and $45/hour overage example and reports 200+ reviews.
- **Incumbent weakness:** invoice generators create and chase invoices; accounting reconciliation suites target broader finance close. The client-spreadsheet-to-outsourced-bookkeeper handoff remains service-heavy.
- **V1 wedge:** Import an invoice sheet plus bank CSV, suggest matches, and queue missing, duplicate, partial, overdue, or ambiguous payments with notes and a weekly client summary. The operator approves every match and exports the updated ledger.
- **First 100 users:** outsourced bookkeepers and AR VAs on work marketplaces, bookkeeping newsletters, and construction-office groups.
- **Why now:** structured CSV matching and explanation drafting are cheap enough to productize work still explicitly hired as spreadsheet labor.
- **Kill fact:** KILL if five bookkeepers show existing bank rules resolve at least 90% of these exceptions without spreadsheet handoff.

## Rejected candidates

- **Property Cutover Preflight** — KILL: real pain, but no exact-job spend and services dominate.
- **Salon Stock Tracker** — KILL: a $3.50 template with no reviews does not anchor demand; mature apps exist.
- **WordPress Booking Migrator** — KILL: BookingPress already ships a migration add-on; no buyer-spend artifact.
- **WooCommerce Wholesale Onboarding** — KILL: three active suites cover the flow; independent complaints were absent.
- **Volunteer Roster Sync** — KILL: active incumbents and no money artifact or exploitable weakness.
- **Amazon API Cost Guard** — KILL: Amazon canceled the planned SP-API fees, removing the shock.
- **Client Portal Exporter** — KILL: generic export/migration tools are plentiful and exact spend was unverified.

## Coverage

- **Harvest:** 76 verified corpus pages plus four selected verified gap-fill pages (80 total); 21 additional URLs remained discovered-only.
- **Primary lanes:** demand 8, spend 5, workaround 7, incumbent weakness 40, why-now 16.
- **Source mix:** 41 directory and 35 frontier pages in the core corpus (54%/46%), missing the intended 70/30 directory allocation despite a corrective pass.
- **Not covered:** logged-in Upwork/Fiverr bodies, customer interviews, paid marketplace sales counts, and authenticated MSP/operator groups. All survivors require `$studio-validate`.

