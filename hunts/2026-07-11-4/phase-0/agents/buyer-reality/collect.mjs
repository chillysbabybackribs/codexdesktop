import fs from 'node:fs/promises';
import path from 'node:path';

const out = path.dirname(new URL(import.meta.url).pathname);
const observedAt = new Date().toISOString();
const records = [], queries = [], failures = [];
let seq = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const moneyRe = /(?:[$£€]\s?\d[\d,.]*(?:\s?(?:k|m))?|\d[\d,.]*\s?(?:usd|eur|gbp|dollars?|pounds?|euros?))/i;
const workflowRe = /\b(?:manually|spreadsheet|excel|every day|daily|every week|weekly|every month|monthly|each time|each client|each order|repeat(?:ed|ing)?|workflow|copy(?:ing)? and paste|export|import|reconcil|track(?:ing)?|schedule|invoice|report(?:ing)?|submit(?:ting)?|review(?:ing)?|check(?:ing)?|upload(?:ing)?|download(?:ing)?)\b/i;
const ownWorkflowRe = /\b(?:I|we|my|our)\b[^.!?]{0,160}\b(?:manually|use|using|run|manage|handle|track|schedule|invoice|report|submit|review|check|upload|download|export|import|reconcil|copy|pay|paid)\b/i;
const exactSpendContextRe = /\b(?:pay|paid|charge|charged|cost|costs|budget|hire|hired|wage|salary|rate|fee|expense|invoice)\b/i;
const disqualifyingMoneyRe = /\b(?:revenue|valuation|tax rate|workforce|shares?|stock|funding|raise|asking price|mrr|arr)\b/i;

function windowFor(publishedAt) {
  const ageDays = (Date.now() - new Date(publishedAt).getTime()) / 86400000;
  if (!Number.isFinite(ageDays)) return 'unknown';
  if (ageDays <= 30) return 'recent-30d';
  if (ageDays <= 90) return 'recent-90d';
  if (ageDays <= 365) return 'recent-365d';
  return 'historical-over-365d';
}

