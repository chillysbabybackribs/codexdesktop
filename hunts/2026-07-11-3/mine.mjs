import fs from 'node:fs/promises'; import path from 'node:path';
const dir=path.resolve('hunts/2026-07-11-3/corpus');
const files=(await fs.readdir(dir)).filter(x=>x.endsWith('.txt')).sort();
const themes={inventory:/inventory|stock|reorder|purchase order/ig,booking:/booking|appointment|calendar/ig,invoice:/invoice|accounts receivable|payment reminder/ig,license:/license|subscription|seat|renewal/ig,rental:/rental|property management|tenant/ig,amazon:/amazon|sp-api|seller api/ig,volunteer:/volunteer|nonprofit/ig,migration:/migration|export|switching software/ig,wholesale:/wholesale|b2b|bulk order/ig};
const out=[];
for(const file of files){const s=await fs.readFile(path.join(dir,file),'utf8'); const title=s.match(/^Title: (.*)$/m)?.[1]||''; const url=s.match(/^URL: (.*)$/m)?.[1]||''; const lane=s.match(/^Lane: (.*)$/m)?.[1]||''; const hits={}; for(const [k,re] of Object.entries(themes)) hits[k]=(s.match(re)||[]).length; const money=[...s.matchAll(/(?:\$|USD\s?)[0-9][0-9,.]*(?:\s?(?:\/|per)\s?(?:month|year|hour))?/gi)].slice(0,12).map(x=>x[0]); const dates=[...s.matchAll(/\b(?:20[2-3][0-9]|January|February|March|April|May|June|July|August|September|October|November|December)\b/gi)].slice(0,12).map(x=>x[0]); out.push({file,title,url,lane,hits,money,dates});}
const summary={files:out.length,lanes:out.reduce((a,x)=>(a[x.lane]=(a[x.lane]||0)+1,a),{}),themes:Object.keys(themes).map(k=>({theme:k,files:out.filter(x=>x.hits[k]).length,mentions:out.reduce((a,x)=>a+x.hits[k],0)})),records:out};
await fs.writeFile(path.resolve('hunts/2026-07-11-3/mechanical.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({ok:true,files:summary.files,lanes:summary.lanes,themes:summary.themes}));
