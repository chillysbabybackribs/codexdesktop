import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('hunts/2026-07-11-4/phase-0');
const lanes = ['commercial-motion', 'formation-feedback', 'buyer-reality'];
const readJsonl = file => fs.readFileSync(file, 'utf8').trim().split(/\n/).filter(Boolean).map(JSON.parse);
const writeJsonl = (file, rows) => fs.writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''));
const records = lanes.flatMap(lane => readJsonl(path.join(root, 'agents', lane, 'records.jsonl')));

const seenIds = new Set();
const seenUrls = new Set();
const normalized = records.map(r => {
  const duplicateId = seenIds.has(r.recordId);
  const duplicateUrl = seenUrls.has(r.url);
  seenIds.add(r.recordId);
  seenUrls.add(r.url);
  return {...r, parentAudit: {duplicateId, duplicateUrl}};
});
writeJsonl(path.join(root, 'normalized.jsonl'), normalized);

const entities = normalized.filter(r => r.startupName || r.productDomain).map(r => ({
  entityId: `${r.productDomain || r.startupName}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  startupName: r.startupName,
  productDomain: r.productDomain,
  founderHandle: r.founderHandle,
  recordId: r.recordId,
  independenceKey: r.independenceKey,
  commercialMetric: r.commercialMetric || null
}));
writeJsonl(path.join(root, 'entities.jsonl'), entities);

const jobs = normalized.filter(r => r.firsthand && r.repeatedAction).map(r => ({
  recordId: r.recordId,
  source: r.source,
  url: r.url,
  independenceKey: r.independenceKey,
  complete: Boolean(r.buyer && r.trigger && r.input && r.output && r.destination),
  jobSentence: `${r.buyer || '[buyer unknown]'} + ${r.trigger || '[trigger unstated]'} + ${r.input || '[input unstated]'} + ${r.repeatedAction} + ${r.output || '[output unstated]'} + ${r.destination || '[destination unstated]'}`,
  priceOrWage: r.priceOrWage,
  textExcerpt: r.textExcerpt
}));
writeJsonl(path.join(root, 'job-sentences.jsonl'), jobs);

const defs = [
  {id:'ai-agent-operations', label:'AI agent and model operations', re:/\b(ai|agent|llm|model|coding|inference|gpu)\b/i},
  {id:'payment-revenue-operations', label:'Payment and revenue operations', re:/\b(payment|stripe|invoice|revenue|accounting|bookkeep|tax|payout|affiliate)\b/i},
  {id:'content-marketing-operations', label:'Content and marketing operations', re:/\b(content|marketing|creator|social media|seo|cms|image|design)\b/i},
  {id:'compliance-security-operations', label:'Compliance and security operations', re:/\b(compliance|audit|security|soc 2|iso 27001|legal)\b/i},
  {id:'travel-booking-operations', label:'Travel, booking, and ticket operations', re:/\b(travel|booking|ticket|tour|flight|hotel)\b/i},
  {id:'website-commerce-operations', label:'Website and commerce operations', re:/\b(website|wordpress|shopify|e-commerce|ecommerce|magento|craftcms|store)\b/i}
];
const text = r => [r.startupName,r.productDomain,r.buyer,r.trigger,r.repeatedAction,r.remainingManualWork,r.textExcerpt,r.commercialMetric?.category].filter(Boolean).join(' ');
const host = url => { try { return new URL(url).hostname.replace(/^www\./,''); } catch { return 'unknown'; } };
const clusters = defs.map(d => {
  const matches = normalized.filter(r => d.re.test(text(r)));
  const byLane = Object.fromEntries(['commercial_motion','formation_feedback','buyer_reality'].map(l => [l, matches.filter(r => r.sourceLane === l).length]));
  return {
    clusterId:d.id, label:d.label, method:'bounded lexical suggestion; parent validated joins separately',
    recordIds:matches.map(r => r.recordId), byLane,
    independentDomains:[...new Set(matches.map(r => host(r.url)))].sort(),
    firsthandCount:matches.filter(r => r.firsthand).length,
    statedMoneyCount:matches.filter(r => r.priceOrWage).length,
    warning:'Keyword membership is discovery support, not proof that records satisfy the same concrete job.'
  };
});
writeJsonl(path.join(root, 'clusters.jsonl'), clusters);

const failed = reason => ({pass:false,recordIds:[],reason});
const intersections = [
  {intersectionId:'ix-ai-agent-operations',clusterId:'ai-agent-operations',score:null,scoreStatus:'UNJOINED',status:'NO-GO',requirements:{independentDomains:failed('Lexical matches do not establish one exact job.'),actorTypes:failed('Founder-heavy and actor joins unvalidated.'),motionProducts:failed('Products span unrelated AI jobs.'),commercialMetric:failed('No exact-job product set.'),firsthandWork:failed('No validated shared job.'),exactJobMoney:failed('No validated shared job spend.'),catalyst:failed('General AI adoption is insufficient.'),jobSentence:failed('No complete job sentence.'),buyerChannel:failed('No exact buyer.')},reason:'Broad formation and commercial activity, but no validated intersection exists; numeric scoring is prohibited.'},
  {intersectionId:'ix-payment-revenue-operations',clusterId:'payment-revenue-operations',score:null,scoreStatus:'HARD_REQUIREMENTS_FAILED',status:'WATCH',requirements:{independentDomains:failed('Only one exact-job source.'),actorTypes:failed('Only one exact-job actor established.'),motionProducts:failed('No two independently verified exact-job products.'),commercialMetric:failed('No exact-job product metric.'),firsthandWork:{pass:false,recordIds:['br-0177'],reason:'One firsthand workflow; two required.'},exactJobMoney:{pass:false,recordIds:['br-0177'],reason:'$15K is revenue being routed, not spend on the job or a wage for performing it.'},catalyst:failed('No longitudinal acceleration.'),jobSentence:{pass:false,recordIds:['br-0177'],reason:'Buyer and input were not independently structured.'},buyerChannel:failed('Founder channel is plausible but not independently validated.')},reason:'One sharp workflow lead, but the hard intersection contract fails; not numerically scored.'},
  {intersectionId:'ix-content-handoff',clusterId:'content-marketing-operations',score:null,scoreStatus:'HARD_REQUIREMENTS_FAILED',status:'WATCH',requirements:{independentDomains:failed('Only one exact-job source.'),actorTypes:failed('Only one exact-job actor established.'),motionProducts:failed('No two independently verified exact-job products.'),commercialMetric:failed('No exact-job product metric.'),firsthandWork:{pass:false,recordIds:['br-0147'],reason:'One firsthand workflow; two required.'},exactJobMoney:{pass:true,recordIds:['br-0147'],reason:'Explicit $1,000/year company-card budget for the requested job.'},catalyst:failed('No longitudinal acceleration.'),jobSentence:{pass:false,recordIds:['br-0147'],reason:'Buyer and input were not independently structured.'},buyerChannel:failed('White-label SaaS operators are plausible but channel is not evidenced.')},reason:'One sharp workflow lead, but the hard intersection contract fails; not numerically scored.'},
  {intersectionId:'ix-compliance-security',clusterId:'compliance-security-operations',score:null,scoreStatus:'UNJOINED',status:'NO-GO',requirements:{join:failed('No validated market-motion to work-reality join.')},reason:'Commercial supply exists, but no traceable exact-job intersection; numeric scoring is prohibited.'},
  {intersectionId:'ix-travel-booking',clusterId:'travel-booking-operations',score:null,scoreStatus:'UNJOINED',status:'NO-GO',requirements:{join:failed('Shared nouns only; no validated repeated job.')},reason:'Category overlap without a traceable exact-job intersection.'},
  {intersectionId:'ix-website-commerce',clusterId:'website-commerce-operations',score:null,scoreStatus:'UNJOINED',status:'NO-GO',requirements:{join:failed('Fragmented jobs and prior-idea overlap.')},reason:'No validated exact-job intersection; numeric scoring is prohibited.'}
];
writeJsonl(path.join(root, 'intersections.jsonl'), intersections);
writeJsonl(path.join(root, 'rejected-clusters.jsonl'), intersections.filter(x => x.status === 'NO-GO'));

const exactCurrency = normalized.filter(r => r.priceOrWage && /[$€£]/.test(r.priceOrWage));
const coverage = {
  runId:'2026-07-11-4', totalRecords:normalized.length,
  laneRecords:Object.fromEntries(lanes.map(l => [l, readJsonl(path.join(root,'agents',l,'records.jsonl')).length])),
  verifiedRecords:normalized.filter(r => r.retrievalStatus === 'verified').length,
  uniqueIndependenceKeys:new Set(normalized.map(r => r.independenceKey)).size,
  sourceDomains:new Set(normalized.map(r => host(r.url))).size,
  exactCurrencyMentionsBeforeJobAudit:exactCurrency.length,
  completeJobSentences:jobs.filter(j => j.complete).length,
  firsthandWithRepeatedAction:jobs.length,
  trustMrrCoverage:{captured:100,available:8272,percent:1.21,rankOrderedTopHeavy:true,baseline:'unavailable'},
  limitations:[
    'No prior commercial snapshot; 7/30/90/180-day longitudinal acceleration cannot be established.',
    'TrustMRR capture stopped at 100 of 8,272 rows due rate limits and is rank-ordered/top-heavy.',
    'Formation/feedback is HN-only; buyer reality is Stack Exchange plus Ask HN.',
    'Most buyer records omit buyer/input fields; exact job sentences are therefore rarely complete.',
    'Automated money extraction included percentages and adjacent costs; parent audit did not treat them as exact-job spend.'
  ],
  adaptiveStopping:{satisfied:false,reason:'No independent second batch across all lanes and critical longitudinal coverage is absent.'},
  gate:'INSUFFICIENT COVERAGE; zero GO intersections'
};
fs.writeFileSync(path.join(root,'coverage.json'), JSON.stringify(coverage,null,2)+'\n');
