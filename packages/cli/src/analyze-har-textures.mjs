#!/usr/bin/env node
/**
 * Analyze texture/image resources from a HAR file (SlotMill / Pixi / Spine friendly).
 * Usage: node tools/scripts/analyze-har-textures.mjs <path-to.har> [--json-out report.json]
 */

import { readFileSync, writeFileSync } from 'fs';
import { extname } from 'path';

const args = process.argv.slice(2);
const harPath = args.find((a) => !a.startsWith('--'));
const jsonOut = args.includes('--json-out')
  ? args[args.indexOf('--json-out') + 1]
  : null;

if (!harPath) {
  console.error('Usage: node analyze-har-textures.mjs <file.har> [--json-out report.json]');
  process.exit(1);
}

const TEXTURE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif',
  '.ktx', '.ktx2', '.pvr', '.dds', '.astc', '.basis', '.tga', '.hdr', '.exr',
]);

const TEXTURE_MIME = /^image\//;
const ATLAS_EXT = new Set(['.atlas']);
const SPINE_JSON_HINT = /\/spine\/.*\.json$/i;
const BITMAP_FONT_EXT = new Set(['.fnt']);

function extFromUrl(url) {
  try {
    const path = new URL(url).pathname.split('?')[0];
    return extname(path).toLowerCase() || '(no-ext)';
  } catch {
    return '(invalid)';
  }
}

function domainFromUrl(url) {
  try { return new URL(url).hostname; } catch { return '(invalid)'; }
}

