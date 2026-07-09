#!/usr/bin/env node
/** Extract Pragmatic Play textures from resource JSON in HAR */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, basename } from 'path';

const harPath = process.argv[2];
const outDir = process.argv[3] || 'temp/texture-viewer/manifests';
if (!harPath) {
  console.error('Usage: extract-pp-textures.mjs <har> [out-manifest.json]');
  process.exit(1);
}

const har = JSON.parse(readFileSync(harPath, 'utf8'));
const entries = har.log?.entries ?? [];

function bodyText(entry) {
  const c = entry.response?.content;
  if (!c?.text) return null;
  if (c.encoding === 'base64') return Buffer.from(c.text, 'base64').toString('utf8');
  return c.text;
}

function classifyPpPath(path) {
  const p = path.toLowerCase();
  if (p.includes('/gui')) return 'gui';
  if (p.includes('main_resources')) return 'main';
  if (p.includes('game_resources') || /\/game\/game\d/.test(p)) return 'game';
  if (p.includes('/desktop/')) return 'desktop-pack';
  if (p.includes('/mobile/')) return 'mobile-pack';
  if (p.includes('/client/')) return 'client';
  return 'other';
}

function walkTextures(obj, ctx, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) walkTextures(item, ctx, out);
    return;
  }

  // PP format: texture with url or data
  const type = obj.type ?? obj.Type;
  if (type === 'texture' || type === 'sprite' || obj.texture || obj.atlas) {
    const name = obj.name || obj.id || obj.file || `tex_${out.length}`;
    const url = obj.url || obj.texture || obj.file;
    const data = obj.data || obj.base64;
    if (url || data) {
      out.push({ name, url, data, ctx, raw: obj });
    }
  }

  // base64 image fields
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      if (v.startsWith('data:image/')) {
        out.push({ name: k, data: v, ctx, raw: null });
      } else if (/\.(png|jpg|jpeg|webp)(\?|$)/i.test(v) && v.length < 500) {
        out.push({ name: k, url: v, ctx, raw: null });
      }
    } else if (typeof v === 'object') {
      walkTextures(v, ctx, out);
    }
  }
}

// Also scan for PP binary texture format in JSON - they use "textures" array with base64
function extractFromResourceJson(text, sourceUrl) {
  const found = [];
  const ctx = { source: sourceUrl, channel: /\/desktop\//i.test(sourceUrl) ? 'desktop' : /\/mobile\//i.test(sourceUrl) ? 'mobile' : 'unknown' };
  try {
    const j = JSON.parse(text);
    walkTextures(j, ctx, found);

    // PP specific: resources with "data" field containing PNG bytes as array or base64
    if (j.textures && Array.isArray(j.textures)) {
      for (const tex of j.textures) {
        found.push({ name: tex.name || tex.id || `tex_${found.length}`, data: tex.data, url: tex.url, ctx, raw: tex });
      }
    }
    if (j.sprites && Array.isArray(j.sprites)) {
      for (const sp of j.sprites) {
        found.push({ name: sp.name || sp.id, url: sp.url, data: sp.data, ctx, raw: sp });
      }
    }
  } catch { /* not json */ }

  // regex fallback for inline base64 images in large json
  const re = /data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]{100,}/g;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    found.push({ name: `inline_b64_${i++}`, data: m[0], ctx, raw: null });
  }

  return found;
}

const textures = [];
const seen = new Set();
let id = 0;

// Direct image URLs
for (const entry of entries) {
  const url = entry.request?.url ?? '';
  const mime = entry.response?.content?.mimeType ?? '';
  if (!/^image\//.test(mime) && !/\.(png|jpg|jpeg|webp|avif)(\?|$)/i.test(url)) continue;
  const size = entry.response?.content?.size || 0;
  const key = url;
  if (seen.has(key)) continue;
  seen.add(key);
  textures.push({
    id: id++,
    url, path: new URL(url).pathname,
    fileName: basename(new URL(url).pathname),
    ext: (url.match(/\.[^.?]+/)?.[0] || '').toLowerCase(),
    mime, size,
    sizeFmt: fmt(size),
    category: classifyPpPath(url),
    channel: /mobile/i.test(url) ? 'mobile' : 'desktop',
    src: url,
    srcType: 'remote',
    source: 'direct',
  });
}

// Resource JSON packs
for (const entry of entries) {
  const url = entry.request?.url ?? '';
  if (!/resources.*\.json|GUI\d+\.json|game\d+\.json/i.test(url)) continue;
  const text = bodyText(entry);
  if (!text || text.length < 100) continue;
  const extracted = extractFromResourceJson(text, url);
  for (const ex of extracted) {
    let src = ex.url || ex.data;
    if (!src) continue;
    const key = `${url}::${ex.name}::${String(src).slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let srcType = 'remote';
    let size = 0;
    let ext = '.b64';
    if (String(src).startsWith('data:image')) {
      srcType = 'data';
      const mime = src.match(/^data:(image\/[^;]+)/)?.[1] || 'image/png';
      ext = mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.png';
      size = Math.floor((src.length - src.indexOf(',') - 1) * 3 / 4);
    } else if (src.startsWith('http')) {
      srcType = 'remote';
      ext = (src.match(/\.[^.?]+/)?.[0] || '.png').toLowerCase();
    } else {
      continue;
    }

    textures.push({
      id: id++,
      url: ex.url?.startsWith('http') ? ex.url : url,
      path: new URL(url).pathname + '#' + ex.name,
      fileName: ex.name,
      ext,
      mime: ext === '.jpg' ? 'image/jpeg' : 'image/png',
      size,
      sizeFmt: fmt(size),
      category: classifyPpPath(url),
      channel: ex.ctx.channel,
      src,
      srcType,
      source: basename(new URL(url).pathname),
      pack: url,
    });
  }
}

function fmt(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

textures.sort((a, b) => b.size - a.size);

const manifest = {
  meta: {
    id: basename(harPath, '.har'),
    label: har.log?.pages?.[0]?.title || 'Pragmatic Play',
    harPath: harPath.replace(/\\/g, '/'),
    builtAt: new Date().toISOString(),
    total: textures.length,
    desktop: textures.filter((t) => t.channel === 'desktop').length,
    mobile: textures.filter((t) => t.channel === 'mobile').length,
    directImages: textures.filter((t) => t.source === 'direct').length,
    fromJson: textures.filter((t) => t.source !== 'direct').length,
  },
  textures,
  categories: [...new Set(textures.map((t) => t.category))].sort(),
  extensions: [...new Set(textures.map((t) => t.ext))].sort(),
};

mkdirSync(dirname(outDir), { recursive: true });
writeFileSync(outDir, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.meta, null, 2));
