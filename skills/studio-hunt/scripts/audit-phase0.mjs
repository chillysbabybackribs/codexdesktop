#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const phase0 = path.resolve(process.argv[2] || '');
if (!phase0 || !fs.existsSync(phase0)) {
  console.error('usage: node audit-phase0.mjs <hunts/.../phase-0>');
  process.exit(2);
}

const readJsonl = file => fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').trim().split(/\n/).filter(Boolean).map((line, i) => {
      try { return JSON.parse(line); } catch (error) { throw new Error(`${file}:${i + 1}: ${error.message}`); }
    }) : [];
const laneDirs = ['commercial-motion', 'formation-feedback', 'buyer-reality'];
const records = laneDirs.flatMap(lane => readJsonl(path.join(phase0, 'agents', lane, 'records.jsonl')).map(r => ({...r, _laneDir: lane})));
const runRoot = path.dirname(path.dirname(phase0));
const workspaceRoot = process.cwd();
const currencyRe = /(?:[$£€]\s?\d[\d,.]*(?:\s?[kmb])?|\d[\d,.]*\s?(?:usd|eur|gbp|dollars?|pounds?|euros?))/i;
const recurrenceRe = /\b(?:daily|weekly|monthly|every|each|per (?:day|week|month|client|order)|repeat|recurr|whenever)\b/i;
const exactSpendRe = /\b(?:pay|paid|charge|charged|cost|costs|budget|hire|hired|wage|salary|rate|fee|expense|invoice)\b/i;
const disqualifyingMoneyRe = /\b(?:revenue|valuation|tax rate|workforce|shares?|stock|funding|raise|asking price|mrr|arr|total revenue)\b/i;

