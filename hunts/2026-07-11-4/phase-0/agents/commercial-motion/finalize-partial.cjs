const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../../../..');
const recordsPath = path.join(__dirname, 'records.jsonl');
const queriesPath = path.join(__dirname, 'queries.jsonl');
const failuresPath = path.join(__dirname, 'failures.jsonl');
const observedAt = new Date().toISOString();
const artifactRoot = '/home/dp/.config/codexdesktop/research/d888ff14-6f04-4026-9a84-da1ee08c2048';

function readJsonl(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse) : []; }
function append(file, value) { fs.appendFileSync(file, JSON.stringify(value) + '\n'); }

let records = readJsonl(recordsPath);
const extra = [
  {
    recordId: 'cm-microns-ai-photo-video-generator', source: 'Microns public listing',
    url: 'https://www.microns.io/startup-listings/ai-photo-video-generator', observedAt, publishedAt: null,
    window: 'current-listing; historical baseline-unavailable', sourceLane: 'commercial_motion', retrievalStatus: 'verified',
    actorType: 'startup_founder', actorEvidence: 'The listing is explicitly written in the first person by the seller/founder and presents operating metrics.',
    statementType: 'promotion', firsthand: true, startupName: 'AI Photo & Video Generator', productDomain: null, founderHandle: null,
    buyer: 'prospective startup acquirer', trigger: 'business offered for sale after August 2025 launch', input: null,
    repeatedAction: null, output: 'operating AI content SaaS and mobile app assets', destination: 'prospective acquirer', frequency: null,
    timeSpent: 'built over 9 months; mobile app stated 6-10 weeks from launch', priceOrWage: '$15,000 asking price',
    commercialMetric: {currency: 'USD', askingPrice: 15000, mrr: 150, revenueLast30Days: 543, allTimeRevenue: 2530, activeSubscriptions: 22, lifetimeUsers: 909, peakMonthlyActiveUsers: 2260, aiGenerationsServedMinimum: 1050, fixedCostsMonthly: 26, profitMarginApproxPercent: 70, growthVsPriorPeriodPercent: 58, annualRecurringRevenueApprox: 1800, status: 'already sold', verificationClaim: 'Stripe-verified according to listing'},
    metricPeriod: 'listing current values; revenue last 30 days and seller-stated prior-period growth', currentTools: ['Stripe', '13+ third-party AI models'],
    remainingManualWork: 'seller states mobile apps are 80% complete and paid/international growth channels remain to be activated', objection: 'low MRR-to-price ratio and third-party AI dependency',
    requestedOutcome: 'sale to an operator',
    textExcerpt: 'Currently at $150 MRR (Stripe-verified) with 909 lifetime users, 2,260 MAU peak, and 1,050+ AI generations served. A mobile app (iOS + Android via Kotlin Multiplatform) is 80% complete — 6-10 weeks from App Store launch.',
    artifactPath: `${artifactRoot}/page-05.txt`, independenceKey: 'microns.io|unknown-founder|ai-photo-video-generator|microns-listings', commercialStrength: 'strong',
    caveat: 'Founder/seller-authored marketplace listing; Stripe verification is asserted by the listing, not independently audited here. Growth projections are promotional and excluded from metric credit.'
  },
  {
    recordId: 'cm-bigideasdb-indie-saas-revenue-2026', source: 'BigIdeasDB public report',
    url: 'https://bigideasdb.com/state-of-indie-saas-revenue-2026', observedAt, publishedAt: null,
    window: '2026 cross-sectional report; historical baseline-unavailable', sourceLane: 'commercial_motion', retrievalStatus: 'verified',
    actorType: 'competitor_vendor', actorEvidence: 'BigIdeasDB publishes an analysis product based on a stated TrustMRR-derived dataset.',
    statementType: 'secondhand_claim', firsthand: false, startupName: null, productDomain: 'bigideasdb.com', founderHandle: null,
    buyer: null, trigger: null, input: 'stated TrustMRR-derived dataset', repeatedAction: null, output: 'cross-sectional indie SaaS revenue benchmark report', destination: 'public web report', frequency: null,
    timeSpent: null, priceOrWage: null,
    commercialMetric: {currency: 'USD', trackedStartupsClaimed: 8699, nonzeroMrrBusinessesClaimed: 3787, medianMrrClaimed: 145, averageMrrClaimed: 4298, below100MrrCountClaimed: 1668, below100MrrSharePercentClaimed: 44, between100And1000MrrCountClaimed: 1224, between100And1000MrrSharePercentClaimed: 32, atLeast1000MrrCountClaimed: 895, atLeast1000MrrSharePercentClaimed: 23.6, atLeast10000MrrCountClaimed: 230, atLeast10000MrrSharePercentClaimed: 6.1, artificialIntelligenceTrackedClaimed: 941, artificialIntelligenceMedianMrrClaimed: 203},
    metricPeriod: '2026 report, exact underlying snapshot date not stated in captured text', currentTools: [], remainingManualWork: null, objection: null, requestedOutcome: null,
    textExcerpt: 'The median indie SaaS earns $145 per month. The average is $4,298 — but that figure is a fiction created by a handful of outliers.',
    artifactPath: `${artifactRoot}/page-02.txt`, independenceKey: 'bigideasdb.com|vendor-report|trustmrr-derived-2026|public-report', commercialStrength: 'medium',
    caveat: 'Secondary vendor-authored analysis of a TrustMRR-derived dataset, not independent underlying data. Dataset total differs from the live API total and snapshot date/method are not fully specified; use only as contextual enrichment, never longitudinal proof.'
  }
];
for (const value of extra) if (!records.some(record => record.recordId === value.recordId)) append(recordsPath, value);

