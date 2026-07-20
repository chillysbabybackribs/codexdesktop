---
name: studio-pulse
description: Weekly operations sweep across all shipped apps: collect metrics from logged-in dashboards (analytics, payments, stores), check reviews and competitor changes, verify each app is up, and append a dated pulse entry with trend charts. Crystallizes each collector into a reusable automation script. Invoke with $studio-pulse.
---

# Studio Pulse

One command that replaces the Monday-morning tab ritual. Sweep every shipped app, pull the numbers from the logged-in dashboards, surface what changed, and keep a durable log.

## State

- Per app: `ideas/<slug>/pulse.md` — a `## Sources` block listing dashboard URLs and which metrics to read from each (analytics, Stripe/payments, store listing, uptime URL), followed by dated entries.
- Global: `pulse/log.md` — one dated section per run summarizing the whole portfolio.

On first run for an app, build its `## Sources` block from `launch.md` and open tabs, confirm the metric names, and take the first baseline reading.

## Sweep

For each idea with `status: shipped`:

1. **Liveness.** Load the app's production URL in a tab; a smoke check via one `browser_snapshot` (page renders, expected content present; use `ui_review` only when you need runtime-exception or failed-request evidence). Down = lead the report with it.
2. **Metrics.** Read each source dashboard via `browser_snapshot` on the logged-in session, stating every metric field in the objective: visitors, signups, revenue/MRR, conversion — whatever the Sources block names. Record absolute value + delta vs. last entry. Fall back to `browser_run` only for bespoke widgets a snapshot cannot express.
3. **Voice of user.** New reviews, support emails surfaced in a dashboard, community mentions since last pulse. Quote anything actionable verbatim.
4. **Competitors.** Cheap check only: the top competitor's changelog/pricing page from the validation memo. Note changes; do not re-research.

## Crystallize

Same convention as studio-launch: once a dashboard read works, save it as `automations/pulse-<source>.mjs` driving `CODEX_BROWSER_SOCK`, returning `{"ok":true,"metrics":{...}}`. Manifest entry, last-verified date. Run scripts first, drive interactively only on failure, then repair the script. Over time the sweep becomes: run scripts, read envelopes, think only about anomalies.

## Report

Append to `pulse/log.md` and per-app `pulse.md`, then report in chat:

1. **Anomalies first** — anything down, spiking, dropping, or newly reviewed. If nothing: say "steady" and stop being interesting.
2. One portfolio table: app | visitors Δ | signups Δ | revenue Δ | note.
3. A `chart` fenced block (the app renders these natively) for any metric with ≥4 recorded points — trend lines beat tables for spotting drift.
4. At most 3 suggested actions, each traceable to a number or quote from this sweep.

## Budget

Bounded and boring by design: scripts + targeted reads, no research passes. If a sweep repeatedly needs new investigation, that is a sign the Sources block is wrong — fix the state, not the run.
