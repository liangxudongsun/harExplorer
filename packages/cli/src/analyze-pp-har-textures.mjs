#!/usr/bin/env node
/** Pragmatic Play HAR texture analysis (JSON packs + direct images). */
import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import { buildPragmaticTab } from '../../core/src/index.mjs';

const harPath = process.argv[2];
const outIdx = process.argv.indexOf('--json-out');
const jsonOut = outIdx >= 0 ? process.argv[outIdx + 1] : null;

if (!harPath) {
  console.error('Usage: analyze-pp-har-textures.mjs <file.har> [--json-out report.json]');
  process.exit(1);
}

const tab = buildPragmaticTab(harPath, '/tmp', {
  id: 'report',
  label: basename(harPath, '.har'),
});

const { textures, meta } = tab;
const har = JSON.parse(readFileSync(harPath, 'utf8'));
const entries = har.log?.entries ?? [];

const byExt = new Map();
const byCat = new Map();
let totalBytes = 0;
for (const t of textures) {
  totalBytes += t.size || 0;
  byExt.set(t.ext, (byExt.get(t.ext) ?? { count: 0, bytes: 0 }));
  const e = byExt.get(t.ext);
  e.count++; e.bytes += t.size || 0;
  byCat.set(t.category, (byCat.get(t.category) ?? { count: 0, bytes: 0 }));
  const c = byCat.get(t.category);
  c.count++; c.bytes += t.size || 0;
}

const desktopPaths = entries.filter((e) => /\/desktop\//i.test(e.request?.url ?? '')).length;
const mobilePaths = entries.filter((e) => /\/mobile\//i.test(e.request?.url ?? '')).length;
const stats = entries.filter((e) => e.request?.url?.includes('stats.do'));
const channels = [...new Set(stats.map((e) => e.request.url.match(/channel=(\w+)/i)?.[1]).filter(Boolean))];

const jsonPacks = entries.filter((e) => /resources.*\.json|GUI\d+\.json|game\d+\.json/i.test(e.request?.url ?? ''));
let jsonPackBytes = 0;
for (const e of jsonPacks) {
  const s = e.response?.content?.size;
  if (s) jsonPackBytes += s;
}

const fmt = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

console.log('\n========== Pragmatic Play 纹理资源分析报告 ==========\n');
console.log(`页面: ${meta.pageTitle || harPath}`);
console.log(`HAR 请求总数: ${entries.length}`);
console.log(`stats channel: ${channels.join(', ') || 'n/a'}`);
console.log(`路径 /desktop/: ${desktopPaths}  /mobile/: ${mobilePaths}`);
console.log('');
console.log('【一、纹理总览】');
console.log(`  纹理（去重）:     ${textures.length}`);
console.log(`  直接图片 URL:     ${meta.directImages ?? 0}`);
console.log(`  JSON 内嵌纹理:    ${meta.fromJson ?? 0}`);
console.log(`  估算磁盘合计:     ${fmt(totalBytes)}`);
console.log('');
console.log('【二、JSON 资源包】');
console.log(`  资源 JSON 文件:   ${jsonPacks.length}`);
console.log(`  JSON 包体积合计:  ${fmt(jsonPackBytes)}`);
console.log('');
console.log('【三、格式分布】');
for (const [ext, v] of [...byExt.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${ext.padEnd(8)} ${String(v.count).padStart(4)} 张  ${fmt(v.bytes)}`);
}
console.log('');
console.log('【四、分类】');
for (const [cat, v] of [...byCat.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${cat.padEnd(14)} ${String(v.count).padStart(4)} 张  ${fmt(v.bytes)}`);
}
console.log('');
console.log('【五、Top 10 最大纹理】');
for (const t of textures.slice(0, 10)) {
  console.log(`  ${t.sizeFmt.padStart(10)}  [${t.category}]  ${t.fileName}  (${t.source})`);
}

const report = {
  harPath,
  meta,
  summary: {
    harEntries: entries.length,
    textureCount: textures.length,
    totalBytes,
    jsonPackCount: jsonPacks.length,
    jsonPackBytes,
    channels,
    desktopPaths,
    mobilePaths,
  },
  byExt: Object.fromEntries(byExt),
  byCategory: Object.fromEntries(byCat),
  topTextures: textures.slice(0, 20),
};

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`\nJSON 报告: ${jsonOut}`);
}
