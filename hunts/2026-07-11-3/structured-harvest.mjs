import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('hunts/2026-07-11-3'), corpus=path.join(root,'corpus');
const terms=['booking','rental management','wholesale order','client portal','invoice reminder','volunteer management'];
const rows=[];
for(const term of terms){
  const u=new URL('https://api.wordpress.org/plugins/info/1.2/');
  u.searchParams.set('action','query_plugins');u.searchParams.set('request[search]',term);u.searchParams.set('request[per_page]','4');
  const res=await fetch(u); const j=await res.json();
  for(const p of (j.plugins||[]).slice(0,3)) rows.push({term,p});
}
let n=0;
for(const {term,p} of rows.slice(0,18)){
  const num=String(59+n++).padStart(3,'0');
  const body=`Title: ${p.name}\nURL: https://wordpress.org/plugins/${p.slug}/\nLane: incumbent\nSource-Class: directory\nStatus: verified\nObserved: 2026-07-11\nStructured-Source: WordPress Plugin API\n\nSearch niche: ${term}\nName: ${p.name}\nSlug: ${p.slug}\nVersion: ${p.version}\nLast updated: ${p.last_updated}\nActive installs: ${p.active_installs}\nRating: ${p.rating}\nRatings: ${p.num_ratings}\nSupport threads: ${p.support_threads}\nResolved support threads: ${p.support_threads_resolved}\nShort description: ${String(p.short_description||'').replace(/<[^>]+>/g,' ')}\nDescription: ${String(p.description||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,12000)}\n`;
  await fs.writeFile(path.join(corpus,`${num}-incumbent.txt`),body);
}
console.log(JSON.stringify({ok:true,verified:n,source:'WordPress Plugin API'}));