append(queriesPath, {source: 'public web discovery', query: 'site:microns.io startup for sale MRR revenue asking price', window: 'current', purpose: 'startup-sale external enrichment', resultCount: 8, verifiedPages: 1, observedAt, artifactResearchId: 'd888ff14-6f04-4026-9a84-da1ee08c2048'});
append(queriesPath, {source: 'public web discovery', query: 'public indie startup revenue MRR sale listing July 2026', window: '2026', purpose: 'cross-sectional commercial benchmark enrichment', resultCount: 7, verifiedPages: 2, observedAt, artifactResearchId: 'd888ff14-6f04-4026-9a84-da1ee08c2048'});
append(failuresPath, {source: 'TrustMRR API', url: 'https://trustmrr.com/api/v1/startups?page=11&limit=10', observedAt, status: 'rate-limited', error: 'Authenticated endpoint exhausted its 10-request window after pages 1-10.', fallbacksAttempted: ['respected x-ratelimit-remaining and reset metadata', 'stopped after bounded retries', 'preserved partial immutable snapshot', 'added public profile and sale-market enrichment'], coverageImpact: '100 of 8,272 live API rows captured (1.21%); directory-wide concentration, entrant, survival, and sale-pressure claims are not defensible from this run.'});
append(failuresPath, {source: 'TrustMRR public profile', url: 'https://trustmrr.com/startup/secret-app-for-sale', observedAt, status: 'thin', error: 'page verification failed: insufficient content', fallbacksAttempted: ['public web extraction'], coverageImpact: 'No record or triangulation credit.'});

