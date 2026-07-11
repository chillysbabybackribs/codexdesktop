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

const intersections = [
  {intersectionId:'ix-ai-agent-operations',clusterId:'ai-agent-operations',marketMotion:64,workReality:58,whiteSpace:25,structuralCatalyst:70,penalties:25,score:29.7,status:'NO-GO',reason:'Broad formation and commercial activity, but clone saturation, founder echo, weak concrete job joins, and platform dependency fail the gate.'},
  {intersectionId:'ix-payment-revenue-operations',clusterId:'payment-revenue-operations',marketMotion:48,workReality:52,whiteSpace:60,structuralCatalyst:45,penalties:10,score:41.5,status:'WATCH',reason:'A strong $15K monthly revenue-splitting workflow exists, but only one qualifying firsthand exact-job record and no verified acceleration or two-product motion for that exact job.'},
  {intersectionId:'ix-content-handoff',clusterId:'content-marketing-operations',marketMotion:55,workReality:50,whiteSpace:58,structuralCatalyst:42,penalties:10,score:42.55,status:'WATCH',reason:'Customer asset validation and approval has a stated $1,000/year budget, but the exact job lacks two firsthand records, three independent domains, and longitudinal motion.'},
  {intersectionId:'ix-compliance-security',clusterId:'compliance-security-operations',marketMotion:52,workReality:41,whiteSpace:35,structuralCatalyst:50,penalties:20,score:24.55,status:'NO-GO',reason:'Commercial supply exists but the evidence does not join to a new, solo-accessible repeated job; mature incumbents and prior known ideas increase saturation risk.'},
  {intersectionId:'ix-travel-booking',clusterId:'travel-booking-operations',marketMotion:42,workReality:38,whiteSpace:30,structuralCatalyst:25,penalties:15,score:21.5,status:'NO-GO',reason:'Records share category nouns but not a traceable recurring paid operational job.'},
  {intersectionId:'ix-website-commerce',clusterId:'website-commerce-operations',marketMotion:48,workReality:44,whiteSpace:35,structuralCatalyst:35,penalties:25,score:17.7,status:'NO-GO',reason:'High activity is fragmented across unrelated jobs and overlaps saturated incumbents and previously promoted commerce ideas.'}
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