function pathFromUrl(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

function headerValue(entry, name) {
  const h = (entry.response?.headers ?? []).find(
    (x) => x.name?.toLowerCase() === name.toLowerCase()
  );
  return h?.value ?? null;
}

function getBodySize(entry) {
  const content = entry.response?.content ?? {};
  if (typeof content.size === 'number' && content.size > 0) return content.size;

  const cl = headerValue(entry, 'content-length');
  if (cl) {
    const n = parseInt(cl, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }

  if (content.text) {
    if (content.encoding === 'base64') return Math.floor((content.text.length * 3) / 4);
    return Buffer.byteLength(content.text, 'utf8');
  }
  return 0;
}

function getBodyText(entry) {
  const content = entry.response?.content ?? {};
  if (!content.text) return null;
  if (content.encoding === 'base64') {
    try {
      return Buffer.from(content.text, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return content.text;
}

function isTextureRecord(r) {
  if (TEXTURE_EXT.has(r.ext)) return true;
  if (TEXTURE_MIME.test((r.mime ?? '').toLowerCase())) return true;
  return false;
}

function isAtlasRecord(r) {
  return ATLAS_EXT.has(r.ext);
}

function isSpineJsonRecord(r) {
  return SPINE_JSON_HINT.test(r.path) || (r.ext === '.json' && /\/spine\//i.test(r.path));
}

function isBitmapFontRecord(r) {
  return BITMAP_FONT_EXT.has(r.ext);
}

function classifyPath(path) {
  const p = path.toLowerCase();
  if (p.includes('/spine/')) return 'spine';
  if (p.includes('/sprites/')) return 'sprites';
  if (p.includes('/fonts/bitmap')) return 'bitmap-font';
  if (p.includes('/fonts/text')) return 'text-font';
  if (p.includes('/loading-screen')) return 'loading-screen';
  if (p.includes('/favicons')) return 'favicon';
  if (p.includes('/sounds/')) return 'audio';
  return 'other';
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function summarizeGroup(items) {
  const sizes = items.map((i) => i.size).filter((s) => s > 0).sort((a, b) => a - b);
  const total = sizes.reduce((a, b) => a + b, 0);
  return {
    count: items.length,
    withSize: sizes.length,
    totalBytes: total,
    totalFmt: fmtBytes(total),
    avgBytes: sizes.length ? Math.round(total / sizes.length) : 0,
    avgFmt: sizes.length ? fmtBytes(total / sizes.length) : 0,
    minBytes: sizes[0] ?? 0,
    maxBytes: sizes[sizes.length - 1] ?? 0,
    p50: percentile(sizes, 50),
    p90: percentile(sizes, 90),
    p95: percentile(sizes, 95),
  };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function parseAtlas(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const pages = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i++; continue; }

    if (!line.includes(':') && /\.(avif|png|jpg|jpeg|webp)$/i.test(line)) {
      const page = {
        pageName: line,
        width: 0,
        height: 0,
        format: '',
        regions: 0,
      };
      i++;

      while (i < lines.length) {
        const r = lines[i];
        const l = r.trim();
        if (!l) { i++; continue; }

        // next texture page
        if (!r.startsWith(' ') && !r.startsWith('\t') && !l.includes(':') &&
            /\.(avif|png|jpg|jpeg|webp)$/i.test(l)) {
          break;
        }

        const sizeM = l.match(/^size:\s*(\d+)\s*,\s*(\d+)/i);
        if (sizeM) {
          page.width = parseInt(sizeM[1], 10);
          page.height = parseInt(sizeM[2], 10);
          i++;
          continue;
        }
        if (/^format:/i.test(l)) {
          page.format = l.replace(/^format:\s*/i, '').trim();
          i++;
          continue;
        }

        // region entry: non-indented name without colon
        if (!r.startsWith(' ') && !r.startsWith('\t') && !l.includes(':')) {
          page.regions++;
          i++;
          while (i < lines.length && (lines[i].startsWith(' ') || lines[i].startsWith('\t'))) i++;
          continue;
        }

        i++;
      }
      pages.push(page);
    } else {
      i++;
    }
  }

  const totalRegions = pages.reduce((a, p) => a + p.regions, 0);
  const maxPixelArea = pages.reduce((m, p) => Math.max(m, p.width * p.height), 0);
  return { pages, pageCount: pages.length, totalRegions, maxPixelArea };
}

function parseBitmapFont(text) {
  if (!text) return null;
  // XML (Pixi / SlotMill)
  if (text.trimStart().startsWith('<?xml') || text.trimStart().startsWith('<font')) {
    const info = {};
    const face = text.match(/face="([^"]+)"/);
    const size = text.match(/<info[^>]*size="(\d+)"/);
    const page = text.match(/file="([^"]+\.(avif|png|jpg))"/i);
    const chars = text.match(/<chars\s+count="(\d+)"/);
    const lineH = text.match(/lineHeight="(\d+)"/);
    if (face) info.face = face[1];
    if (size) info.fontSize = parseInt(size[1], 10);
    if (page) info.pageFile = page[1];
    if (chars) info.charCount = parseInt(chars[1], 10);
    if (lineH) info.lineHeight = parseInt(lineH[1], 10);
    return info;
  }
  // BMFont text format
  const info = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('info ')) {
      const m = line.match(/size=(\d+)/);
      if (m) info.fontSize = parseInt(m[1], 10);
    }
    if (line.startsWith('page ')) {
      const m = line.match(/file=(.+?)(\s|$)/);
      if (m) info.pageFile = m[1].replace(/"/g, '');
    }
    if (line.startsWith('common ')) {
      const m = line.match(/scaleW=(\d+).*scaleH=(\d+)/);
      if (m) { info.scaleW = parseInt(m[1], 10); info.scaleH = parseInt(m[2], 10); }
    }
  }
  return Object.keys(info).length ? info : null;
}

function parseSpineJson(text) {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    const skeleton = j.skeleton ?? {};
    const skins = j.skins ?? [];
    let attachmentCount = 0;
    let meshCount = 0;
    for (const skin of skins) {
      const attachments = skin.attachments ?? skin;
      if (typeof attachments === 'object') {
        for (const slot of Object.values(attachments)) {
          if (typeof slot === 'object') {
            for (const att of Object.values(slot)) {
              attachmentCount++;
              if (att?.type === 'mesh' || att?.type === 'linkedmesh') meshCount++;
            }
          }
        }
      }
    }
    return {
      skeleton: skeleton.name ?? skeleton.hash ?? '(unnamed)',
      width: skeleton.width ?? 0,
      height: skeleton.height ?? 0,
      bones: (j.bones ?? []).length,
      slots: (j.slots ?? []).length,
      skins: skins.length,
      animations: (j.animations ?? []).length ?? Object.keys(j.animations ?? {}).length,
      attachmentCount,
      meshCount,
      fileSize: Buffer.byteLength(text, 'utf8'),
    };
  } catch {
    return null;
  }
}

function pathPrefix(path, depth = 3) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= depth) return '/' + parts.join('/');
  return '/' + parts.slice(0, depth).join('/') + '/…';
}

