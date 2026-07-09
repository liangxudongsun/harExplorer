import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

function fmtSize(size) {
  if (size >= 1048576) return `${(size / 1048576).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function bodyText(entry) {
  const c = entry.response?.content;
  if (!c?.text) return null;
  if (c.encoding === 'base64') return Buffer.from(c.text, 'base64').toString('utf8');
  return c.text;
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

function classifyPpPath(path) {
  const p = path.toLowerCase();
  if (p.includes('/gui')) return 'gui';
  if (p.includes('main_resources')) return 'main';
  if (p.includes('game_resources') || /\/game\/game\d/.test(p)) return 'game';
  if (p.includes('/desktop/')) return 'desktop-pack';
  if (p.includes('/mobile/')) return 'mobile-pack';
  if (p.includes('/client/')) return 'client';
  if (p.includes('/game/res/')) return 'game-res';
  return 'other';
}

function channelFromUrl(url) {
  if (/\/mobile\//i.test(url)) return 'mobile';
  if (/\/desktop\//i.test(url)) return 'desktop';
  const ch = url.match(/channel=(\w+)/i)?.[1];
  return ch?.toLowerCase() ?? 'unknown';
}

function walkTextures(obj, ctx, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) walkTextures(item, ctx, out);
    return;
  }
  const type = obj.type ?? obj.Type;
  if (type === 'texture' || type === 'sprite' || obj.texture || obj.atlas) {
    const name = obj.name || obj.id || obj.file || `tex_${out.length}`;
    const url = obj.url || obj.texture || obj.file;
    const data = obj.data || obj.base64;
    if (url || data) out.push({ name, url, data, ctx });
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      if (v.startsWith('data:image/')) out.push({ name: k, data: v, ctx });
      else if (/\.(png|jpg|jpeg|webp)(\?|$)/i.test(v) && v.length < 500) out.push({ name: k, url: v, ctx });
    } else if (typeof v === 'object') walkTextures(v, ctx, out);
  }
}

function extractFromResourceJson(text, sourceUrl) {
  const found = [];
  const ctx = {
    source: sourceUrl,
    channel: channelFromUrl(sourceUrl),
  };
  try {
    const j = JSON.parse(text);
    walkTextures(j, ctx, found);
    if (j.textures && Array.isArray(j.textures)) {
      for (const tex of j.textures) {
        found.push({ name: tex.name || tex.id || `tex_${found.length}`, data: tex.data, url: tex.url, ctx });
      }
    }
  } catch { /* skip */ }

  const re = /data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]{100,}/g;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    found.push({ name: `atlas_${i++}`, data: m[0], ctx });
  }
  return found;
}

function extFromPathname(url) {
  try {
    const p = new URL(url).pathname.split('?')[0];
    const m = p.match(/\.([a-z0-9]+)$/i);
    return m ? `.${m[1].toLowerCase()}` : '';
  } catch {
    return '';
  }
}

function safeFileName(name, idx, ext) {
  const base = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || `tex_${idx}`;
  return `${String(idx).padStart(3, '0')}_${base}${ext}`;
}

export function buildPragmaticTab(harPath, outDir, src) {
  if (!existsSync(harPath)) {
    if (src.optional) {
      console.warn(`  skip optional HAR: ${harPath}`);
      return {
        id: src.id,
        label: src.label,
        meta: { harPath, missing: true, total: 0, embedded: 0, remote: 0, channel: 'mobile' },
        textures: [],
        categories: [],
        extensions: [],
      };
    }
    throw new Error(`HAR not found: ${harPath}`);
  }

  const har = JSON.parse(readFileSync(harPath, 'utf8'));
  const entries = har.log?.entries ?? [];
  const assetsDir = join(outDir, 'embedded', src.id);
  mkdirSync(assetsDir, { recursive: true });

  const textures = [];
  const seen = new Set();
  let id = 0;

  for (const entry of entries) {
    const url = entry.request?.url ?? '';
    const mime = entry.response?.content?.mimeType ?? '';
    if (!/^image\//.test(mime) && !/\.(png|jpg|jpeg|webp|avif)(\?|$)/i.test(url)) continue;
    const size = getBodySize(entry);
    const key = url;
    if (seen.has(key)) continue;
    seen.add(key);

    let srcPath = url;
    let srcType = 'remote';
    const content = entry.response?.content ?? {};
    if (content.text && content.encoding === 'base64' && mime.startsWith('image/')) {
      const ext = extFromPathname(url) || '.bin';
      const outFile = safeFileName(basename(new URL(url).pathname), id, ext);
      writeFileSync(join(assetsDir, outFile), Buffer.from(content.text, 'base64'));
      srcPath = `embedded/${src.id}/${outFile}`;
      srcType = 'embedded';
    }

    textures.push({
      id: id++,
      url,
      path: new URL(url).pathname,
      fileName: basename(new URL(url).pathname),
      ext: extFromPathname(url) || '.jpg',
      mime,
      size,
      sizeFmt: fmtSize(size),
      category: classifyPpPath(url),
      channel: channelFromUrl(url),
      src: srcPath,
      srcType,
      source: 'direct',
    });
  }

  for (const entry of entries) {
    const url = entry.request?.url ?? '';
    if (!/resources.*\.json|GUI\d+\.json|game\d+\.json/i.test(url)) continue;
    const text = bodyText(entry);
    if (!text || text.length < 100) continue;
    const packName = basename(new URL(url).pathname);
    for (const ex of extractFromResourceJson(text, url)) {
      const raw = ex.url || ex.data;
      if (!raw) continue;
      const key = `${url}::${ex.name}::${String(raw).slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let srcPath = raw;
      let srcType = 'remote';
      let size = 0;
      let ext = '.png';
      let mime = 'image/png';

      if (String(raw).startsWith('data:image')) {
        const mimeMatch = raw.match(/^data:(image\/[^;]+)/);
        mime = mimeMatch?.[1] || 'image/png';
        ext = mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.png';
        const b64 = raw.slice(raw.indexOf(',') + 1);
        size = Math.floor(b64.length * 3 / 4);
        const outFile = safeFileName(`${packName}_${ex.name}`, id, ext);
        writeFileSync(join(assetsDir, outFile), Buffer.from(b64, 'base64'));
        srcPath = `embedded/${src.id}/${outFile}`;
        srcType = 'embedded';
      } else if (raw.startsWith('http')) {
        ext = extFromPathname(raw) || '.png';
        mime = ext === '.jpg' ? 'image/jpeg' : 'image/png';
        srcPath = raw;
        srcType = 'remote';
      } else {
        continue;
      }

      textures.push({
        id: id++,
        url: ex.url?.startsWith('http') ? ex.url : url,
        path: `${new URL(url).pathname}#${ex.name}`,
        fileName: ex.name,
        ext,
        mime,
        size,
        sizeFmt: fmtSize(size),
        category: classifyPpPath(url),
        channel: ex.ctx.channel,
        src: srcPath,
        srcType,
        source: packName,
        pack: url,
      });
    }
  }

  textures.sort((a, b) => b.size - a.size);
  const channel =
    textures.some((t) => t.channel === 'mobile') && !textures.some((t) => t.channel === 'desktop')
      ? 'mobile'
      : textures.some((t) => t.channel === 'mobile')
        ? 'mixed'
        : 'desktop';

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
      directImages: textures.filter((t) => t.source === 'direct').length,
      fromJson: textures.filter((t) => t.source !== 'direct').length,
      channel,
      harEntries: entries.length,
    },
    textures,
    categories: [...new Set(textures.map((t) => t.category))].sort(),
    extensions: [...new Set(textures.map((t) => t.ext))].sort(),
  };
}
