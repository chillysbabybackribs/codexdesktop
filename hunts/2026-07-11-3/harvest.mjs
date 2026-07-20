import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('hunts/2026-07-11-3');
const corpus = path.join(root, 'corpus');
await fs.mkdir(corpus, { recursive: true });

async function key() {
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
  for (const file of ['.env']) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const m = raw.match(/^BRAVE_API_KEY\s*=\s*["']?([^\s"']+)/m);
      if (m) return m[1];
    } catch {}
  }
  return '';
}

const queries = [
  ['spend','site:news.ycombinator.com "pay" "manual" spreadsheet workflow'],
  ['spend','site:gumroad.com "template" operations tracker price'],
  ['workaround','site:zapier.com/apps/integrations "popular workflows" inventory appointment invoice'],
  ['workaround','site:airtable.com/universe inventory compliance client portal template'],
  ['demand','site:wordpress.org/support/plugin "not working" booking invoice membership 2026'],
  ['incumbent','site:wordpress.org/plugins "Last updated" booking inventory export'],
  ['demand','site:apps.shopify.com reviews "support" "expensive" inventory returns wholesale'],
  ['incumbent','software price increase backlash shutdown sunset small business tool 2025 2026'],
  ['why-now','site:federalregister.gov 2026 small business reporting deadline platform seller'],
  ['why-now','2026 API policy change sellers creators small business software'],
  ['spend','virtual assistant job manual reconciliation spreadsheet invoices listings'],
  ['workaround','Google Sheets template paid salon property manager nonprofit inventory'],
  ['demand','forum "I have to manually" reconcile bookings invoices inventory'],
  ['demand','forum "spreadsheet" "wish there was" property manager salon creator'],
  ['incumbent','acquired neglected software complaints export migration 2025'],
];

const token = await key();
if (!token) throw new Error('BRAVE_API_KEY not found');
const discovered = [];
for (const [lane, q] of queries) {
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q', q); u.searchParams.set('count', '8');
  const res = await fetch(u, { headers: { 'X-Subscription-Token': token, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const json = await res.json();
  for (const x of json.web?.results || []) discovered.push({lane, query:q, url:x.url, title:x.title||'', snippet:x.description||''});
  await new Promise(r => setTimeout(r, 1050));
}

const unique = [...new Map(discovered.map(x => [x.url, x])).values()];
const challenge = /captcha|access denied|verify you are human|enable javascript|cloudflare|sign in to continue/i;
const directoryDomains = /news\.ycombinator\.com|gumroad\.com|zapier\.com|airtable\.com|wordpress\.org|apps\.shopify\.com|federalregister\.gov/i;
function clean(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'")
    .replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
}
let cursor = 0, verified = 0;
const records = [];
async function worker() {
  while (cursor < unique.length && verified < 72) {
    const i = cursor++, item = unique[i];
    try {
      const res = await fetch(item.url, { redirect:'follow', headers:{'user-agent':'Mozilla/5.0 (compatible; StudioHunt/1.0)'} });
      const html = await res.text(); const text = clean(html); const words = text.split(/\s+/).length;
      const ok = res.ok && words >= 250 && !challenge.test(text.slice(0,1200));
      const rec = {...item, finalUrl:res.url, status:ok?'verified':'discovered', http:res.status, words, sourceClass:directoryDomains.test(item.url)?'directory':'frontier'};
      records.push(rec);
      if (ok) {
        const n = String(++verified).padStart(3,'0');
        await fs.writeFile(path.join(corpus,`${n}-${item.lane}.txt`), `Title: ${item.title}\nURL: ${item.url}\nFinal-URL: ${res.url}\nLane: ${item.lane}\nSource-Class: ${rec.sourceClass}\nStatus: verified\nObserved: 2026-07-11\nWords: ${words}\nQuery: ${item.query}\n\n${text.slice(0,30000)}\n`);
      }
    } catch (e) { records.push({...item,status:'discovered',error:String(e),sourceClass:directoryDomains.test(item.url)?'directory':'frontier'}); }
  }
}
await Promise.all(Array.from({length:12}, worker));
await fs.writeFile(path.join(root,'harvest-index.json'), JSON.stringify(records,null,2));
const counts = records.reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1;if(r.status==='verified'){a[r.lane]=(a[r.lane]||0)+1;a[r.sourceClass]=(a[r.sourceClass]||0)+1;}return a;},{});
console.log(JSON.stringify({ok:true,discovered:unique.length,attempted:records.length,counts,corpus}));