// --- main ---

console.log(`Reading HAR: ${harPath}`);
const har = JSON.parse(readFileSync(harPath, 'utf8'));
const entries = har.log?.entries ?? [];
console.log(`Total HAR entries: ${entries.length}`);

const records = entries.map((entry) => {
  const url = entry.request?.url ?? '';
  const path = pathFromUrl(url);
  const ext = extFromUrl(url);
  const mime = entry.response?.content?.mimeType ?? '';
  const size = getBodySize(entry);
  const bodyText = getBodyText(entry);
  const status = entry.response?.status ?? 0;
  const hasBodyInHar = Boolean(entry.response?.content?.text);
  const category = classifyPath(path);
  return {
    url, path, ext, mime, size, status, bodyText, hasBodyInHar, category,
    domain: domainFromUrl(url),
    timeMs: entry.time ?? 0,
  };
});

const ok = (r) => r.status >= 200 && r.status < 400;

// dedupe by URL
function dedupe(items) {
  const m = new Map();
  for (const t of items) {
    const prev = m.get(t.url);
    if (!prev || t.size > prev.size) m.set(t.url, t);
  }
  return [...m.values()];
}

const texturesRaw = records.filter(isTextureRecord);
const textures = dedupe(texturesRaw.filter(ok));
const atlases = dedupe(records.filter(isAtlasRecord).filter(ok));
const spineJsons = dedupe(records.filter(isSpineJsonRecord).filter(ok));
const bitmapFonts = dedupe(records.filter(isBitmapFontRecord).filter(ok));

// parse atlases
const atlasParsed = [];
for (const a of atlases) {
  const parsed = parseAtlas(a.bodyText);
  if (parsed) {
    atlasParsed.push({ path: a.path, size: a.size, ...parsed });
  }
}

// parse bitmap fonts
const fontParsed = [];
for (const f of bitmapFonts) {
  const parsed = parseBitmapFont(f.bodyText);
  if (parsed) fontParsed.push({ path: f.path, size: f.size, ...parsed });
}

// parse spine json
const spineParsed = [];
for (const s of spineJsons) {
  const parsed = parseSpineJson(s.bodyText);
  if (parsed) spineParsed.push({ path: s.path, size: s.size, ...parsed });
}

const overallTex = summarizeGroup(textures);
const sizesSorted = textures.map((t) => t.size).filter((s) => s > 0).sort((a, b) => a - b);

const byExt = [...groupBy(textures, (t) => t.ext).entries()]
  .map(([ext, items]) => ({ ext, ...summarizeGroup(items) }))
  .sort((a, b) => b.totalBytes - a.totalBytes);

const byCategory = [...groupBy(textures, (t) => t.category).entries()]
  .map(([category, items]) => ({ category, ...summarizeGroup(items) }))
  .sort((a, b) => b.totalBytes - a.totalBytes);

const byDomain = [...groupBy(textures, (t) => t.domain).entries()]
  .map(([domain, items]) => ({ domain, ...summarizeGroup(items) }))
  .sort((a, b) => b.totalBytes - a.totalBytes);

