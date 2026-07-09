#!/usr/bin/env node
/**
 * Extract Cocos Creator Spine packs from HAR into Creator/Spine import folders.
 *
 * Usage:
 *   node tools/scripts/extract-cocos-spine-packs.mjs <file.har> [options]
 *
 * Options:
 *   --out <dir>          Output root (default: dist/spine-export/<har-basename>)
 *   --only symbol        Regular symbol_* only (excludes scatter)
 *   --only scatter       Scatter only (symbol_15, symbol_16 in Golden Seth)
 *   --only all           symbol + scatter (default)
 *   --names a,b,c        Export specific pack names only
 *   --layout flat        <out>/<name>/* (default)
 *   --layout wrapper     <out>/symbolAnimation_<name>_spine/<name>/*
 *   --skip-missing       Skip packs with missing atlas texture pages
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { extractCocosAnimationPacks, parseAtlasPages, skeletonJsonForExport } from '../../core/src/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEXTURE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
const TEXTURE_MIME = /^image\//;
const SCATTER_NAMES = new Set(['symbol_15', 'symbol_16']);

function parseArgs(argv) {
  const positional = [];
  let out = null;
  let only = 'all';
  let layout = 'flat';
  let skipMissing = false;
  let names = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--only') only = argv[++i];
    else if (a === '--layout') layout = argv[++i];
    else if (a === '--names') names = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--skip-missing') skipMissing = true;
    else if (!a.startsWith('-')) positional.push(a);
  }

  if (!positional[0]) {
    console.error(`Usage: node extract-cocos-spine-packs.mjs <file.har> [--out dir] [--only symbol|scatter|all]`);
    process.exit(1);
  }

  const harPath = positional[0];
  if (!out) {
    const base = basename(harPath).replace(/\.har$/i, '');
    out = join(process.cwd(), 'dist', 'spine-export', base);
  }

  return { harPath, out, only, layout, skipMissing, names };
}

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('?')[0];
    const m = p.match(/\.([a-z0-9]+)$/i);
    return m ? `.${m[1].toLowerCase()}` : '';
  } catch {
    return '';
  }
}

function getImageBuffer(entry) {
  const content = entry.response?.content ?? {};
  if (!content.text || content.encoding !== 'base64') return null;
  try {
    return Buffer.from(content.text, 'base64');
  } catch {
    return null;
  }
}

function pngSize(buf) {
  if (!buf || buf.length < 24 || buf[0] !== 0x89) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function jpgSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const m = buf[i + 1];
    if (m === 0xc0 || m === 0xc2 || m === 0xc1) {
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function webpSize(buf) {
  if (!buf || buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  const sig = buf.toString('ascii', 8, 12);
  if (sig === 'VP8X' && buf.length >= 27) {
    return {
      w: 1 + (buf[21] | (buf[22] << 8) | (buf[23] << 16)),
      h: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
    };
  }
  return null;
}

function imageDimensions(buf, ext) {
  if (!buf) return null;
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) return pngSize(buf);
  if (ext === '.webp') return webpSize(buf) ?? pngSize(buf);
  if (ext === '.jpg' || ext === '.jpeg') return jpgSize(buf);
  return pngSize(buf) ?? webpSize(buf) ?? jpgSize(buf);
}

function buildHarTextureIndex(entries) {
  const byUrl = new Map();
  for (const entry of entries) {
    const url = entry.request?.url ?? '';
    const mime = entry.response?.content?.mimeType ?? '';
    const ext = extFromUrl(url);
    const isTex = TEXTURE_EXT.has(ext) || TEXTURE_MIME.test(mime.toLowerCase());
    if (!isTex) continue;
    if (entry.response?.status && (entry.response.status < 200 || entry.response.status >= 400)) continue;
    const buf = getImageBuffer(entry);
    if (!buf) continue;
    const prev = byUrl.get(url);
    if (prev && prev.length >= buf.length) continue;
    byUrl.set(url, buf);
  }
  return byUrl;
}

function buildHarTextureList(entries) {
  const urlMap = new Map();
  let idx = 0;
  for (const entry of entries) {
    const url = entry.request?.url ?? '';
    const mime = entry.response?.content?.mimeType ?? '';
    const ext = extFromUrl(url);
    const isTex = TEXTURE_EXT.has(ext) || TEXTURE_MIME.test(mime.toLowerCase());
    if (!isTex) continue;
    if (entry.response?.status && (entry.response.status < 200 || entry.response.status >= 400)) continue;
    const buf = getImageBuffer(entry);
    if (!buf) continue;
    const prev = urlMap.get(url);
    if (prev && prev.size >= buf.length) continue;
    const dim = imageDimensions(buf, ext);
    urlMap.set(url, {
      url,
      src: url,
      path: new URL(url).pathname,
      fileName: basename(new URL(url).pathname),
      size: buf.length,
      width: dim?.w ?? null,
      height: dim?.h ?? null,
    });
    idx++;
  }
  return [...urlMap.values()];
}

function packCategory(name) {
  if (SCATTER_NAMES.has(name)) return 'scatter';
  if (/^symbol_\d{2}(?:_\d{2})?$/.test(name)) return 'symbol';
  return null;
}

function shouldExport(name, { only, names }) {
  // Explicit --names always exports, regardless of symbol/scatter category.
  if (names) return names.has(name);
  const cat = packCategory(name);
  if (!cat) return false;
  if (only === 'all') return true;
  return cat === only;
}

function writeImportReadme(rootDir, exports) {
  const lines = [
    'Spine export from Cocos Creator HAR',
    '',
    'Each pack folder contains:',
    '  <name>/<name>.json   — Spine skeleton',
    '  <name>/<name>.atlas  — Spine atlas text',
    '  <name>/*.png|webp|jpg — Atlas texture pages (names must match .atlas first line per page)',
    '',
    'Cocos Creator import:',
    '  1. Copy pack folder(s) into assets/',
    '  2. Keep texture filenames identical to .atlas page headers',
    '  3. Reimport .json in the asset panel',
    '',
    'Scatter in Golden Seth HAR: symbol_15, symbol_16 (no separate scatter_* blob).',
    '',
    'Exported packs:',
  ];
  for (const e of exports) {
    lines.push(`  ${e.name} [${e.category}] — ${e.files.length} files${e.missingPages.length ? ` (missing: ${e.missingPages.join(', ')})` : ''}`);
  }
  writeFileSync(join(rootDir, 'IMPORT_README.txt'), lines.join('\n'), 'utf8');
}

function exportPack(pack, outRoot, layout, texturesByUrl, { skipMissing }) {
  const name = pack.name;
  const atlasPages = parseAtlasPages(pack.atlasText);
  const missingPages = (pack.missingAtlasPages ?? []).map((p) => p.page);
  if (skipMissing && missingPages.length) return null;
  if (!pack.skeletonJson || !pack.atlasText) return null;

  // bare: files directly in outRoot; flat: outRoot/<name>/*; wrapper: outRoot/symbolAnimation_<name>_spine/<name>/*
  let dir;
  let prefix;
  if (layout === 'bare') {
    dir = outRoot;
    prefix = '';
  } else if (layout === 'wrapper') {
    dir = join(outRoot, `symbolAnimation_${name}_spine`, name);
    prefix = `${name}/`;
  } else {
    dir = join(outRoot, name);
    prefix = `${name}/`;
  }
  mkdirSync(dir, { recursive: true });

  const files = [];
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(skeletonJsonForExport(pack.skeletonJson)), 'utf8');
  writeFileSync(join(dir, `${name}.atlas`), pack.atlasText, 'utf8');
  files.push({ path: `${prefix}${name}.json`, bytes: Buffer.byteLength(JSON.stringify(pack.skeletonJson)) });
  files.push({ path: `${prefix}${name}.atlas`, bytes: Buffer.byteLength(pack.atlasText) });

  for (const page of atlasPages) {
    const hit = pack.texturePages?.[page.page];
    const url = hit?.textureUrl ?? hit?.textureSrc;
    let buf = null;
    if (url?.startsWith('http')) buf = texturesByUrl.get(url);
    if (!buf && hit?.textureSrc && existsSync(hit.textureSrc)) {
      buf = readFileSync(hit.textureSrc);
    }
    if (!buf) continue;
    writeFileSync(join(dir, page.page), buf);
    files.push({ path: `${prefix}${page.page}`, bytes: buf.length, width: page.width, height: page.height });
  }

  return {
    name,
    category: packCategory(name),
    importUrl: pack.importUrl,
    spineVersion: pack.spineVersion ?? pack.skeletonJson?.skeleton?.spine ?? null,
    animationNames: pack.animationNames ?? [],
    defaultAnimation: pack.defaultAnimation ?? null,
    atlasPages: atlasPages.map((p) => p.page),
    missingPages,
    files,
    dir,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.harPath)) {
    console.error(`HAR not found: ${opts.harPath}`);
    process.exit(1);
  }

  const har = JSON.parse(readFileSync(opts.harPath, 'utf8'));
  const entries = har.log?.entries ?? [];
  const texturesByUrl = buildHarTextureIndex(entries);
  const textures = buildHarTextureList(entries);
  const { spinePacks } = extractCocosAnimationPacks(entries, textures);

  mkdirSync(opts.out, { recursive: true });

  const exports = [];
  for (const pack of spinePacks) {
    if (!shouldExport(pack.name, opts)) continue;
    const result = exportPack(pack, opts.out, opts.layout, texturesByUrl, opts);
    if (result) exports.push(result);
  }

  exports.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const manifest = {
    exporter: 'perlab-har-spine-export',
    har: opts.harPath.replace(/\\/g, '/'),
    builtAt: new Date().toISOString(),
    filter: opts.only,
    layout: opts.layout,
    scatterNote: 'Golden Seth uses symbol_15 / symbol_16 as scatter Spine assets',
    packs: exports.map((e) => ({
      name: e.name,
      category: e.category,
      dir: e.dir.replace(/\\/g, '/'),
      spineVersion: e.spineVersion,
      animations: e.animationNames,
      defaultAnimation: e.defaultAnimation,
      atlasPages: e.atlasPages,
      missingPages: e.missingPages,
      files: e.files,
    })),
  };

  writeFileSync(join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  writeImportReadme(opts.out, exports);

  console.log(JSON.stringify({
    ok: true,
    out: opts.out,
    exported: exports.length,
    symbol: exports.filter((e) => e.category === 'symbol').length,
    scatter: exports.filter((e) => e.category === 'scatter').length,
    missingTextures: exports.filter((e) => e.missingPages.length).map((e) => e.name),
    packs: exports.map((e) => e.name),
  }, null, 2));
}

main();
