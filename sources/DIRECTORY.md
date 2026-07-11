# Source Directory

Curated sources with fetch recipes and yield history, consumed by `$studio-hunt` (and usable by scout/validate). Rules:

- **Verified vs discovered:** an artifact is *verified* only when the page content itself was captured. API/SERP snippets are *discovered* — leads, never triangulation evidence.
- **70/30:** ~70% of a hunt's harvest budget goes to directory sources, ≥30% to frontier (new) sources. Frontier sources that feed a candidate graduate into this file.
- **Yield accounting:** after each run, append: `run-id: records→qualified-job-clusters→directives→candidates→survivors`. Three consecutive zero-yield runs ⇒ flag `PRUNE?`.
- Keys/secrets are never stored here. Brave key resolves from env or `.env`.

## Fast lane — APIs and structured endpoints (capsule-script friendly)

| Source | Lanes | Fetch recipe | Extractables | Yield |
|---|---|---|---|---|
| Brave Search API | discovery (all) | `GET api.search.brave.com/res/v1/web/search` hdr `X-Subscription-Token`, params `q,count,freshness`, `result_filter=discussions` for forums; ~1 req/s | URLs, snippets, forum threads (discovered-class) | |
| HN Algolia | demand, spend | `hn.algolia.com/api/v1/search?query=<q>&tags=story` (or `comment`); mine recurring "Ask HN: what do you pay for" threads | verbatim pain, literal prices, dates, points | |
| Reddit JSON | demand | `old.reddit.com/r/<sub>/search.json?q=<q>&restrict_sr=on&sort=new&t=year`; any thread URL + `.json` | quotes, dates, upvotes, sub size | |
| Federal Register API | why-now | `federalregister.gov/api/v1/documents.json?conditions[term]=<q>&order=newest` | rule stages, effective dates, agencies | 2026-07-11-3: 10→0 |
| IRS draft forms | why-now | `irs.gov/draft-tax-forms` index + form PDFs | form/threshold changes with dates | |
| WordPress plugin API | demand, incumbent | `api.wordpress.org/plugins/info/1.2/?action=query_plugins&request[search]=<q>` ; support forum: `wordpress.org/support/plugin/<slug>` | active installs, last-updated (abandonment!), ratings, unresolved thread counts | 2026-07-11-3: 26→5 |
| StackExchange API | demand | `api.stackexchange.com/2.3/search/advanced?q=<q>&site=<site>` | question frequency, unanswered rates | |

## Phase 0 — market motion and startup formation

These sources direct the hunt; they do not independently satisfy buyer-demand, exact-job-money, or workaround requirements.

| Source | Signal | Fetch recipe | Extractables | Caveats | Yield |
|---|---|---|---|---|---|
| TrustMRR API/public profiles | verified commercial motion | Resolve `TRUSTMRR_API_KEY` separately; paginate `GET trustmrr.com/api/v1/startups` at max 10/page and selectively fetch details. Without a key, use verified public profiles and mark incomplete coverage. | revenue/MRR, customers, subscriptions, growth, founding date, audience, traffic provenance, sale status, price, founder | opt-in indie/public-building population; tiny-base growth; one founder may own many products; Brave key is not authentication | |
| HN Algolia Show HN | product formation | `hn.algolia.com/api/v1/search_by_date?tags=show_hn&numericFilters=created_at_i>X,created_at_i<Y`; paginate recent/prior 30/90-day and prior-year windows | title/text, domain, author, date, points, comments, formation velocity, persistence | points are attention, not demand; normalize founders/domains and repeat launches | |
| HN Algolia Ask HN | problems and purchasing | `search_by_date?tags=ask_hn`; inspect own-problem, own-purchase, internal-tool, workaround, and replacement language | firsthand problem/spend/workaround candidates, actor language, job sentences | HN audience overweights developers; classify actor from evidence | |
| HN Algolia comments | objections and operational residue | `search_by_date?tags=comment,story_<ID>` for high-motion clusters | missing segments, exports, integrations, approval, trust, remaining manual work | a comment is work reality only when the speaker describes their own work/purchase/implementation | |
| Reddit JSON — founder communities | supply formation and feedback | Brave discussions discovery → thread `.json` → old Reddit/search JSON → logged-in browser | pitches, repeated positioning, failed distribution, buyer replies inside founder threads | founder posts are supply evidence; promotion/echo risk; snippets are discovered-only | |
| Reddit JSON — occupational communities | buyer work reality | discover communities from harvested actors/jobs; use thread/search JSON and browser fallback | own workflows, purchases, tools, frequency, time, workarounds, service providers | access can be blocked; do not infer actor from subreddit membership | |
| Launch directories | formation breadth | browse recent/category indexes; snapshot domains, founders, descriptions, dates, survival | entrant velocity, category vocabulary, persistence | listing volume may reflect fashion or paid promotion, not customers | |
| Startup-sale markets | attrition and exit pressure | public listings or authenticated browser where authorized | asking price, revenue claims, age, category density, sale timing | self-reported values and selection bias; high sale rate is often a negative signal | |
| Indie Hackers products/interviews | traction and founder narrative | public product pages/interviews; prefer Stripe-verified records | revenue, founding narrative, channel, audience, failed attempts | founder-authored; require buyer-side corroboration | |