const buckets = [
  { label: '0 (no size)', min: -1, max: 0 },
  { label: '< 10 KB', min: 1, max: 10 * 1024 },
  { label: '10–50 KB', min: 10 * 1024, max: 50 * 1024 },
  { label: '50–100 KB', min: 50 * 1024, max: 100 * 1024 },
  { label: '100–200 KB', min: 100 * 1024, max: 200 * 1024 },
  { label: '200–500 KB', min: 200 * 1024, max: 500 * 1024 },
  { label: '> 500 KB', min: 500 * 1024, max: Infinity },
];

const sizeBuckets = buckets.map((b) => {
  const items = textures.filter((t) =>
    b.min < 0 ? t.size === 0 : t.size >= b.min && t.size < b.max
  );
  return { label: b.label, ...summarizeGroup(items) };
});

const topLargest = [...textures].sort((a, b) => b.size - a.size).slice(0, 25);

const pathStats = [...groupBy(textures, (t) => pathPrefix(t.path, 3)).entries()]
  .map(([prefix, items]) => ({ prefix, ...summarizeGroup(items) }))
  .sort((a, b) => b.totalBytes - a.totalBytes)
  .slice(0, 15);

// atlas aggregate
const atlasRegionsTotalFromFiles = atlasParsed.reduce((a, x) => a + x.totalRegions, 0);
const atlasMaxPages = [...atlasParsed].sort((a, b) => b.pageCount - a.pageCount).slice(0, 10);

// map avif disk size by filename
const avifByName = new Map();
for (const t of textures) {
  const name = t.path.split('/').pop()?.split('?')[0] ?? '';
  avifByName.set(name, t.size);
}

// estimate GPU memory: dedupe by page filename (same avif loaded once)
const pageVramMap = new Map(); // pageName -> { width, height, vram, atlases[] }
for (const a of atlasParsed) {
  for (const p of a.pages) {
    const vram = p.width * p.height * 4;
    const existing = pageVramMap.get(p.pageName);
    if (!existing) {
      pageVramMap.set(p.pageName, {
        pageName: p.pageName,
        width: p.width,
        height: p.height,
        vramBytes: vram,
        regions: p.regions,
        atlases: [a.path],
      });
    } else {
      existing.regions += p.regions;
      existing.atlases.push(a.path);
    }
  }
}

const vramDetails = [...pageVramMap.values()].map((v) => ({
  ...v,
  vramFmt: fmtBytes(v.vramBytes),
  diskBytes: avifByName.get(v.pageName) ?? 0,
  diskFmt: fmtBytes(avifByName.get(v.pageName) ?? 0),
}));

let estimatedVramBytes = vramDetails.reduce((a, v) => a + v.vramBytes, 0);
const atlasRegionsTotal = vramDetails.reduce((a, v) => a + v.regions, 0);
const atlasPagesTotal = vramDetails.length;

// standalone avifs not in atlas
const atlasPageNames = new Set(vramDetails.map((v) => v.pageName));
const standaloneAvifs = textures.filter((t) => {
  const name = t.path.split('/').pop()?.split('?')[0] ?? '';
  return t.ext === '.avif' && !atlasPageNames.has(name);
});

const harMeta = {
  pages: har.log?.pages?.map((p) => ({ title: p.title, started: p.startedDateTime })) ?? [],
};

