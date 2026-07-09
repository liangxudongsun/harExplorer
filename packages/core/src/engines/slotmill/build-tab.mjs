import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename, extname } from 'path';

const TEXTURE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif',
]);
const TEXTURE_MIME = /^image\//;

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('?')[0];
    return extname(p).toLowerCase() || '(no-ext)';
  } catch {
    return '(invalid)';
  }
}

function pathFromUrl(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

function headerValue(entry, name) {
  const h = (entry.response?.headers ?? []).find(
    (x) => x.name?.toLowerCase() === name.toLowerCase(),
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

function classifyPath(path) {
  const p = path.toLowerCase();
  if (p.includes('/spine/avif')) return 'spine-atlas';
  if (p.includes('/spine/')) return 'spine';
  if (p.includes('/sprites/')) return 'sprites';
  if (p.includes('/fonts/bitmap')) return 'bitmap-font';
  if (p.includes('/particles/')) return 'particles';
  if (p.includes('/loading-screen')) return 'loading-screen';
  if (p.includes('/favicons')) return 'favicon';
  return 'other';
}

function parseAtlas(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const pages = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i++; continue; }
    if (!line.includes(':') && /\.(avif|png|jpg|jpeg|webp)$/i.test(line)) {
      const page = { pageName: line, width: 0, height: 0, regions: 0, atlasPath: '' };
      i++;
      while (i < lines.length) {
        const r = lines[i];
        const l = r.trim();
        if (!l) { i++; continue; }
        if (!r.startsWith(' ') && !r.startsWith('\t') && !l.includes(':') &&
            /\.(avif|png|jpg|jpeg|webp)$/i.test(l)) break;
        const sm = l.match(/^size:\s*(\d+)\s*,\s*(\d+)/i);
        if (sm) {
          page.width = parseInt(sm[1], 10);
          page.height = parseInt(sm[2], 10);
          i++;
          continue;
        }
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
  return pages;
}

function getBodyText(entry) {
  const content = entry.response?.content ?? {};
  if (!content.text) return null;
  if (content.encoding === 'base64') {
    try { return Buffer.from(content.text, 'base64'); } catch { return null; }
  }
  return Buffer.from(content.text, 'utf8');
}

function safeId(url, idx) {
  const p = pathFromUrl(url).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${idx}_${p}`.slice(0, 120);
}

function fmtSize(size) {
  if (size >= 1048576) return `${(size / 1048576).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

export function buildSlotmillTab(harPath, outDir, src) {
  const har = JSON.parse(readFileSync(harPath, 'utf8'));
  const entries = har.log?.entries ?? [];
  const assetsDir = join(outDir, 'embedded', src.id);
  mkdirSync(assetsDir, { recursive: true });

  const atlasPages = new Map();
  for (const entry of entries) {
    if (!/\.atlas/i.test(entry.request?.url ?? '')) continue;
    const textBuf = getBodyText(entry);
    if (!textBuf || !Buffer.isBuffer(textBuf)) continue;
    const atlasPath = pathFromUrl(entry.request.url);
    for (const page of parseAtlas(textBuf.toString('utf8'))) {
      page.atlasPath = atlasPath;
      const prev = atlasPages.get(page.pageName);
      if (!prev || page.regions > prev.regions) atlasPages.set(page.pageName, page);
    }
  }

  const urlMap = new Map();
  let idx = 0;

  for (const entry of entries) {
    const url = entry.request?.url ?? '';
    const mime = entry.response?.content?.mimeType ?? '';
    const ext = extFromUrl(url);
    const isTex = TEXTURE_EXT.has(ext) || TEXTURE_MIME.test(mime.toLowerCase());
    const isDataImage = url.startsWith('data:image');
    if (!isTex && !isDataImage) continue;
    if (entry.response?.status && (entry.response.status < 200 || entry.response.status >= 400)) continue;

    const size = getBodySize(entry);
    const path = pathFromUrl(url);
    const prev = urlMap.get(url);
    if (prev && prev.size >= size) continue;

    const fileName = path.split('/').pop()?.split('?')[0] ?? `tex_${idx}`;
    let srcPath = url;
    let srcType = 'remote';

    const content = entry.response?.content ?? {};
    if (content.text && content.encoding === 'base64' && mime.startsWith('image/')) {
      const outFile = join(assetsDir, safeId(url, idx) + extFromUrl(url));
      writeFileSync(outFile, Buffer.from(content.text, 'base64'));
      srcPath = `embedded/${src.id}/${basename(outFile)}`;
      srcType = 'embedded';
    } else if (isDataImage) {
      srcPath = url;
      srcType = 'data';
    }

    const atlas = atlasPages.get(fileName);
    urlMap.set(url, {
      id: idx++,
      url,
      path,
      fileName,
      ext,
      mime,
      size,
      sizeFmt: fmtSize(size),
      category: classifyPath(path),
      src: srcPath,
      srcType,
      width: atlas?.width ?? null,
      height: atlas?.height ?? null,
      atlasRegions: atlas?.regions ?? null,
      atlasPath: atlas?.atlasPath ?? null,
    });
  }

  const textures = [...urlMap.values()].sort((a, b) => b.size - a.size);
  return {
    id: src.id,
    label: src.label,
    meta: {
      harPath: harPath.replace(/\\/g, '/'),
      pageTitle: har.log?.pages?.[0]?.title ?? '',
      builtAt: new Date().toISOString(),
      total: textures.length,
      embedded: textures.filter((t) => t.srcType === 'embedded').length,
      remote: textures.filter((t) => t.srcType === 'remote').length,
      channel: textures.some((t) => /mobile/i.test(t.path)) ? 'mobile' : 'desktop',
    },
    textures,
    categories: [...new Set(textures.map((t) => t.category))].sort(),
    extensions: [...new Set(textures.map((t) => t.ext))].sort(),
  };
}
