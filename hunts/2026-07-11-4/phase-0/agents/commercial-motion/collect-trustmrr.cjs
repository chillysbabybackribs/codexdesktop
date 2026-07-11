const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../../../..');
const OUT = __dirname;
const SNAPDIR = path.join(ROOT, 'market-motion/trustmrr/snapshots');
const OBSERVED_AT = new Date().toISOString();
const STAMP = OBSERVED_AT.replace(/[:.]/g, '-');

function envFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

const env = {...envFile(path.join(ROOT, 'app/.env')), ...envFile(path.join(ROOT, '.env')), ...process.env};
const key = env.TRUSTMRR_API_KEY;
if (!key) throw new Error('TRUSTMRR_API_KEY did not resolve');

fs.mkdirSync(OUT, {recursive: true});
fs.mkdirSync(SNAPDIR, {recursive: true});
const snapshotPath = path.join(SNAPDIR, `${STAMP}-startups.jsonl`);
if (fs.existsSync(snapshotPath)) throw new Error(`immutable snapshot already exists: ${snapshotPath}`);

const snapshot = fs.createWriteStream(snapshotPath, {flags: 'wx'});
const records = fs.createWriteStream(path.join(OUT, 'records.jsonl'));
const queries = fs.createWriteStream(path.join(OUT, 'queries.jsonl'));
const failures = fs.createWriteStream(path.join(OUT, 'failures.jsonl'));
const counts = {records: 0, verified: 0, pages: 0, failures: 0, onSale: 0, nonzeroRevenue30d: 0, nonzeroMrr: 0};
const byCategory = {};
const missing = {};
const founderCounts = {};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fetchPage(page) {
  const url = `https://trustmrr.com/api/v1/startups?page=${page}&limit=10`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, {headers: {Authorization: `Bearer ${key}`, Accept: 'application/json'}});
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = response.headers.get('x-ratelimit-reset');
      if (response.ok) return {json: await response.json(), remaining, reset};
      if (response.status === 429 || response.status >= 500) {
        await sleep(Math.min(30000, attempt * 2000));
        continue;
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(attempt * 1500);
    }
  }
}

function host(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}
function slug(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown';
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16); }
function line(stream, value) { stream.write(JSON.stringify(value) + '\n'); }

function normalize(item, page) {
  const domain = host(item.website);
  const founder = item.xHandle || null;
  const category = item.category || 'Uncategorized';
  const rev = item.revenue || {};
  const commercialMetric = {
    sourceUnit: 'cents',
    sourceUnitNote: 'TrustMRR monetary response values preserved raw; documented API convention is cents',
    revenueLast30DaysRaw: rev.last30Days ?? null,
    mrrRaw: rev.mrr ?? null,
    totalRevenueRaw: rev.total ?? null,
    customers: item.customers ?? null,
    activeSubscriptions: item.activeSubscriptions ?? null,
    growth30dRaw: item.growth30d ?? null,
    growthMRR30dRaw: item.growthMRR30d ?? null,
    rank: item.rank ?? null,
    visitorsLast30Days: item.visitorsLast30Days ?? null,
    googleSearchImpressionsLast30Days: item.googleSearchImpressionsLast30Days ?? null,
    revenuePerVisitorRaw: item.revenuePerVisitor ?? null,
    profitMarginLast30DaysRaw: item.profitMarginLast30Days ?? null,
    onSale: item.onSale ?? false,
    askingPriceRaw: item.askingPrice ?? null,
    firstListedForSaleAt: item.firstListedForSaleAt ?? null,
    multipleRaw: item.multiple ?? null,
    paymentProvider: item.paymentProvider ?? null,
    foundedDate: item.foundedDate ?? null,
    category,
    targetAudience: item.targetAudience ?? null,
    country: item.country ?? null,
    apiPage: page,
    baselineStatus: 'baseline-unavailable'
  };
  const ecosystem = founder ? `x:${founder.toLowerCase()}` : `domain:${domain || item.slug}`;
  return {
    recordId: `cm-trustmrr-${slug(item.slug || item.name)}-${hash(item.url || item.website || item.name)}`,
    source: 'TrustMRR API',
    url: item.url,
    observedAt: OBSERVED_AT,
    publishedAt: item.foundedDate || null,
    window: 'current-snapshot; 7d/30d/90d/180d baseline-unavailable',
    sourceLane: 'commercial_motion',
    retrievalStatus: 'verified',
    actorType: 'startup_founder',
    actorEvidence: 'Opt-in payment-provider-verifiable startup profile; founder identity is the public X handle when available.',
    statementType: 'product_pitch',
    firsthand: false,
    startupName: item.name || null,
    productDomain: domain,
    founderHandle: founder,
    buyer: item.targetAudience || null,
    trigger: null,
    input: null,
    repeatedAction: null,
    output: null,
    destination: null,
    frequency: null,
    timeSpent: null,
    priceOrWage: item.askingPrice == null ? null : `${item.askingPrice} cents asking price (raw API value)`,
    commercialMetric,
    metricPeriod: 'current snapshot with last-30-day fields; longitudinal baseline unavailable',
    currentTools: [],
    remainingManualWork: null,
    objection: null,
    requestedOutcome: null,
    textExcerpt: item.description || null,
    artifactPath: path.relative(ROOT, snapshotPath),
    independenceKey: `trustmrr|${domain || slug(item.slug)}|${ecosystem}|trustmrr-api`,
    commercialStrength: (Number(rev.last30Days) > 0 || Number(rev.mrr) > 0 || Number(rev.total) > 0) ? 'strong' : 'weak',
    caveat: 'Commercial sensor only: TrustMRR is opt-in, payment-provider-verifiable, indie/public-building-skewed, survivor-biased, unevenly enriched, and founder-authored positioning is not buyer-workflow proof. Founder portfolios and tiny-base growth require parent-level deduplication and penalties.'
  };
}