const report = {
  meta: {
    harPath,
    analyzedAt: new Date().toISOString(),
    pageTitle: harMeta.pages[0]?.title ?? '',
    totalEntries: entries.length,
    textureUrls: textures.length,
    atlasFiles: atlases.length,
    spineJsonFiles: spineJsons.length,
    bitmapFontFiles: bitmapFonts.length,
    texturesWithBodyInHar: textures.filter((t) => t.hasBodyInHar).length,
    note: 'Most AVIF bodies omitted from HAR; sizes from Content-Length headers.',
  },
  textureOverall: overallTex,
  sizeDistribution: {
    p50: fmtBytes(percentile(sizesSorted, 50)),
    p90: fmtBytes(percentile(sizesSorted, 90)),
    p95: fmtBytes(percentile(sizesSorted, 95)),
    max: fmtBytes(sizesSorted[sizesSorted.length - 1] ?? 0),
  },
  byExtension: byExt,
  byCategory,
  byDomain,
  bySizeBucket: sizeBuckets.filter((b) => b.count > 0),
  byPathPrefix: pathStats,
  topLargest: topLargest.map((t) => ({
    sizeFmt: fmtBytes(t.size),
    sizeBytes: t.size,
    ext: t.ext,
    category: t.category,
    path: t.path,
  })),
  atlas: {
    fileCount: atlasParsed.length,
    totalPages: atlasPagesTotal,
    totalPagesInAtlases: atlasParsed.reduce((a, x) => a + x.pageCount, 0),
    totalRegions: atlasRegionsTotal,
    totalRegionsInAtlases: atlasRegionsTotalFromFiles,
    estimatedVramBytes,
    estimatedVramFmt: fmtBytes(estimatedVramBytes),
    compressionRatio: estimatedVramBytes > 0
      ? (overallTex.totalBytes / estimatedVramBytes).toFixed(3)
      : null,
    largestAtlases: atlasMaxPages.map((a) => ({
      path: a.path,
      pages: a.pageCount,
      regions: a.totalRegions,
      diskFmt: fmtBytes(a.size),
    })),
    pageDetails: vramDetails.sort((a, b) => b.vramBytes - a.vramBytes).slice(0, 30).map((v) => ({
      page: v.pageName,
      width: v.width,
      height: v.height,
      regions: v.regions,
      vramFmt: v.vramFmt,
      vramBytes: v.vramBytes,
      diskFmt: v.diskFmt,
      diskBytes: v.diskBytes,
    })),
  },
  standaloneAvifs: {
    count: standaloneAvifs.length,
    totalBytes: standaloneAvifs.reduce((a, t) => a + t.size, 0),
    totalFmt: fmtBytes(standaloneAvifs.reduce((a, t) => a + t.size, 0)),
    files: standaloneAvifs.sort((a, b) => b.size - a.size).slice(0, 20).map((t) => ({
      sizeFmt: fmtBytes(t.size),
      path: t.path,
    })),
  },
  spine: {
    fileCount: spineParsed.length,
    totalJsonBytes: spineParsed.reduce((a, s) => a + s.size, 0),
    totalAttachments: spineParsed.reduce((a, s) => a + s.attachmentCount, 0),
    files: spineParsed.sort((a, b) => b.size - a.size).map((s) => ({
      path: s.path.split('/').pop(),
      jsonFmt: fmtBytes(s.size),
      attachments: s.attachmentCount,
      meshes: s.meshCount,
      bones: s.bones,
      slots: s.slots,
      animations: s.animations,
    })),
  },
  bitmapFonts: {
    fileCount: fontParsed.length,
    fonts: fontParsed.map((f) => ({
      path: f.path,
      pageFile: f.pageFile,
      fontSize: f.fontSize,
      atlasSize: f.scaleW && f.scaleH ? `${f.scaleW}x${f.scaleH}` : null,
    })),
  },
};

// --- print ---

console.log('\n========== Demons Gate 纹理资源分析报告 ==========\n');
console.log(`页面: ${report.meta.pageTitle || '(unknown)'}`);
console.log(`HAR 请求总数: ${report.meta.totalEntries}`);
console.log(`说明: ${report.meta.note}`);

console.log('\n【一、纹理文件总览】');
console.log(`  纹理 URL（去重）: ${report.meta.textureUrls}`);
console.log(`  磁盘体积合计:     ${overallTex.totalFmt} (${overallTex.totalBytes.toLocaleString()} bytes)`);
console.log(`  平均单张:         ${overallTex.avgFmt}`);
console.log(`  中位 / P90 / 最大: ${report.sizeDistribution.p50} / ${report.sizeDistribution.p90} / ${report.sizeDistribution.max}`);

