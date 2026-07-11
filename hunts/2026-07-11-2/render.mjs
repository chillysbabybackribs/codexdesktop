import fs from 'node:fs';

const md = fs.readFileSync(new URL('./dossier.md', import.meta.url), 'utf8');
const inline = s => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>');
let html = '';
let list = null;
for (const raw of md.split('\n')) {
  const line = raw.trimEnd();
  const ordered = line.match(/^(\d+)\.\s+(.*)$/);
  const bullet = line.match(/^-\s+(.*)$/);
  if (!ordered && !bullet && list) { html += `</${list}>`; list = null; }
  if (ordered) { if (!list) { list='ol'; html+='<ol>'; } html += `<li>${inline(ordered[2])}</li>`; continue; }
  if (bullet) { if (!list) { list='ul'; html+='<ul>'; } html += `<li>${inline(bullet[1])}</li>`; continue; }
  if (!line) continue;
  const h = line.match(/^(#{1,4})\s+(.*)$/);
  if (h) { const n=h[1].length; html += `<h${n}>${inline(h[2])}</h${n}>`; continue; }
  if (line.startsWith('> ')) { html += `<blockquote>${inline(line.slice(2))}</blockquote>`; continue; }
  html += `<p>${inline(line)}</p>`;
}
if (list) html += `</${list}>`;
const out = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Studio Hunt 2026-07-11-2</title><style>
:root{color-scheme:light dark;--bg:#f5f3ee;--paper:#fffdf8;--ink:#22231f;--muted:#66685f;--line:#ddd8cb;--accent:#285f52}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.62 Inter,ui-sans-serif,system-ui,sans-serif}main{max-width:900px;margin:48px auto;padding:50px 58px;background:var(--paper);border:1px solid var(--line);border-radius:18px;box-shadow:0 18px 55px #1c292315}h1{font-size:2.25rem;margin:0 0 1.3rem}h2{margin-top:2.6rem;padding-top:1.4rem;border-top:1px solid var(--line)}h3{margin-top:2.1rem;color:var(--accent)}blockquote{margin:1rem 0;padding:14px 18px;border-left:4px solid var(--accent);background:#285f520b;font-size:1.08rem}li{margin:.42rem 0}a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}code{background:#7772;padding:.12rem .35rem;border-radius:4px}@media(prefers-color-scheme:dark){:root{--bg:#151714;--paper:#1d201c;--ink:#ecece5;--muted:#acaea4;--line:#393d36;--accent:#78c6ae}}@media(max-width:700px){main{margin:0;padding:28px 22px;border:0;border-radius:0}}
</style></head><body><main>${html}</main></body></html>`;
fs.writeFileSync(new URL('./dossier.html', import.meta.url), out);
console.log(JSON.stringify({ok:true,chars:out.length,output:new URL('./dossier.html', import.meta.url).pathname}));
