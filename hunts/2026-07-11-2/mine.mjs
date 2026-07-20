import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const corpus = new URL('./corpus/', import.meta.url);
const themes = {
  coaching: /coach|client onboarding/gi,
  hr_ops: /offboard|onboard|employee lifecycle|human resources/gi,
  chargebacks: /chargeback|dispute evidence/gi,
  brand_monitoring: /counterfeit|unauthorized seller|grey market|brand protection/gi,
  client_portals: /client portal|freelancer|honeybook|bonsai/gi,
  reporting: /client report|dashboard|weekly report|spreadsheet/gi,
  dpp: /digital product passport|DPP/gi,
  eudr: /EUDR|deforestation|due diligence statement/gi,
  amazon_agents: /Amazon|AI agent|SP-API|human authorization/gi,
  ecommerce_tax: /sales tax|nexus|tax registration/gi,
};
const files = fs.readdirSync(corpus).filter(f => f.endsWith('.txt')).sort();
const rows = files.map(file => {
  const text = fs.readFileSync(new URL(file, corpus), 'utf8');
  const hits = Object.fromEntries(Object.entries(themes).map(([k, re]) => [k, (text.match(re) || []).length]));
  return {
    file,
    words: text.trim().split(/\s+/).length,
    money: [...new Set(text.match(/(?:[$€£]\s?\d[\d,.]*(?:\s?(?:USD|EUR|GBP))?|\d[\d,.]*\s?(?:USD|EUR|GBP))/gi) || [])].slice(0, 12),
    dates: [...new Set(text.match(/(?:20\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s*20\d{2})?)/gi) || [])].slice(0, 12),
    counts: [...new Set(text.match(/\b\d[\d,.]*\+?\s+(?:sales|reviews|customers|clients|sellers|hours|days|templates|workflows)\b/gi) || [])].slice(0, 12),
    hits,
  };
});
const totals = Object.fromEntries(Object.keys(themes).map(k => [k, rows.filter(r => r.hits[k] > 0).length]));
fs.writeFileSync(new URL('./mechanical.json', import.meta.url), JSON.stringify({files: rows.length, totals, rows}, null, 2));
console.log(JSON.stringify({ok:true, files:rows.length, themes:totals, output:fileURLToPath(new URL('./mechanical.json', import.meta.url))}));
