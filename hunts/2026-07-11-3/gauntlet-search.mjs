import fs from 'node:fs/promises';
let token=process.env.BRAVE_API_KEY||''; if(!token){const e=await fs.readFile('.env','utf8').catch(()=>"");token=e.match(/^BRAVE_API_KEY\s*=\s*["']?([^\s"']+)/m)?.[1]||'';} if(!token)throw new Error('BRAVE_API_KEY missing');
const candidates={
  'inventory-exception-desk':'Shopify inventory purchase order exception management app',
  'm365-renewal-sweep':'Microsoft 365 SMB license optimization tool unused seats',
  'ar-reconcile-desk':'accounts receivable reconciliation virtual assistant software exception queue',
  'property-cutover-preflight':'property management software migration validation tool',
  'salon-stock-tracker':'salon inventory reorder software app',
  'wordpress-booking-migrator':'WordPress booking plugin migration tool',
  'woocommerce-wholesale-onboarding':'WooCommerce wholesale customer onboarding portal plugin',
  'volunteer-roster-sync':'volunteer management scheduling software nonprofit',
  'amazon-api-cost-guard':'Amazon SP-API cost monitoring fees tool 2026',
  'client-portal-exporter':'WordPress client portal export migration tool'
};
const out=[]; for(const [id,q] of Object.entries(candidates)){const u=new URL('https://api.search.brave.com/res/v1/web/search');u.searchParams.set('q',q);u.searchParams.set('count','5');const r=await fetch(u,{headers:{'X-Subscription-Token':token,Accept:'application/json'}});const j=await r.json();out.push({id,query:q,results:(j.web?.results||[]).slice(0,5).map(x=>({title:x.title,url:x.url,description:x.description}))});await new Promise(x=>setTimeout(x,1050));}
await fs.writeFile('hunts/2026-07-11-3/gauntlet.json',JSON.stringify(out,null,2));console.log(JSON.stringify({ok:true,candidates:out.length,results:out.reduce((a,x)=>a+x.results.length,0)}));
