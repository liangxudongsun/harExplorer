#!/usr/bin/env node
/**
 * Diff two HAR files — URL sets, extensions, texture-relevant stats.
 * Usage: node diff-har.mjs <baseline.har> <device.har>
 */
import { readFileSync } from 'fs';

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error('Usage: node diff-har.mjs <baseline.har> <device.har>');
  process.exit(1);
}

function load(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function pathOf(url) {
  try {
    return new URL(url).pathname + (new URL(url).search?.split('&t=')[0] ?? '');
  } catch {
    return url;
  }
}

function normPath(url) {
  return pathOf(url).replace(/\?t=[^&]+/, '');
}

function sizeOf(entry) {
  const c = entry.response?.content;
  if (c?.size > 0) return c.size;
  const cl = (entry.response?.headers ?? []).find((h) => h.name.toLowerCase() === 'content-length');
  return cl ? parseInt(cl.value, 10) : 0;
}

function summarize(har, tag) {
  const entries = har.log?.entries ?? [];
  const urls = new Map();
  for (const e of entries) {
    const key = normPath(e.request.url);
    const prev = urls.get(key);
    const sz = sizeOf(e);
    if (!prev || sz > prev.size) urls.set(key, { url: e.request.url, size: sz, mime: e.response?.content?.mimeType ?? '' });
  }

  const exts = new Map();
  let texBytes = 0;
  let texCount = 0;
  for (const { url, size, mime } of urls.values()) {
    let ext = '(none)';
    try { ext = (new URL(url).pathname.match(/\.[^./?]+$/)?.[0] ?? '(none)').toLowerCase(); } catch {}
    exts.set(ext, (exts.get(ext) ?? 0) + 1);
    if (/\.(avif|png|jpg|jpeg|webp|ktx|astc)/i.test(url) || /^image\//.test(mime)) {
      texCount++;
      texBytes += size;
    }
  }

  return { tag, total: entries.length, unique: urls.size, exts, texCount, texBytes, urls };
}

const A = summarize(load(aPath), 'A');
const B = summarize(load(bPath), 'B');

console.log('\n========== HAR Diff ==========\n');
console.log(`A: ${aPath}`);
console.log(`B: ${bPath}\n`);

console.log('--- Counts ---');
console.log(`  entries:     ${A.total} → ${B.total}`);
console.log(`  unique URLs: ${A.unique} → ${B.unique}`);
console.log(`  textures:    ${A.texCount} (${(A.texBytes / 1024 / 1024).toFixed(2)} MB) → ${B.texCount} (${(B.texBytes / 1024 / 1024).toFixed(2)} MB)`);

console.log('\n--- Extension counts ---');
const allExt = new Set([...A.exts.keys(), ...B.exts.keys()]);
for (const ext of [...allExt].sort()) {
  const a = A.exts.get(ext) ?? 0;
  const b = B.exts.get(ext) ?? 0;
  if (a !== b) console.log(`  ${ext.padEnd(8)} ${String(a).padStart(4)} → ${String(b).padStart(4)}`);
}

const onlyA = [...A.urls.keys()].filter((k) => !B.urls.has(k));
const onlyB = [...B.urls.keys()].filter((k) => !A.urls.has(k));
const common = [...A.urls.keys()].filter((k) => B.urls.has(k));

console.log(`\n--- URL set ---`);
console.log(`  only A: ${onlyA.length}  only B: ${onlyB.length}  common: ${common.length}`);

console.log('\n--- Only in A (desktop?) top 15 ---');
onlyA.slice(0, 15).forEach((k) => console.log(`  ${A.urls.get(k).size ? (A.urls.get(k).size / 1024).toFixed(0) + 'KB' : '?'}  ${k}`));

console.log('\n--- Only in B (mobile/device?) top 15 ---');
onlyB.slice(0, 15).forEach((k) => console.log(`  ${B.urls.get(k).size ? (B.urls.get(k).size / 1024).toFixed(0) + 'KB' : '?'}  ${k}`));

console.log('\n--- Format swaps (avif↔jpg same path prefix) ---');
for (const k of common) {
  const a = A.urls.get(k);
  const b = B.urls.get(k);
  const ae = k.match(/\.[^./?]+$/)?.[0] ?? '';
  const be = b.url.match(/\.[^./?]+$/)?.[0] ?? '';
  if (ae !== be) console.log(`  ${k.replace(/\.[^./?]+$/, '')}  ${ae} → ${be}`);
}

// loading screen format check
const loadA = [...A.urls.keys()].find((k) => k.includes('loading-screen') && /landscape/i.test(k));
const loadB = [...B.urls.keys()].find((k) => k.includes('loading-screen') && /landscape/i.test(k));
if (loadA || loadB) {
  console.log('\n--- Loading screen ---');
  console.log(`  A: ${loadA ?? '(none)'}`);
  console.log(`  B: ${loadB ?? '(none)'}`);
}

console.log('');