console.log('\n【二、格式分布】');
for (const s of byExt) {
  console.log(`  ${s.ext.padEnd(8)} ${String(s.count).padStart(3)} 张  磁盘 ${s.totalFmt.padStart(10)}  均 ${String(s.avgFmt).padStart(8)}`);
}

console.log('\n【三、资源目录分类】');
for (const s of byCategory) {
  console.log(`  ${s.category.padEnd(16)} ${String(s.count).padStart(3)} 张  ${s.totalFmt}`);
}

console.log('\n【四、体积分布】');
for (const b of report.bySizeBucket) {
  console.log(`  ${b.label.padEnd(14)} ${String(b.count).padStart(3)} 张  ${b.totalFmt}`);
}

console.log('\n【五、路径前缀 Top】');
for (const s of pathStats.slice(0, 10)) {
  console.log(`  ${s.prefix.padEnd(42)} ${String(s.count).padStart(3)}  ${s.totalFmt}`);
}

console.log('\n【六、Atlas / Spine 纹理页】');
console.log(`  .atlas 文件: ${report.atlas.fileCount}  唯一纹理页: ${report.atlas.totalPages}  子图区域: ${report.atlas.totalRegions}`);
console.log(`  估算 GPU 显存 (RGBA8888): ${report.atlas.estimatedVramFmt}`);
console.log(`  磁盘/显存压缩比: ${report.atlas.compressionRatio} (AVIF 磁盘 ÷ 解压 RGBA)`);
console.log('  最大 Atlas:');
for (const a of report.atlas.largestAtlases.slice(0, 6)) {
  console.log(`    ${a.pages}页 / ${a.regions}区域  ${a.diskFmt.padStart(8)}  ${a.path}`);
}

console.log('\n【七、Top 显存占用纹理页 (按 RGBA 估算)】');
for (const v of report.atlas.pageDetails.slice(0, 12)) {
  console.log(`  ${v.vramFmt.padStart(10)}  ${String(v.width).padStart(5)}x${String(v.height).padEnd(5)}  磁盘${v.diskFmt.padStart(8)}  ${v.regions}区域  ${v.page}`);
}

if (standaloneAvifs.length) {
  console.log('\n【八、非 Atlas 独立 AVIF】');
  console.log(`  ${report.standaloneAvifs.count} 张, 合计 ${report.standaloneAvifs.totalFmt}`);
  for (const f of report.standaloneAvifs.files.slice(0, 8)) {
    console.log(`    ${f.sizeFmt.padStart(8)}  ${f.path}`);
  }
}

console.log('\n【九、Spine 骨骼 JSON（纹理引用元数据）】');
console.log(`  ${report.spine.fileCount} 个, JSON 合计 ${fmtBytes(report.spine.totalJsonBytes)}, 附件 ${report.spine.totalAttachments} 个`);
for (const s of report.spine.files.slice(0, 10)) {
  console.log(`    ${s.jsonFmt.padStart(8)}  att=${String(s.attachments).padStart(4)} mesh=${String(s.meshes).padStart(3)}  ${s.path}`);
}

console.log('\n【十、Bitmap 字体纹理】');
console.log(`  ${report.bitmapFonts.fileCount} 个 FNT → AVIF 页`);
for (const f of report.bitmapFonts.fonts.slice(0, 8)) {
  console.log(`    size=${f.fontSize ?? '?'}  chars=${f.charCount ?? '?'}  page=${f.pageFile ?? '?'}  (${f.path.split('/').pop()})`);
}

console.log('\n【十一、最大单文件 Top 15】');
for (const t of report.topLargest.slice(0, 15)) {
  console.log(`  ${t.sizeFmt.padStart(10)}  [${t.category}]  ${t.path}`);
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nJSON 报告: ${jsonOut}`);
}
