#!/usr/bin/env node
/**
 * 从 HAR 提取贴图写入 cdn-cache，并对仍带 ?sign= 的 remote URL 尝试在线拉取。
 *
 * Usage:
 *   node scripts/hydrate-cdn-cache.mjs path/to/file.har [--out dist/texture-viewer]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  buildCocosTab,
  detectEngine,
  hydrateTabFromSignedUrls,
} from '../packages/core/src/index.mjs';

const args = process.argv.slice(2);
const harPath = args.find((a) => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const outDir =
  outIdx >= 0
    ? resolve(args[outIdx + 1])
    : resolve(process.cwd(), 'dist', 'texture-viewer');

if (!harPath || !existsSync(harPath)) {
  console.error('Usage: node scripts/hydrate-cdn-cache.mjs <file.har> [--out dir]');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const har = JSON.parse(readFileSync(harPath, 'utf8'));
const entries = har.log?.entries ?? [];
const pageTitle = har.log?.pages?.[0]?.title ?? '';
const detection = detectEngine(entries, pageTitle);
const id =
  String(harPath)
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.har$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 60) || `har-${Date.now()}`;

const tab = buildCocosTab(harPath, outDir, {
  id,
  label: pageTitle?.split('?')[0]?.slice(0, 48) || id,
  type: detection.engine,
});

console.log(
  `build: engine=${detection.engine}/${detection.cocosMajor ?? '?'} ` +
    `embedded=${tab.meta.embedded} remote=${tab.meta.remote} ` +
    `fromCdnCache=${tab.meta.fromCdnCache ?? 0}`
);

const hyd = await hydrateTabFromSignedUrls(tab, outDir, id, {
  concurrency: 8,
  timeoutMs: 20000,
});
console.log(
  `hydrate: fetched=${hyd.fetched} failed=${hyd.failed} pending=${hyd.pending}`
);
console.log(
  `final: embedded=${tab.meta.embedded} remote=${tab.meta.remote}`
);
console.log(`cdn-cache → ${join(outDir, 'cdn-cache')}`);

const catalogPath = join(outDir, 'catalog.json');
let catalog = { builtAt: new Date().toISOString(), tabs: [] };
if (existsSync(catalogPath)) {
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch {
    /* ignore */
  }
}
catalog.tabs = (catalog.tabs || []).filter((t) => t.id !== id);
catalog.tabs.push(tab);
catalog.builtAt = new Date().toISOString();
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
console.log(`catalog updated: ${catalogPath}`);
