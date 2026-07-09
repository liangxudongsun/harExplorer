#!/usr/bin/env node
/** Cocos Creator HAR resource analysis + optional JSON report. */
import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import { buildCocosTab } from '../../core/src/index.mjs';

const harPath = process.argv[2];
const outIdx = process.argv.indexOf('--json-out');
const jsonOut = outIdx >= 0 ? process.argv[outIdx + 1] : null;

if (!harPath) {
  console.error('Usage: analyze-cocos-har.mjs <file.har> [--json-out report.json]');
  process.exit(1);
}

const tab = buildCocosTab(harPath, '/tmp', {
  id: 'report',
  label: basename(harPath, '.har'),
});

const har = JSON.parse(readFileSync(harPath, 'utf8'));
const entries = har.log?.entries ?? [];
const { textures, meta } = tab;

const byExt = new Map();
const byCat = new Map();
let totalBytes = 0;
for (const t of textures) {
  totalBytes += t.size || 0;
  byExt.set(t.ext, (byExt.get(t.ext) ?? { count: 0, bytes: 0 }));
  const e = byExt.get(t.ext);
  e.count++;
  e.bytes += t.size || 0;
  byCat.set(t.category, (byCat.get(t.category) ?? { count: 0, bytes: 0, vram: 0 }));
  const c = byCat.get(t.category);
  c.count++;
  c.bytes += t.size || 0;
  c.vram += t.vramBytes || 0;
}

let totalTransfer = 0;
let jsonBytes = 0;
let jsBytes = 0;
let mp3Count = 0;
let mp3Bytes = 0;
for (const e of entries) {
  const url = e.request?.url ?? '';
  const size = e.response?.content?.size ?? 0;
  const transfer = e.response?._transferSize ?? 0;
  totalTransfer += transfer > 0 ? transfer : size;
  if (/\.json(\?|$)/i.test(url)) jsonBytes += size;
  if (/\.js(\?|$)/i.test(url)) jsBytes += size;
  if (/\.mp3(\?|$)/i.test(url)) {
    mp3Count++;
    mp3Bytes += size;
  }
}

const fmt = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

console.log('\n========== Cocos Creator 资源分析报告 ==========\n');
console.log(`页面: ${meta.pageTitle || harPath}`);
console.log(`游戏: ${meta.gameName ?? 'n/a'}  引擎: Cocos Creator Web`);
console.log(`HAR 请求总数: ${entries.length}`);
console.log(`页面 onLoad: ${har.log?.pages?.[0]?.pageTimings?.onLoad?.toFixed(0) ?? 'n/a'} ms`);
console.log('');
console.log('【一、传输总览】');
console.log(`  HAR 网络传输:     ${fmt(totalTransfer)}`);
console.log(`  JSON 包合计:      ${fmt(jsonBytes)}`);
console.log(`  JS 脚本合计:      ${fmt(jsBytes)}`);
console.log(`  音频 MP3:         ${mp3Count} 个  ${fmt(mp3Bytes)}`);
console.log('');
console.log('【二、纹理总览】');
console.log(`  纹理（去重）:     ${textures.length}`);
console.log(`  磁盘体积合计:     ${fmt(totalBytes)}`);
console.log(`  RGBA8888 显存:    ${fmt(meta.vramBytes ?? 0)}`);
console.log(`  ASTC 8bpp 等价:   ${fmt(Math.round((meta.vramBytes ?? 0) * 0.25))}`);
console.log(`  Zip 等价 (36%):   ${fmt(Math.round((meta.vramBytes ?? 0) * 0.25 * 0.36))}`);
console.log('');
console.log('【三、格式分布】');
for (const [ext, v] of [...byExt.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${ext.padEnd(8)} ${String(v.count).padStart(4)} 张  ${fmt(v.bytes)}`);
}
console.log('');
console.log('【四、Bundle 分类】');
for (const [cat, v] of [...byCat.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${cat.padEnd(16)} ${String(v.count).padStart(4)} 张  磁盘 ${fmt(v.bytes)}  VRAM ${fmt(v.vram)}`);
}
console.log('');
console.log('【六、Spine / 序列帧识别】');
console.log(`  Spine 骨骼:       ${meta.spineCount ?? 0} 个（含序列帧 ${meta.spineSequenceCount ?? 0} 个）`);
console.log(`  Sprite Atlas:     ${meta.spriteAtlasCount ?? 0} 个`);
console.log(`  序列帧组:         ${meta.sequenceGroupCount ?? 0} 组`);
if (tab.sequenceSummary?.length) {
  console.log('  Top 序列帧组:');
  for (const g of tab.sequenceSummary.slice(0, 8)) {
    console.log(`    [${g.type}] ${g.asset} · ${g.prefix}_* × ${g.frameCount}`);
  }
}
if (tab.spineAssets?.length) {
  console.log('  Top Spine:');
  for (const sp of tab.spineAssets.slice(0, 8)) {
    const seq = sp.sequenceGroups?.map((g) => `${g.prefix}:${g.count}`).join(', ') || '-';
    console.log(`    ${sp.name.padEnd(18)} ${String(sp.regionCount).padStart(3)} regions  seq[${seq}]`);
  }
}
console.log('');
console.log('【七、Top 10 最大纹理】');
for (const t of textures.slice(0, 10)) {
  const dim = t.width && t.height ? `${t.width}×${t.height}` : '?';
  console.log(`  ${t.sizeFmt.padStart(10)}  [${t.category}]  ${dim}  ${t.fileName}`);
}

const report = {
  harPath,
  meta,
  summary: {
    harEntries: entries.length,
    totalTransfer,
    jsonBytes,
    jsBytes,
    mp3Count,
    mp3Bytes,
    textureCount: textures.length,
    totalBytes,
    vramBytes: meta.vramBytes,
  },
  byExt: Object.fromEntries(byExt),
  byCategory: Object.fromEntries(byCat),
  spineAssets: tab.spineAssets,
  sequenceSummary: tab.sequenceSummary,
  topTextures: textures.slice(0, 20),
};

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`\nJSON 报告: ${jsonOut}`);
}