function artifactExists(record) {
  if (!record.artifactPath) return false;
  const candidates = path.isAbsolute(record.artifactPath)
    ? [record.artifactPath]
    : [path.resolve(workspaceRoot, record.artifactPath), path.resolve(runRoot, record.artifactPath)];
  return candidates.some(fs.existsSync);
}
function yearOf(record) { const y = Number(String(record.publishedAt || '').slice(0, 4)); return Number.isFinite(y) ? y : null; }
function moneyAudit(record) {
  const excerpt = [record.textExcerpt, record.priceOrWage].filter(Boolean).join(' ');
  if (!currencyRe.test(excerpt)) return {type:'none', qualified:false};
  const amount = record.priceOrWage || excerpt.match(currencyRe)?.[0] || '';
  const amountAt = excerpt.toLowerCase().indexOf(amount.toLowerCase());
  const amountContext = amountAt >= 0 ? excerpt.slice(Math.max(0, amountAt - 100), amountAt + amount.length + 100) : excerpt.slice(0, 220);
  if (disqualifyingMoneyRe.test(amount) || disqualifyingMoneyRe.test(amountContext)) return {type:'revenue_or_valuation', qualified:false};
  if (/\b(?:suppose|imagine|example|let'?s say|making up numbers)\b/i.test(amountContext)) return {type:'hypothetical', qualified:false};
  if (!exactSpendRe.test(amountContext)) return {type:'currency_mention', qualified:false};
  const hasJob = Boolean(record.repeatedAction && (record.trigger || record.remainingManualWork || recurrenceRe.test(excerpt)));
  return hasJob ? {type:/\b(?:wage|salary|hourly rate|hire|hired)\b/i.test(amountContext)?'exact_job_wage':'exact_job_spend',qualified:true} : {type:'adjacent_spend',qualified:false};
}
function firsthandAudit(record) {
  const excerpt = record.textExcerpt || '';
  const self = /\b(?:I|we|my|our)\b/i.test(excerpt);
  const concrete = Boolean(record.repeatedAction && record.repeatedAction.length >= 30);
  const ownType = ['own_workflow','own_purchase','own_workaround','own_implementation'].includes(record.statementType);
  return self && concrete && ownType;
}
function jobComplete(record) {
  return ['buyer','trigger','input','repeatedAction','output','destination'].every(k => typeof record[k] === 'string' && record[k].trim())
    && !/community|answer|advice|question/i.test(record.destination || '');
}

const audited = records.map(record => {
  const money = moneyAudit(record);
  const firsthand = firsthandAudit(record);
  return {
    recordId: record.recordId, lane: record._laneDir, source: record.source, url: record.url,
    retrievedVerified: record.retrievalStatus === 'verified', artifactExists: artifactExists(record),
    publishedYear: yearOf(record), statedWindow: record.window,
    windowMismatch: record.window === 'current' && yearOf(record) && yearOf(record) < new Date().getUTCFullYear() - 1,
    collectorFirsthand: Boolean(record.firsthand), qualifiedFirsthand: firsthand,
    collectorMoney: Boolean(record.priceOrWage), moneyType: money.type, qualifiedExactJobMoney: money.qualified,
    qualifiedRepeatedWorkflow: firsthand && (Boolean(record.frequency) || recurrenceRe.test(record.textExcerpt || '')),
    completeJobSentence: jobComplete(record),
    lowConfidenceHeuristic: !record.classificationConfidence || record.classificationConfidence === 'low'
  };
});

const intersections = readJsonl(path.join(phase0, 'intersections.jsonl'));
const scoreErrors = intersections.flatMap(x => {
  if (![x.marketMotion,x.workReality,x.whiteSpace,x.structuralCatalyst,x.penalties,x.score].every(Number.isFinite)) return [];
  const expected = .35*x.marketMotion + .35*x.workReality + .20*x.whiteSpace + .10*x.structuralCatalyst - x.penalties;
  return Math.abs(expected - x.score) > .01 ? [{intersectionId:x.intersectionId,stored:x.score,expected:Number(expected.toFixed(2))}] : [];
});
const provenanceErrors = intersections.filter(x => !x.requirements || !Object.keys(x.requirements).length).map(x => x.intersectionId);
const count = predicate => audited.filter(predicate).length;
const byLane = Object.fromEntries(laneDirs.map(lane => [lane, {
  records: count(x => x.lane === lane),
  retrievedVerified: count(x => x.lane === lane && x.retrievedVerified),
  qualifiedFirsthand: count(x => x.lane === lane && x.qualifiedFirsthand),
  qualifiedRepeatedWorkflow: count(x => x.lane === lane && x.qualifiedRepeatedWorkflow),
  currencyMentions: count(x => x.lane === lane && x.collectorMoney),
  qualifiedExactJobMoney: count(x => x.lane === lane && x.qualifiedExactJobMoney),
  completeJobSentences: count(x => x.lane === lane && x.completeJobSentence),
  staleCurrentWindow: count(x => x.lane === lane && x.windowMismatch),
  missingArtifacts: count(x => x.lane === lane && !x.artifactExists)
}]));
const output = {
  schemaVersion:1, auditedAt:new Date().toISOString(), phase0:path.relative(workspaceRoot, phase0),
  totals:{records:audited.length,retrievedVerified:count(x=>x.retrievedVerified),qualifiedFirsthand:count(x=>x.qualifiedFirsthand),qualifiedRepeatedWorkflow:count(x=>x.qualifiedRepeatedWorkflow),currencyMentions:count(x=>x.collectorMoney),qualifiedExactJobMoney:count(x=>x.qualifiedExactJobMoney),completeJobSentences:count(x=>x.completeJobSentence),lowConfidenceHeuristic:count(x=>x.lowConfidenceHeuristic)},
  byLane, scoreErrors, intersectionsMissingRequirementProvenance:provenanceErrors,
  verdict: scoreErrors.length || provenanceErrors.length || count(x=>x.windowMismatch) ? 'FAIL' : 'PASS',
  findings:[
    ...(count(x=>x.windowMismatch)?[` ${count(x=>x.windowMismatch)} records label old publications as current.`.trim()]:[]),
    ...(provenanceErrors.length?[`${provenanceErrors.length} intersections lack requirement-level supporting record IDs.`]:[]),
    ...(count(x=>x.collectorMoney) > count(x=>x.qualifiedExactJobMoney)?['Collector money counts exceed qualified exact-job money.']:[]),
    ...(count(x=>x.collectorFirsthand) > count(x=>x.qualifiedFirsthand)?['Collector firsthand counts exceed conservative audited firsthand counts.']:[])
  ]
};
fs.writeFileSync(path.join(phase0, 'audit.json'), JSON.stringify(output, null, 2) + '\n');
fs.writeFileSync(path.join(phase0, 'audit-records.jsonl'), audited.map(x=>JSON.stringify(x)).join('\n')+'\n');
console.log(JSON.stringify({ok:output.verdict==='PASS',verdict:output.verdict,records:audited.length,findings:output.findings,artifacts:{audit:path.join(phase0,'audit.json'),records:path.join(phase0,'audit-records.jsonl')}},null,2));
process.exitCode = output.verdict === 'PASS' ? 0 : 1;
