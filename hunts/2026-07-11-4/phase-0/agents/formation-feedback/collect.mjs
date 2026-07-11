import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/home/dp/Desktop/soloapps/codexdesktop';
const OUT = path.join(ROOT, 'hunts/2026-07-11-4/phase-0/agents/formation-feedback');
const SNAP = path.join(ROOT, 'market-motion/hn/snapshots');
const RUN = '2026-07-11-4-formation-feedback';
const observedAt = new Date().toISOString();
const now = Math.floor(new Date('2026-07-11T12:00:00Z').getTime() / 1000);
const day = 86400;

const windows = [
  ['recent-30d', now - 30 * day, now],
  ['prior-30d', now - 60 * day, now - 30 * day],
  ['recent-90d', now - 90 * day, now],
  ['prior-90d', now - 180 * day, now - 90 * day],
  ['prior-year-comparable-90d', now - 455 * day, now - 365 * day],
];

const queries = [];
const failures = [];
const records = [];
const seen = new Set();
const storyMeta = new Map();

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(SNAP, { recursive: true });

function clean(s) {
  if (!s) return null;
  return String(s).replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() || null;
}

function domainOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80); }

async function getJson(url, context) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'studio-hunt-phase0/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) {
        failures.push({ observedAt, source: 'HN Algolia API', url, context, error: String(err), fallbacksAttempted: ['three API retries'], status: 'error' });
        return null;
      }
      await new Promise(r => setTimeout(r, attempt * 750));
    }
  }
}

function classifyStory(hit, tag) {
  const text = clean(hit.story_text || hit.comment_text || hit.title);
  const title = clean(hit.title || hit.story_title);
  const isShow = tag === 'show_hn';
  const workflow = /\b(i|we|our|my)\b.{0,80}\b(use|used|built|made|run|manage|handle|track|spend|pay|export|import|copy|review|process|work)\b/i.test(`${title} ${text}`);
  return {
    actorType: isShow ? 'startup_founder' : (workflow ? 'buyer_operator' : 'unknown'),
    actorEvidence: isShow ? 'Author submitted a Show HN launch.' : (workflow ? 'First-person workflow language in Ask HN submission.' : null),
    statementType: isShow ? 'product_pitch' : (workflow ? 'own_workflow' : 'market_opinion'),
    firsthand: !isShow && workflow,
  };
}

function classifyComment(hit) {
  const t = clean(hit.comment_text) || '';
  const workflow = /\b(i|we|our|my)\b.{0,100}\b(use|used|built|made|run|manage|handle|track|spend|pay|export|import|copy|review|process|work|tried|switched)\b/i.test(t);
  const purchase = /\b(i|we|our|my)\b.{0,90}\b(pay|paid|bought|subscribe|subscription|cost|\$\d)\b/i.test(t);
  const workaround = /\b(i|we|our|my)\b.{0,100}\b(spreadsheet|script|manual|manually|workaround|copy and paste|csv|zapier)\b/i.test(t);
  const request = /\b(would|wish|need|please|missing|support|feature|integration|export|import|api)\b/i.test(t);
  return {
    actorType: workflow || purchase || workaround ? 'buyer_operator' : 'unknown',
    actorEvidence: workflow || purchase || workaround ? 'First-person use, purchase, or workaround language in comment.' : null,
    statementType: purchase ? 'own_purchase' : workaround ? 'own_workaround' : workflow ? 'own_workflow' : request ? 'feature_request' : 'market_opinion',
    firsthand: workflow || purchase || workaround,
  };
}