function moneyType(text, amount, hasWorkflow) {
  if (!amount) return 'none';
  if (disqualifyingMoneyRe.test(text)) return 'revenue_or_valuation';
  if (/\b(?:suppose|imagine|example|let'?s say|making up numbers)\b/i.test(text)) return 'hypothetical';
  if (hasWorkflow && exactSpendContextRe.test(text)) return /\b(?:wage|salary|hourly rate|hire|hired)\b/i.test(text) ? 'exact_job_wage' : 'exact_job_spend';
  return exactSpendContextRe.test(text) ? 'adjacent_spend' : 'currency_mention';
}

async function getJson(url, source, purpose, window = 'current') {
  const started = Date.now();
  try {
    const res = await fetch(url, {headers: {'User-Agent': 'studio-hunt-buyer-reality/1.0'}});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    queries.push({query: url.replace(/([?&](?:key|token)=[^&]+)/gi, ''), source, window, resultCount: Array.isArray(body?.items) ? body.items.length : Array.isArray(body?.hits) ? body.hits.length : null, purpose, observedAt, elapsedMs: Date.now()-started});
    return body;
  } catch (e) {
    failures.push({source, url, window, status: 'error', error: String(e), fallbackAttempted: null, observedAt});
    return null;
  }
}

function add({source,url,publishedAt,actorType='unknown',actorEvidence=null,statementType,firsthand,buyer=null,trigger=null,input=null,repeatedAction=null,output=null,destination=null,frequency=null,timeSpent=null,priceOrWage=null,moneyType='none',currentTools=[],remainingManualWork=null,requestedOutcome=null,textExcerpt,artifactPath,caveat=null,author='unknown',dataset, productDomain=null, classificationConfidence='low', classificationReason=null}) {
  records.push({recordId:`br-${String(++seq).padStart(4,'0')}`,source,url,observedAt,publishedAt,window:windowFor(publishedAt),sourceLane:'buyer_reality',retrievalStatus:'verified',actorType,actorEvidence,statementType,firsthand,startupName:null,productDomain,founderHandle:null,buyer,trigger,input,repeatedAction,output,destination,frequency,timeSpent,priceOrWage,moneyType,commercialMetric:null,metricPeriod:null,currentTools,remainingManualWork,objection:null,requestedOutcome,textExcerpt,artifactPath,independenceKey:`${new URL(url).hostname}|${author}|none|${dataset}`,commercialStrength:['exact_job_spend','exact_job_wage'].includes(moneyType)?'medium':'none',classificationConfidence,classificationReason,caveat});
}

const sites = ['workplace','freelancing','money','academia','travel','diy','webmasters','salesforce','magento','wordpress','craftcms','law','patents','graphicdesign','writers','projectmanagement','gardening','homebrewing'];
for (const site of sites) {
  const url = `https://api.stackexchange.com/2.3/questions?site=${site}&pagesize=60&order=desc&sort=activity&filter=withbody`;
  const body = await getJson(url, `stackexchange:${site}`, 'Broad occupational question traversal; retain own workflows and exact-money observations');
  if (!body) continue;
  await fs.writeFile(path.join(out,`artifact-stackexchange-${site}.json`), JSON.stringify(body));
  let kept = 0;
  for (const q of body.items || []) {
    const text = clean(`${q.title}. ${q.body}`);
    if (!(workflowRe.test(text) || moneyRe.test(text))) continue;
    const exactMoney = text.match(moneyRe)?.[0] || null;
    const workflow = workflowRe.test(text);
    const firstPerson = ownWorkflowRe.test(text);
    const tools = [...new Set((text.match(/\b(?:Excel|Google Sheets|spreadsheet|Salesforce|WordPress|Magento|QuickBooks|Notion|Airtable|Jira|email|PDF)\b/gi)||[]).map(x=>x.toLowerCase()))];
    add({source:`stackexchange:${site}`,url:q.link,publishedAt:new Date(q.creation_date*1000).toISOString(),actorType:'unknown',actorEvidence:`Self-authored question on ${site}; occupation not inferred from community membership.`,statementType:firstPerson&&workflow?'own_workflow':'unknown',firsthand:firstPerson&&workflow,buyer:null,trigger:clean(q.title),input:null,repeatedAction:firstPerson&&workflow?text:null,output:null,destination:null,frequency:(text.match(/\b(?:daily|every day|weekly|every week|monthly|every month|each time|each client|each order)\b/i)||[])[0]||null,timeSpent:(text.match(/\b\d+(?:\.\d+)?\s*(?:minutes?|hours?|days?|weeks?)\b/i)||[])[0]||null,priceOrWage:exactMoney,moneyType:moneyType(text,exactMoney,firstPerson&&workflow),currentTools:tools,remainingManualWork:/manually/i.test(text)?text:null,requestedOutcome:q.title,textExcerpt:text,artifactPath:`${out}/artifact-stackexchange-${site}.json`,author:String(q.owner?.user_id||q.owner?.display_name||'unknown'),dataset:`stackexchange-${site}`,productDomain:q.link?new URL(q.link).hostname:null,classificationConfidence:'low',classificationReason:'Regex-selected first-person workflow lead; requires parent quote audit.',caveat:'Community membership does not establish buyer role; question title and forum destination are not job-sentence fields.'});
    if (++kept >= 8) break;
  }
  await sleep(120);
}

const hnTerms = ['"I pay"','"we pay"','"I paid"','"costs us"','"per month"','"per hour"','manually','spreadsheet','"every week"','"each month"'];
for (const term of hnTerms) {
  const url = `https://hn.algolia.com/api/v1/search_by_date?tags=ask_hn&hitsPerPage=100&query=${encodeURIComponent(term)}`;
  const body = await getJson(url,'hn_algolia_ask','Broad Ask HN buyer language discovery and hydration');
  if (!body) continue;
  const slug = term.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase();
  await fs.writeFile(path.join(out,`artifact-hn-${slug}.json`), JSON.stringify(body));
  let kept=0;
  for (const h of body.hits || []) {
    const text=clean(`${h.title||''}. ${h.story_text||h.comment_text||''}`);
    if (text.length<80 || !/\b(?:I|we|my|our)\b/i.test(text) || !(workflowRe.test(text)||moneyRe.test(text))) continue;
    const exactMoney=text.match(moneyRe)?.[0]||null;
    const workflow=workflowRe.test(text);
    const id=h.objectID;
    const ownWorkflow=workflow&&ownWorkflowRe.test(text);
    add({source:'hn_algolia_ask',url:`https://news.ycombinator.com/item?id=${id}`,publishedAt:h.created_at,actorType:'unknown',actorEvidence:'Ask HN author; role not explicitly established in extracted text.',statementType:ownWorkflow?'own_workflow':'unknown',firsthand:ownWorkflow,trigger:h.title||null,repeatedAction:ownWorkflow?text:null,output:null,destination:null,frequency:(text.match(/\b(?:daily|every day|weekly|every week|monthly|every month|each time|each client|each order)\b/i)||[])[0]||null,timeSpent:(text.match(/\b\d+(?:\.\d+)?\s*(?:minutes?|hours?|days?|weeks?)\b/i)||[])[0]||null,priceOrWage:exactMoney,moneyType:moneyType(text,exactMoney,ownWorkflow),currentTools:[...new Set((text.match(/\b(?:Excel|Google Sheets|spreadsheet|Salesforce|QuickBooks|Notion|Airtable|Jira|email|PDF)\b/gi)||[]).map(x=>x.toLowerCase()))],remainingManualWork:/manually/i.test(text)?text:null,requestedOutcome:h.title||null,textExcerpt:text,artifactPath:`${out}/artifact-hn-${slug}.json`,author:h.author||'unknown',dataset:'hn-ask',productDomain:'news.ycombinator.com',classificationConfidence:'low',classificationReason:'Regex-selected Ask HN workflow lead; requires parent quote audit.',caveat:'HN audience is developer-heavy; question title and HN destination are not job-sentence output/destination.'});
    if(++kept>=5) break;
  }
  await sleep(120);
}

// Prefer the most useful evidence if APIs returned more than the lane floor.
const uniq = [...new Map(records.map(r=>[`${r.url}|${r.textExcerpt}`,r])).values()];
await fs.writeFile(path.join(out,'records.jsonl'), uniq.map(x=>JSON.stringify(x)).join('\n')+'\n');
await fs.writeFile(path.join(out,'queries.jsonl'), queries.map(x=>JSON.stringify(x)).join('\n')+'\n');
await fs.writeFile(path.join(out,'failures.jsonl'), failures.map(x=>JSON.stringify(x)).join('\n')+(failures.length?'\n':''));
const countBy = (k) => Object.fromEntries([...new Set(uniq.map(x=>x[k]))].map(v=>[String(v),uniq.filter(x=>x[k]===v).length]));
const metrics={observedAt,totalRecords:uniq.length,retrievedVerified:uniq.filter(x=>x.retrievalStatus==='verified').length,currencyMentions:uniq.filter(x=>x.priceOrWage).length,qualifiedExactJobMoney:uniq.filter(x=>['exact_job_spend','exact_job_wage'].includes(x.moneyType)&&x.classificationConfidence!=='low').length,heuristicFirsthandLeads:uniq.filter(x=>x.firsthand).length,qualifiedFirsthand:uniq.filter(x=>x.firsthand&&x.classificationConfidence!=='low').length,qualifiedRepeatedWorkflow:uniq.filter(x=>x.firsthand&&x.classificationConfidence!=='low'&&x.frequency).length,completeJobSentences:uniq.filter(x=>['buyer','trigger','input','repeatedAction','output','destination'].every(k=>x[k])).length,uniqueIndependenceKeys:new Set(uniq.map(x=>x.independenceKey)).size,uniqueSourceLabels:new Set(uniq.map(x=>x.source)).size,uniqueHostDomains:new Set(uniq.map(x=>new URL(x.url).hostname)).size,bySource:countBy('source'),byWindow:countBy('window'),byActor:countBy('actorType'),byStatement:countBy('statementType'),byVerification:countBy('retrievalStatus'),missingFields:Object.fromEntries(['buyer','trigger','input','repeatedAction','output','destination','frequency','timeSpent','priceOrWage','currentTools','remainingManualWork'].map(k=>[k,uniq.filter(x=>x[k]==null||(Array.isArray(x[k])&&x[k].length===0)).length])),queryCount:queries.length,failureCount:failures.length,suspectedDuplicates:uniq.length-new Set(uniq.map(x=>x.url)).size};
await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify(metrics,null,2)+'\n');
console.log(JSON.stringify(metrics));