(async () => {
  let page = 1;
  let total = null;
  while (true) {
    const started = Date.now();
    try {
      const {json, remaining, reset} = await fetchPage(page);
      counts.pages++;
      total = json.meta.total;
      line(queries, {source: 'TrustMRR API', query: 'GET /api/v1/startups', page, limit: 10, window: 'current-snapshot', purpose: 'full commercial-motion directory pagination', resultCount: json.data.length, total: json.meta.total, hasMore: json.meta.hasMore, observedAt: OBSERVED_AT, durationMs: Date.now() - started, rateLimitRemaining: remaining == null ? null : Number(remaining), rateLimitReset: reset});
      for (const item of json.data) {
        line(snapshot, item);
        const record = normalize(item, page);
        line(records, record);
        counts.records++; counts.verified++;
        if (item.onSale) counts.onSale++;
        if (Number(item.revenue?.last30Days) > 0) counts.nonzeroRevenue30d++;
        if (Number(item.revenue?.mrr) > 0) counts.nonzeroMrr++;
        const category = item.category || 'Uncategorized';
        byCategory[category] = (byCategory[category] || 0) + 1;
        const founder = item.xHandle || 'missing'; founderCounts[founder] = (founderCounts[founder] || 0) + 1;
        for (const field of ['website','foundedDate','category','targetAudience','customers','activeSubscriptions','growth30d','growthMRR30d','visitorsLast30Days','googleSearchImpressionsLast30Days','revenuePerVisitor','profitMarginLast30Days','xHandle']) {
          if (item[field] == null) missing[field] = (missing[field] || 0) + 1;
        }
      }
      if (!json.meta.hasMore) break;
      page++;
      if (remaining !== null && Number(remaining) < 5) await sleep(2000); else await sleep(120);
    } catch (error) {
      counts.failures++;
      line(failures, {source: 'TrustMRR API', url: `https://trustmrr.com/api/v1/startups?page=${page}&limit=10`, observedAt: new Date().toISOString(), status: 'error', error: error.message, fallbacksAttempted: ['5 retry attempts with bounded backoff'], coverageImpact: 'Full pagination stopped at failed page.'});
      throw error;
    }
  }
  await Promise.all([snapshot, records, queries, failures].map(stream => new Promise((resolve, reject) => {stream.end(resolve); stream.on('error', reject)})));
  const founderPortfolioCounts = Object.entries(founderCounts).filter(([key, n]) => key !== 'missing' && n > 1).sort((a,b) => b[1]-a[1]);
  const metrics = {
    runId: '2026-07-11-4', lane: 'commercial_motion', observedAt: OBSERVED_AT,
    sourceCoverage: {trustmrrApi: {coverage: 'full-directory-pagination', totalReported: total, pages: counts.pages, records: counts.records, verified: counts.verified, snapshotPath: path.relative(ROOT, snapshotPath)}},
    counts,
    bySource: {'TrustMRR API': counts.records}, byWindow: {'current-snapshot; baseline-unavailable': counts.records},
    byActor: {startup_founder: counts.records}, byStatement: {product_pitch: counts.records}, byVerification: {verified: counts.records},
    byCategory, missingFields: missing,
    independenceAudit: {uniqueIndependenceKeys: counts.records, foundersWithMultipleProducts: founderPortfolioCounts.length, largestFounderPortfolios: founderPortfolioCounts.slice(0,25).map(([founder, products]) => ({founder, products})), missingFounderHandles: founderCounts.missing || 0},
    longitudinal: {status: 'baseline-unavailable', windowsRequested: ['7d','30d','90d','180d'], note: 'No prior immutable TrustMRR snapshot existed in this checkout; no change or acceleration claim is made.'},
    units: {trustmrrMonetaryResponse: 'cents; raw values preserved without conversion', growthUnits: 'raw API response values preserved; request/response unit semantics not independently tested in this run'},
    biasCaveats: ['opt-in population','payment-provider-verifiable but not whole-market','indie/public-building skew','survivor bias','uneven enrichment and missingness','founder-authored positioning is not buyer evidence','founder portfolios can inflate breadth','tiny-base percentage growth can mislead','one-product concentration must be assessed by parent','current-only snapshot cannot establish acceleration']
  };
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  fs.writeFileSync(snapshotPath.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({observedAt: OBSERVED_AT, endpoint: 'https://trustmrr.com/api/v1/startups', pagination: {limit: 10, pages: counts.pages, total}, responseMonetaryUnit: 'cents', rawValuesPreserved: true, baselineStatus: 'baseline-unavailable', sha256: crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex')}, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({snapshot: path.relative(ROOT, snapshotPath), records: counts.records, pages: counts.pages, failures: counts.failures, categories: Object.keys(byCategory).length}));
})().catch(error => { console.error(JSON.stringify({error: error.message})); process.exitCode = 1; });