function addRecord(hit, window, tag, artifactRel, storyId = null) {
  const id = String(hit.objectID);
  if (seen.has(id)) return;
  seen.add(id);
  const isComment = Boolean(hit.comment_text);
  const meta = isComment ? classifyComment(hit) : classifyStory(hit, tag);
  const url = isComment ? `https://news.ycombinator.com/item?id=${id}` : (hit.url || `https://news.ycombinator.com/item?id=${id}`);
  const productDomain = isComment ? (storyMeta.get(String(storyId))?.domain || null) : domainOf(hit.url);
  const title = clean(hit.title || hit.story_title);
  const excerpt = clean(hit.comment_text || hit.story_text || hit.title);
  const startupName = tag === 'show_hn' && title ? title.replace(/^Show HN:\s*/i, '').split(/[—–:\-|]/)[0].trim().slice(0, 120) : null;
  const obstruction = isComment && /\b(but|however|problem|issue|missing|can't|cannot|doesn't|won't|expensive|slow|manual|privacy|trust)\b/i.test(excerpt || '') ? excerpt.slice(0, 500) : null;
  const requested = isComment && meta.statementType === 'feature_request' ? excerpt.slice(0, 500) : null;
  const price = excerpt?.match(/(?:\$|USD\s?)\d[\d,.]*(?:\s*\/\s*(?:mo|month|yr|year|hour))?/i)?.[0] || null;
  const currentTools = [...new Set((excerpt?.match(/\b(?:Excel|Google Sheets|Sheets|Notion|Slack|Zapier|GitHub|Jira|Trello|Airtable|CSV|Python|ChatGPT)\b/gi) || []).map(x => x.toLowerCase()))];
  records.push({
    recordId: `hn-${isComment ? 'comment' : 'story'}-${id}`,
    source: 'Hacker News via official Algolia API', url, observedAt,
    publishedAt: hit.created_at || null, window, sourceLane: 'formation_feedback', retrievalStatus: 'verified',
    ...meta, startupName, productDomain, founderHandle: isComment ? null : (hit.author || null),
    buyer: meta.actorType === 'buyer_operator' ? 'HN commenter or Ask HN author describing own context' : null,
    trigger: null, input: null, repeatedAction: meta.firsthand ? excerpt?.slice(0, 500) : null,
    output: null, destination: null, frequency: excerpt?.match(/\b(?:daily|weekly|monthly|every day|each day|every week|each week|per month)\b/i)?.[0] || null,
    timeSpent: excerpt?.match(/\b\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?|days?)\b/i)?.[0] || null,
    priceOrWage: price, commercialMetric: isComment ? null : { points: hit.points ?? 0, comments: hit.num_comments ?? 0 },
    metricPeriod: null, currentTools,
    remainingManualWork: meta.statementType === 'own_workaround' ? excerpt?.slice(0, 500) : null,
    objection: obstruction, requestedOutcome: requested, textExcerpt: excerpt?.slice(0, 1200) || title,
    artifactPath: artifactRel,
    independenceKey: [productDomain || 'news.ycombinator.com', hit.author || 'unknown', startupName || storyId || id, 'hn-algolia'].map(slug).join('|'),
    commercialStrength: price ? 'medium' : 'none',
    caveat: isComment ? `HN comment; parent story ${storyId}; actor classification based only on quoted text.` : `${tag === 'show_hn' ? 'Launch is supply evidence only.' : 'Ask HN submission'} HN id ${id}.`,
    hn: { id, parentId: hit.parent_id ? String(hit.parent_id) : null, storyId: storyId ? String(storyId) : null, author: hit.author || null, title, points: hit.points ?? null, commentCount: hit.num_comments ?? null },
  });
  if (!isComment) storyMeta.set(id, { domain: productDomain, tag, title, artifactRel });
}

const selectedStories = [];
for (const [window, start, end] of windows) {
  for (const tag of ['show_hn', 'ask_hn']) {
    const params = new URLSearchParams({ tags: tag, numericFilters: `created_at_i>${start},created_at_i<${end}`, hitsPerPage: '60', page: '0' });
    const url = `https://hn.algolia.com/api/v1/search_by_date?${params}`;
    const data = await getJson(url, { window, tag });
    if (!data) continue;
    const artifactRel = `market-motion/hn/snapshots/${RUN}-${window}-${tag}.json`;
    await fs.writeFile(path.join(ROOT, artifactRel), JSON.stringify({ observedAt, window, start, end, tag, response: data }, null, 2));
    queries.push({ observedAt, source: 'HN Algolia API', window, query: `tags=${tag}; created_at_i>${start},created_at_i<${end}`, url, resultCount: data.hits?.length || 0, totalHits: data.nbHits ?? null, pagesFetched: 1, purpose: tag === 'show_hn' ? 'formation, positioning, domains, founders, persistence' : 'own problems, purchases, internal tools, workarounds, replacement searches', artifactPath: artifactRel });
    const ranked = [...(data.hits || [])].sort((a,b) => ((b.num_comments||0)*2 + (b.points||0)) - ((a.num_comments||0)*2 + (a.points||0))).slice(0, 24);
    for (const hit of ranked) {
      addRecord(hit, window, tag, artifactRel);
      selectedStories.push({ id: String(hit.objectID), window, tag, score: (hit.num_comments||0)*2 + (hit.points||0) });
    }
  }
}

