import fs from 'node:fs';
import path from 'node:path';

const corpus = new URL('./corpus/', import.meta.url);
const files = fs.readdirSync(corpus).filter((name) => name.endsWith('.txt'));
const themes = {
  bookkeeping: /quickbooks|bookkeep|reconcil|payroll/gi,
  contractor1099: /1099|w-9|contractor|vendor/gi,
  attribution: /attribution|shopify|ga4|tracking|triple whale/gi,
  performance: /performance review|employee review|appraisal|kpi/gi,
  scheduling: /scheduling|appointment|no-show|booking/gi,
  creatorMarketing: /social media|email campaign|content planner|buffer/gi,
  pricingInventory: /pricing calculator|profit margin|inventory|product cost/gi,
  compliance: /compliance|deadline|regulation|reporting rule/gi,
};

const records = files.map((file) => {
  const text = fs.readFileSync(new URL(file, corpus), 'utf8');
  const hits = Object.fromEntries(Object.entries(themes).map(([name, re]) => [name, (text.match(re) || []).length]));
  return {
    file,
    title: (text.match(/^#\s+(.+)$/m) || [,'Untitled'])[1],
    dollars: [...new Set(text.match(/\$\s?\d[\d,.]*(?:\.\d{1,2})?/g) || [])].slice(0, 12),
    counts: [...new Set(text.match(/\(?\d+(?:\.\d+)?k\+?\)?|\d[\d,]*\+\s+(?:items|reviews|sales)/gi) || [])].slice(0, 12),
    dates: [...new Set(text.match(/\b(?:20(?:2[4-9]|3\d)|January|February|March|April|May|June|July|August|September|October|November|December)\b/gi) || [])].slice(0, 12),
    hits,
  };
});

const totals = Object.fromEntries(Object.keys(themes).map((theme) => [theme, records.reduce((n, r) => n + r.hits[theme], 0)]));
const ranked = records.map((r) => ({...r, score: Object.values(r.hits).filter((n) => n > 0).length})).sort((a,b) => b.score - a.score);
process.stdout.write(JSON.stringify({ok:true, files:files.length, totals, output:'mechanical.json'}, null, 2) + '\n');
fs.writeFileSync(new URL('./mechanical.json', import.meta.url), JSON.stringify({generatedAt:new Date().toISOString(), totals, records:ranked}, null, 2));