records = readJsonl(recordsPath);
const trust = records.filter(r => r.source === 'TrustMRR API');
const categories = {}, actors = {}, statements = {}, verification = {}, sources = {}, windows = {}, missing = {};
const founders = {}, keys = new Map(), duplicates = [];
for (const record of records) {
  sources[record.source] = (sources[record.source] || 0) + 1;
  actors[record.actorType] = (actors[record.actorType] || 0) + 1;
  statements[record.statementType] = (statements[record.statementType] || 0) + 1;
  verification[record.retrievalStatus] = (verification[record.retrievalStatus] || 0) + 1;
  windows[record.window || 'missing'] = (windows[record.window || 'missing'] || 0) + 1;
  const category = record.commercialMetric?.category || 'external/unclassified'; categories[category] = (categories[category] || 0) + 1;
  if (record.founderHandle) founders[record.founderHandle] = (founders[record.founderHandle] || 0) + 1;
  if (keys.has(record.independenceKey)) duplicates.push([keys.get(record.independenceKey), record.recordId]); else keys.set(record.independenceKey, record.recordId);
  for (const field of ['productDomain','founderHandle','buyer','commercialMetric','artifactPath']) if (record[field] == null) missing[field] = (missing[field] || 0) + 1;
}
const snapshot = fs.readdirSync(path.join(ROOT, 'market-motion/trustmrr/snapshots')).filter(f => f.endsWith('-startups.jsonl')).sort()[0];
const snapshotPath = path.join(ROOT, 'market-motion/trustmrr/snapshots', snapshot);
const snapshotMetaPath = snapshotPath.replace(/\.jsonl$/, '.meta.json');
if (!fs.existsSync(snapshotMetaPath)) fs.writeFileSync(snapshotMetaPath, JSON.stringify({observedAt: trust[0]?.observedAt || observedAt, endpoint: 'https://trustmrr.com/api/v1/startups', pagination: {limit: 10, pagesCaptured: 10, rowsCaptured: 100, totalReported: 8272, complete: false}, stopReason: 'strict authenticated API request window exhausted; emergency time ceiling applied', responseMonetaryUnit: 'cents', rawValuesPreserved: true, baselineStatus: 'baseline-unavailable', sha256: crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex')}, null, 2) + '\n', {flag: 'wx'});

const portfolio = Object.entries(founders).filter(([, count]) => count > 1).sort((a,b) => b[1]-a[1]);
const metrics = {
  runId: '2026-07-11-4', lane: 'commercial_motion', observedAt,
  counts: {records: records.length, verified: verification.verified || 0, trustmrrApiRows: trust.length, externalEnrichmentRecords: records.length - trust.length, queryEvents: readJsonl(queriesPath).length, failures: readJsonl(failuresPath).length, categories: Object.keys(categories).length, exactMoneyRecords: records.filter(r => r.priceOrWage || r.commercialMetric?.revenueLast30DaysRaw != null || r.commercialMetric?.mrr != null).length},
  bySource: sources, byWindow: windows, byActor: actors, byStatement: statements, byVerification: verification, byCategory: categories, missingFields: missing,
  sourceCoverage: {trustmrrApi: {coverage: 'partial-rate-limited', liveTotalReported: 8272, rowsCaptured: trust.length, shareCapturedPercent: Number((100 * trust.length / 8272).toFixed(2)), pagesCaptured: 10, snapshotPath: path.relative(ROOT, snapshotPath)}, microns: {coverage: 'one verified public sale listing'}, bigIdeasDb: {coverage: 'one verified secondary report; underlying dataset overlaps TrustMRR'}},
  longitudinal: {status: 'baseline-unavailable', windowsRequested: ['7d','30d','90d','180d'], note: 'No prior market-motion snapshot existed; no acceleration or delta claim is made. One Microns listing states 58% prior-period growth, retained only as seller-authored listing evidence.'},
  independenceAudit: {uniqueIndependenceKeys: keys.size, exactDuplicateKeys: duplicates, foundersWithMultipleProducts: portfolio.length, largestFounderPortfolios: portfolio.slice(0,25).map(([founder, products]) => ({founder, products})), suspectedCrossSourceDuplicates: ['cm-trustmrr-startup-listing records may overlap the verified TrustMRR public profile discovered in research; no extra profile record was added', 'BigIdeasDB report is explicitly TrustMRR-derived and is not independent corroboration']},
  units: {trustmrrMonetaryResponse: 'cents; raw values preserved without conversion', externalListings: 'USD as displayed', growthUnits: 'raw TrustMRR API values preserved; response semantics not independently tested'},
  biasCaveats: ['TrustMRR is opt-in and not whole-market','payment-provider-verifiable does not eliminate classification or founder-selection bias','indie/public-building and survivor skew','partial rank-ordered API capture overweights high-ranking products','founder portfolios can inflate breadth','tiny-base growth can mislead','founder-authored positioning is not buyer evidence','Microns listing is seller-authored','BigIdeasDB is derived from TrustMRR and not independent','baseline unavailable prevents motion claims']
};
fs.writeFileSync(path.join(__dirname, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
console.log(JSON.stringify(metrics.counts));
