#!/usr/bin/env node
/** Quick HAR URL/MIME probe - no LLM read */
import { readFileSync } from 'fs';

const har = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const entries = har.log?.entries ?? [];

const byExt = new Map();
const byMime = new Map();
const samples = [];

for (const e of entries) {
  const url = e.request?.url ?? '';
  const mime = e.response?.content?.mimeType ?? '(none)';
  const size = e.response?.content?.size ?? 0;
  let ext = '(no-ext)';
  try {
    ext = (new URL(url).pathname.match(/\.[^./?]+$/)?.[0] ?? '(no-ext)').toLowerCase();
  } catch {}

  byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  byMime.set(mime, (byMime.get(mime) ?? 0) + 1);

  if (samples.length < 80) {
    samples.push({ ext, mime, size, path: url.replace(/^https?:\/\/[^/]+/, '').slice(0, 100) });
  }
}

console.log('=== Extension counts ===');
[...byExt.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(v, k));

console.log('\n=== MIME counts ===');
[...byMime.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(v, k));

console.log('\n=== Sample entries ===');
samples.forEach(s => console.log(`${s.ext}\t${s.mime}\t${s.size}\t${s.path}`));

// assets path filter
const assets = entries.filter(e => /\/assets\//i.test(e.request?.url ?? ''));
console.log(`\n=== /assets/ entries: ${assets.length} ===`);
const assetExt = new Map();
for (const e of assets) {
  const url = e.request.url;
  let ext = '(no-ext)';
  try { ext = (new URL(url).pathname.match(/\.[^./?]+$/)?.[0] ?? '(no-ext)').toLowerCase(); } catch {}
  assetExt.set(ext, (assetExt.get(ext) ?? 0) + 1);
}
[...assetExt.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(v, k));

// top sizes
const sized = entries
  .map(e => ({
    size: e.response?.content?.size ?? 0,
    mime: e.response?.content?.mimeType ?? '',
    path: (e.request?.url ?? '').replace(/^https?:\/\/[^/]+/, ''),
  }))
  .filter(x => x.size > 0)
  .sort((a,b) => b.size - a.size)
  .slice(0, 25);
console.log('\n=== Top 25 by content.size ===');
sized.forEach(s => console.log(`${(s.size/1024).toFixed(1)}KB\t${s.mime}\t${s.path.slice(0,90)}`));