Run `2026-07-11-4` calibration: `750→0→2→0→0`. TrustMRR API yielded 100 verified rows but rate-limited at 1.21% of the rank-ordered directory and lacked a longitudinal baseline. HN Algolia yielded 470 formation/feedback records but was source-concentrated. Stack Exchange plus Ask HN yielded 178 buyer records; precise Ask HN workflows were highest signal, while broad Stack Exchange money extraction overcounted percentages and adjacent costs. No source changed the hard gate to GO.

For Phase 0, preserve immutable snapshots under `market-motion/`, compare cohorts longitudinally, and measure unique founders, commercial breadth, survival, concentration, and sale pressure. Use medians/proportions rather than summed revenue or the largest product.

## Marketplaces with visible numbers (plain fetch, sometimes browser)

| Source | Lanes | Fetch recipe | Extractables | Yield |
|---|---|---|---|---|
| Etsy categories/listings | workaround, money | category + listing pages, plain fetch | prices, review counts, verbatim buyer reviews | 2026-07-11-1: 12→4 |
| Gumroad Discover | workaround, money | `gumroad.com/discover?query=<q>`; listing pages | price, ratings count, creator niche | |
| Notion template gallery | workaround | `notion.com/templates` category pages | popularity ordering, prices | |
| Airtable Universe | workaround | `airtable.com/universe` categories | copy counts, use-case language | |
| Shopify App Store | demand, money | `apps.shopify.com/categories/<cat>`; app review tabs | review counts, pricing tiers, merchant complaints | 2026-07-11-3: 10→2 |
| Chrome Web Store | demand, money | extension detail pages | user counts, ratings, review text | |
| Zapier app directory | workaround, spend | `zapier.com/apps/<app>/integrations` | popular recipe combos = badly-automated workflows | |
| Microns.io | money, incumbent | public listings | MRR, asking price, niche | |
| Flippa | money | public search pages | revenue claims (treat skeptically), categories | |
| Indie Hackers products | money, demand | `indiehackers.com/products` (filter Stripe-verified) | verified revenue, niche, founder notes | |

## Incumbent-weakness and shock surfaces

| Source | Lanes | Fetch recipe | Extractables | Yield |
|---|---|---|---|---|
| Trustpilot | incumbent | `trustpilot.com/review/<domain>` | rating distribution, price-hike backlash text | |
| G2 / Capterra | demand, incumbent | product review pages, plain fetch first, browser if gated | structured pros/cons, "switched from" mentions | |
| Sunset/shutdown news | incumbent vacuum | Brave news search `"shutting down" OR "sunsetting" <category>`; killed-product lists | dates, orphaned user counts, migration threads | |

## Gated / logged-in edge (visible browser tabs only; fragile, high signal)

| Source | Lanes | Fetch recipe | Extractables | Yield |
|---|---|---|---|---|
| Upwork | spend | DISCOVERED-only via Brave `site:upwork.com <task>`; bodies challenge-page on plain fetch — verify via logged-in visible tab only for hot candidates | hourly rates, gig volume, task descriptions | 2026-07-11-1: 0→0 (blocked) |
| Acquire.com | money, incumbent | browse via logged-in visible tab | revenue multiples, listing density per niche | |
| Facebook groups / Discords | demand | logged-in visible tabs; use to *verify* hot candidates, not broad harvest | verbatim niche pain, group sizes | |