const commentTargets = [...new Map(selectedStories.sort((a,b)=>b.score-a.score).map(x=>[x.id,x])).values()].slice(0, 36);
for (const target of commentTargets) {
  const params = new URLSearchParams({ tags: `comment,story_${target.id}`, hitsPerPage: '20', page: '0' });
  const url = `https://hn.algolia.com/api/v1/search_by_date?${params}`;
  const data = await getJson(url, { storyId: target.id, purpose: 'comment hydration' });
  if (!data) continue;
  const artifactRel = `market-motion/hn/snapshots/${RUN}-comments-story-${target.id}.json`;
  await fs.writeFile(path.join(ROOT, artifactRel), JSON.stringify({ observedAt, target, response: data }, null, 2));
  queries.push({ observedAt, source: 'HN Algolia API', window: target.window, query: `tags=comment,story_${target.id}`, url, resultCount: data.hits?.length || 0, totalHits: data.nbHits ?? null, pagesFetched: 1, purpose: 'objections, missing segments, integrations, approval work, exports, trust failures, and manual residue', artifactPath: artifactRel });
  const useful = (data.hits || []).filter(h => clean(h.comment_text)?.length >= 80).slice(0, 8);
  for (const hit of useful) addRecord(hit, target.window, target.tag, artifactRel, target.id);
}

await fs.writeFile(path.join(OUT, 'records.jsonl'), records.map(x => JSON.stringify(x)).join('\n') + '\n');
await fs.writeFile(path.join(OUT, 'queries.jsonl'), queries.map(x => JSON.stringify(x)).join('\n') + '\n');
await fs.writeFile(path.join(OUT, 'failures.jsonl'), failures.map(x => JSON.stringify(x)).join('\n') + (failures.length ? '\n' : ''));

const countBy = (key) => records.reduce((a,r) => { const v = r[key] ?? 'null'; a[v]=(a[v]||0)+1; return a; }, {});
const metrics = {
  observedAt, lane: 'formation_feedback', totalRecords: records.length,
  verifiedRecords: records.filter(r=>r.retrievalStatus==='verified').length,
  stories: records.filter(r=>r.recordId.includes('-story-')).length,
  comments: records.filter(r=>r.recordId.includes('-comment-')).length,
  firsthand: records.filter(r=>r.firsthand).length,
  exactMoney: records.filter(r=>r.priceOrWage).length,
  uniqueAuthors: new Set(records.map(r=>r.hn.author).filter(Boolean)).size,
  uniqueProductDomains: new Set(records.map(r=>r.productDomain).filter(Boolean)).size,
  suspectedDuplicateIndependenceKeys: Object.entries(records.reduce((a,r)=>(a[r.independenceKey]=(a[r.independenceKey]||0)+1,a),{})).filter(([,n])=>n>1).map(([key,count])=>({key,count})),
  bySource: countBy('source'), byWindow: countBy('window'), byActor: countBy('actorType'),
  byStatement: countBy('statementType'), byVerification: countBy('retrievalStatus'),
  missingFields: ['productDomain','actorEvidence','buyer','trigger','input','repeatedAction','output','destination','frequency','timeSpent','priceOrWage','remainingManualWork','objection','requestedOutcome'].reduce((a,k)=>(a[k]=records.filter(r=>r[k]==null).length,a),{}),
  queryCount: queries.length, failureCount: failures.length,
  coverageNotes: ['Show HN and Ask HN use official Algolia API across recent/prior 30d, recent/prior 90d, and prior-year comparable 90d.', 'High-engagement stories were comment-hydrated; launch records remain supply evidence only.', 'Actor and statement labels are conservative text classifications and require parent audit.'],
};
await fs.writeFile(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
console.log(JSON.stringify(metrics, null, 2));
