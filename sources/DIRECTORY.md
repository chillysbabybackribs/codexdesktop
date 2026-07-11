# Source Directory

Curated sources with fetch recipes and yield history, consumed by `$studio-hunt` (and usable by scout/validate). Rules:

- **Verified vs discovered:** an artifact is *verified* only when the page content itself was captured. API/SERP snippets are *discovered* — leads, never triangulation evidence.
- **70/30:** ~70% of a hunt's harvest budget goes to directory sources, ≥30% to frontier (new) sources. Frontier sources that feed a candidate graduate into this file.
- **Yield accounting:** after each run, append to the Yield column: `run-id: pages→candidates-fed`. Three consecutive zero-yield runs ⇒ flag `PRUNE?`.
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
