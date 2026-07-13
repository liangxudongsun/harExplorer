#!/usr/bin/env node
/**
 * Build multi-tab texture viewer catalog from one or more HAR files.
 * Usage:
 *   node tools/scripts/build-texture-viewer-catalog.mjs [--out dir]
 *
 * Reads tools/texture-viewer/catalog-sources.json for tab definitions.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'fs';
import { dirname, join, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { buildSlotmillTab, buildPragmaticTab, buildCocosTab } from '../../core/src/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT_DIR = outIdx >= 0 ? args[outIdx + 1] : join(process.cwd(), 'dist', 'texture-viewer');
const sourcesPath = join(__dirname, '..', '..', 'web', 'catalog-sources.json');

const sources = JSON.parse(readFileSync(sourcesPath, 'utf8'));
mkdirSync(OUT_DIR, { recursive: true });

const tabs = [];
for (const src of sources) {
  const harPath = join(process.cwd(), src.har);
  console.log(`Building tab: ${src.label} (${src.type})`);
  const tab =
    src.type === 'pragmatic'
      ? buildPragmaticTab(harPath, OUT_DIR, src)
      : src.type === 'cocos'
        ? buildCocosTab(harPath, OUT_DIR, src)
        : buildSlotmillTab(harPath, OUT_DIR, src);
  tabs.push(tab);
}

const catalog = {
  builtAt: new Date().toISOString(),
  tabs,
};

writeFileSync(join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
// The viewer loads catalog.json at runtime, so index.html is a plain copy —
// this keeps the OUT_DIR self-contained for static hosting.
cpSync(join(__dirname, '..', '..', 'web', 'viewer', 'viewer.html'), join(OUT_DIR, 'index.html'));

const vendorSrc = join(__dirname, '..', '..', 'web', 'viewer', 'vendor');
const vendorOut = join(OUT_DIR, 'vendor');
if (existsSync(vendorSrc)) {
  mkdirSync(vendorOut, { recursive: true });
  cpSync(vendorSrc, vendorOut, { recursive: true });
}
// Standalone Spine 3.7 sub-player (iframe) + shared frame baker.
for (const extra of ['spine37-player.html', 'spine-bake.js']) {
  const src = join(__dirname, '..', '..', 'web', 'viewer', extra);
  if (existsSync(src)) cpSync(src, join(OUT_DIR, extra));
}
// Cocos particle preview shell (web-mobile build).
const particlePlayerSrc = join(__dirname, '..', '..', 'web', 'viewer', 'particle-player');
if (existsSync(particlePlayerSrc)) {
  cpSync(particlePlayerSrc, join(OUT_DIR, 'particle-player'), { recursive: true });
}

console.log(JSON.stringify({
  ok: true,
  out: OUT_DIR,
  tabs: tabs.map((t) => ({ id: t.id, label: t.label, textures: t.meta.total })),
}, null, 2));
