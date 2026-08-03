/**
 * SlotMill / Pixi HAR → texture-viewer tab.
 *
 * Eternal Dusk 资源布局（典型）：
 *   /assets/spine/<name>.json              Spine skeleton（常为 4.1.x）
 *   /assets/spine/avif/<n>/<name>.atlas    图集描述（页为 .avif）
 *   /assets/spine/avif/<n>/*.avif          图集页（HAR 常无 body，需拉取）
 *   /assets/sounds/ogg/*.ogg               音频（HAR 内嵌）
 *   /assets/fonts/bitmap/avif/*.fnt+.avif  BMFont XML + 贴图
 *   /assets/particles/avif/textures/*.avif 粒子贴图
 *
 * 输出与 Cocos tab 对齐：textures / animationManifest / audioManifest / fontManifest
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'fs';
import { join, basename, dirname, extname } from 'path';
import {
  readCdnCache,
  writeCdnCache,
  fetchIntoCdnCache,
} from '../cocos/cdn-cache.mjs';

const TEXTURE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif',
]);
const TEXTURE_MIME = /^image\//;
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac']);
const AUDIO_MIME = /^audio\//;

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('?')[0];
    return extname(p).toLowerCase() || '(no-ext)';
  } catch {
    return '(invalid)';
  }
}

function pathFromUrl(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function fileNameFromUrl(url) {
  const p = pathFromUrl(url);
  return p.split('/').pop()?.split('?')[0] || 'file';
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
    if (content.encoding === 'base64') {
      return Math.floor((content.text.length * 3) / 4);
    }
    return Buffer.byteLength(content.text, 'utf8');
  }
  return 0;
}

function decodeBody(content) {
  if (!content?.text) return null;
  try {
    if (content.encoding === 'base64') return Buffer.from(content.text, 'base64');
    return Buffer.from(content.text, 'utf8');
  } catch {
    return null;
  }
}

function bodyText(entry) {
  const buf = decodeBody(entry.response?.content);
  return buf ? buf.toString('utf8') : null;
}

function classifyPath(path) {
  const p = path.toLowerCase();
  if (p.includes('/spine/avif') || /\.atlas$/i.test(p)) return 'spine-atlas';
  if (p.includes('/spine/')) return 'spine';
  if (p.includes('/sprites/')) return 'sprites';
  if (p.includes('/fonts/bitmap')) return 'bitmap-font';
  if (p.includes('/fonts/')) return 'font';
  if (p.includes('/particles/')) return 'particles';
  if (p.includes('/sounds/') || p.includes('/audio/')) return 'audio';
  if (p.includes('/loading-screen')) return 'loading-screen';
  if (p.includes('/favicons')) return 'favicon';
  return 'other';
}

function fmtSize(size) {
  if (!size || size < 0) return '0 B';
  if (size >= 1048576) return `${(size / 1048576).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function safeId(name) {
  return String(name || 'item')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'item';
}

function safeFileId(url, idx) {
  const p = pathFromUrl(url).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `${String(idx).padStart(3, '0')}_${p}`.slice(0, 120);
}

/** Spine atlas pages — include .avif (SlotMill). */
export function parseAtlasPages(atlasText) {
  const text = String(atlasText ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
  const pages = [];
  const re =
    /(?:^|\n)([^\n]+\.(?:png|jpg|jpeg|webp|avif))\nsize:\s*(\d+)\s*,\s*(\d+)/gi;
  let m;
  while ((m = re.exec(text))) {
    pages.push({
      page: m[1].trim(),
      width: parseInt(m[2], 10),
      height: parseInt(m[3], 10),
    });
  }
  return pages;
}

/** Full atlas regions for texture sub-frame preview. */
export function parseAtlasRegions(atlasText) {
  const text = String(atlasText ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
  const lines = text.split(/\r?\n/);
  const byPage = new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    if (
      !line.includes(':') &&
      /\.(avif|png|jpg|jpeg|webp)$/i.test(line)
    ) {
      const pageName = line;
      const page = {
        pageName,
        width: 0,
        height: 0,
        regions: [],
      };
      i++;
      while (i < lines.length) {
        const raw = lines[i];
        const l = raw.trim();
        if (!l) {
          i++;
          continue;
        }
        if (
          !raw.startsWith(' ') &&
          !raw.startsWith('\t') &&
          !l.includes(':') &&
          /\.(avif|png|jpg|jpeg|webp)$/i.test(l)
        ) {
          break;
        }
        const sm = l.match(/^size:\s*(\d+)\s*,\s*(\d+)/i);
        if (sm) {
          page.width = parseInt(sm[1], 10);
          page.height = parseInt(sm[2], 10);
          i++;
          continue;
        }
        if (
          !raw.startsWith(' ') &&
          !raw.startsWith('\t') &&
          !l.includes(':')
        ) {
          const region = {
            name: l,
            rotate: false,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            origW: 0,
            origH: 0,
          };
          i++;
          while (
            i < lines.length &&
            (lines[i].startsWith(' ') || lines[i].startsWith('\t'))
          ) {
            const rl = lines[i].trim();
            const rm = rl.match(/^rotate:\s*(true|false)/i);
            if (rm) region.rotate = rm[1].toLowerCase() === 'true';
            const xy = rl.match(/^xy:\s*(\d+)\s*,\s*(\d+)/i);
            if (xy) {
              region.x = parseInt(xy[1], 10);
              region.y = parseInt(xy[2], 10);
            }
            const sz = rl.match(/^size:\s*(\d+)\s*,\s*(\d+)/i);
            if (sz) {
              region.width = parseInt(sz[1], 10);
              region.height = parseInt(sz[2], 10);
            }
            const orig = rl.match(/^orig:\s*(\d+)\s*,\s*(\d+)/i);
            if (orig) {
              region.origW = parseInt(orig[1], 10);
              region.origH = parseInt(orig[2], 10);
            }
            i++;
          }
          page.regions.push(region);
          continue;
        }
        i++;
      }
      byPage.set(pageName, page);
      continue;
    }
    i++;
  }
  return byPage;
}

/**
 * BMFont XML → viewer fontDefDictionary
 * { [charCode]: { rect:{x,y,width,height}, xOffset, yOffset, xAdvance } }
 */
export function parseBmFontXml(xml) {
  const text = String(xml ?? '');
  const face =
    text.match(/face\s*=\s*"([^"]+)"/i)?.[1] ||
    text.match(/face\s*=\s*'([^']+)'/i)?.[1] ||
    'font';
  const fontSize = parseInt(
    text.match(/size\s*=\s*"?(-?\d+)/i)?.[1] ?? '0',
    10,
  );
  const commonHeight = parseInt(
    text.match(/lineHeight\s*=\s*"?(-?\d+)/i)?.[1] ?? String(fontSize),
    10,
  );
  const atlasW = parseInt(text.match(/scaleW\s*=\s*"?(\d+)/i)?.[1] ?? '0', 10);
  const atlasH = parseInt(text.match(/scaleH\s*=\s*"?(\d+)/i)?.[1] ?? '0', 10);
  const pageFile =
    text.match(/<page[^>]*file\s*=\s*"([^"]+)"/i)?.[1] ||
    text.match(/file\s*=\s*"([^"]+\.(?:png|avif|jpg|webp))"/i)?.[1] ||
    null;

  const fontDefDictionary = {};
  const glyphs = [];
  const charRe =
    /<char\b[^>]*\bid\s*=\s*"(\d+)"[^>]*>/gi;
  let m;
  while ((m = charRe.exec(text))) {
    const block = m[0];
    const id = parseInt(m[1], 10);
    const num = (attr) =>
      parseInt(block.match(new RegExp(`${attr}\\s*=\\s*"(-?\\d+)"`, 'i'))?.[1] ?? '0', 10);
    const x = num('x');
    const y = num('y');
    const width = num('width');
    const height = num('height');
    fontDefDictionary[id] = {
      rect: { x, y, width, height },
      xOffset: num('xoffset'),
      yOffset: num('yoffset'),
      xAdvance: num('xadvance'),
    };
    if (id >= 32 && id < 127) glyphs.push(String.fromCharCode(id));
  }

  return {
    face,
    fontSize: fontSize || null,
    commonHeight: commonHeight || fontSize || null,
    atlasWidth: atlasW || null,
    atlasHeight: atlasH || null,
    pageFile,
    glyphCount: Object.keys(fontDefDictionary).length,
    glyphs: glyphs.join(''),
    fontDefDictionary,
    rawXml: text,
  };
}

function guessAudioMime(ext) {
  switch (ext) {
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
    case '.aac':
      return 'audio/mp4';
    default:
      return 'application/octet-stream';
  }
}

function isAvifOrImageBuf(buf, mime) {
  if (!buf?.length) return false;
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf.toString('ascii', 0, 4) === 'RIFF') return true;
  // AVIF / HEIF: ....ftyp....avif
  if (buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp') return true;
  return false;
}

async function fetchBinary(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { Accept: '*/*' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const mime = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 16) return { ok: false, error: `body too small (${buf.length})` };
    return { ok: true, buf, mime };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function mapPool(items, concurrency, fn) {
  const list = [...items];
  let i = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, list.length)) },
    async () => {
      while (i < list.length) {
        const idx = i++;
        await fn(list[idx], idx);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * @param {string} harPath
 * @param {string} outDir
 * @param {{ id: string, label: string }} src
 * @param {{ fetchRemote?: boolean, concurrency?: number, timeoutMs?: number }} [opts]
 */
export async function buildSlotmillTab(harPath, outDir, src, opts = {}) {
  const fetchRemote = opts.fetchRemote !== false;
  const concurrency = opts.concurrency ?? 8;
  const timeoutMs = opts.timeoutMs ?? 20000;

  const har = JSON.parse(readFileSync(harPath, 'utf8'));
  const entries = har.log?.entries ?? [];
  const pageTitle = har.log?.pages?.[0]?.title ?? '';

  const assetsDir = join(outDir, 'embedded', src.id);
  const cdnCacheRoot = join(outDir, 'cdn-cache');
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(cdnCacheRoot, { recursive: true });

  // ---- index entries by pathname (latest / largest body wins) ----
  /** @type {Map<string, any>} */
  const byPath = new Map();
  for (const entry of entries) {
    const url = entry.request?.url ?? '';
    if (!url || url.startsWith('data:')) continue;
    if (entry.response?.status && (entry.response.status < 200 || entry.response.status >= 400)) {
      continue;
    }
    const path = pathFromUrl(url);
    const size = getBodySize(entry);
    const prev = byPath.get(path);
    if (prev && (prev.size ?? 0) >= size && prev.body) continue;
    const body = decodeBody(entry.response?.content);
    byPath.set(path, {
      entry,
      url,
      path,
      size,
      mime: entry.response?.content?.mimeType ?? '',
      body,
    });
  }

  // ---- atlas index (pageName → regions + atlasPath) ----
  const atlasByPage = new Map();
  /** @type {Map<string, { atlasText: string, atlasPath: string, atlasUrl: string }>} */
  const atlasByStem = new Map();
  for (const rec of byPath.values()) {
    if (!/\.atlas$/i.test(rec.path)) continue;
    const text = rec.body ? rec.body.toString('utf8') : null;
    if (!text) continue;
    const stem = basename(rec.path).replace(/\.atlas$/i, '');
    atlasByStem.set(stem, {
      atlasText: text,
      atlasPath: rec.path,
      atlasUrl: rec.url,
    });
    for (const [pageName, page] of parseAtlasRegions(text)) {
      const prev = atlasByPage.get(pageName);
      if (!prev || page.regions.length > prev.regions.length) {
        atlasByPage.set(pageName, {
          ...page,
          atlasPath: rec.path,
          atlasStem: stem,
        });
      }
    }
  }

  // ---- textures ----
  const urlMap = new Map();
  let idx = 0;
  let fetchedCount = 0;
  let fetchFailed = 0;

  const textureCandidates = [];
  for (const rec of byPath.values()) {
    const ext = extFromUrl(rec.url);
    const isTex =
      TEXTURE_EXT.has(ext) || TEXTURE_MIME.test((rec.mime || '').toLowerCase());
    if (!isTex) continue;
    textureCandidates.push(rec);
  }

  // Prefer HAR body / cdn-cache first
  for (const rec of textureCandidates) {
    const ext = extFromUrl(rec.url);
    const fileName = fileNameFromUrl(rec.url);
    let buf = rec.body;
    let srcPath = rec.url;
    let srcType = 'remote';

    if (buf && isAvifOrImageBuf(buf, rec.mime)) {
      const outFile = safeFileId(rec.url, idx) + (TEXTURE_EXT.has(ext) ? ext : '.bin');
      writeFileSync(join(assetsDir, outFile), buf);
      writeCdnCache(cdnCacheRoot, rec.url, buf);
      srcPath = `embedded/${src.id}/${outFile}`;
      srcType = 'embedded';
    } else {
      const cached = readCdnCache(cdnCacheRoot, rec.url);
      if (cached && isAvifOrImageBuf(cached, rec.mime)) {
        const outFile = safeFileId(rec.url, idx) + (TEXTURE_EXT.has(ext) ? ext : '.bin');
        writeFileSync(join(assetsDir, outFile), cached);
        buf = cached;
        srcPath = `embedded/${src.id}/${outFile}`;
        srcType = 'embedded';
      }
    }

    const atlas = atlasByPage.get(fileName);
    const frames = atlas?.regions?.map((r) => ({
      name: r.name,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      rotated: !!r.rotate,
      origW: r.origW || undefined,
      origH: r.origH || undefined,
    })) ?? null;

    urlMap.set(rec.url, {
      id: idx++,
      url: rec.url,
      path: rec.path,
      fileName,
      ext,
      mime: rec.mime || guessMimeFromExt(ext),
      size: buf?.length ?? rec.size,
      sizeFmt: fmtSize(buf?.length ?? rec.size),
      category: classifyPath(rec.path),
      src: srcPath,
      srcType,
      width: atlas?.width ?? null,
      height: atlas?.height ?? null,
      atlasRegions: atlas?.regions?.length ?? null,
      atlasFrameCount: frames?.length ?? null,
      atlasPath: atlas?.atlasPath ?? null,
      frames,
      spineName: atlas?.atlasStem ?? null,
      matchHow: frames?.length ? 'spine-atlas' : null,
      _needsFetch: srcType === 'remote',
    });
  }

  // Fetch remaining remote textures (SlotMill HAR often omits AVIF bodies)
  if (fetchRemote) {
    const pending = [...urlMap.values()].filter((t) => t._needsFetch);
    await mapPool(pending, concurrency, async (t) => {
      const result = await fetchIntoCdnCache(cdnCacheRoot, t.url, { timeoutMs });
      // fetchIntoCdnCache rejects non-image mime strictly; AVIF ok via image/*
      if (!result.ok) {
        // fallback: raw fetch (accept any binary that looks like avif/image)
        const raw = await fetchBinary(t.url, { timeoutMs });
        if (!raw.ok || !isAvifOrImageBuf(raw.buf, raw.mime)) {
          fetchFailed += 1;
          return;
        }
        writeCdnCache(cdnCacheRoot, t.url, raw.buf);
        const ext = TEXTURE_EXT.has(t.ext) ? t.ext : '.avif';
        const outFile = safeFileId(t.url, t.id) + ext;
        writeFileSync(join(assetsDir, outFile), raw.buf);
        t.src = `embedded/${src.id}/${outFile}`;
        t.srcType = 'embedded';
        t.size = raw.buf.length;
        t.sizeFmt = fmtSize(raw.buf.length);
        if (raw.mime) t.mime = raw.mime;
        fetchedCount += 1;
        return;
      }
      const ext = TEXTURE_EXT.has(t.ext) ? t.ext : '.avif';
      const outFile = safeFileId(t.url, t.id) + ext;
      writeFileSync(join(assetsDir, outFile), result.buf);
      t.src = `embedded/${src.id}/${outFile}`;
      t.srcType = 'embedded';
      t.size = result.buf.length;
      t.sizeFmt = fmtSize(result.buf.length);
      fetchedCount += 1;
    });
  }

  for (const t of urlMap.values()) delete t._needsFetch;
  const textures = [...urlMap.values()].sort((a, b) => b.size - a.size);
  const textureByFileName = new Map(textures.map((t) => [t.fileName, t]));

  // ---- Spine packs ----
  const animationManifest = writeSpinePacks({
    outDir,
    tabId: src.id,
    byPath,
    atlasByStem,
    textureByFileName,
  });

  // ---- Audio ----
  const audioManifest = writeAudioPacks(outDir, src.id, byPath);

  // ---- Bitmap fonts ----
  const fontManifest = await writeFontPacks({
    outDir,
    tabId: src.id,
    byPath,
    textureByFileName,
    cdnCacheRoot,
    assetsDir,
    fetchRemote,
    timeoutMs,
  });

  // Particle textures already in textures[]; lightweight manifest for listing
  const particleManifest = textures
    .filter((t) => t.category === 'particles')
    .map((t) => ({
      id: safeId(t.fileName),
      name: t.fileName,
      kind: 'slotmill-texture',
      textureSrc: t.srcType === 'embedded' ? t.src : null,
      url: t.url,
      size: t.size,
      sizeFmt: t.sizeFmt,
    }));

  const spineVersions = [
    ...new Set(
      animationManifest.map((a) => a.spineVersion).filter(Boolean),
    ),
  ];

  return {
    id: src.id,
    label: src.label,
    meta: {
      harPath: harPath.replace(/\\/g, '/'),
      pageTitle,
      builtAt: new Date().toISOString(),
      engine: 'Slotmill',
      engineFamily: 'slotmill',
      total: textures.length,
      embedded: textures.filter((t) => t.srcType === 'embedded').length,
      remote: textures.filter((t) => t.srcType === 'remote').length,
      previewCount: animationManifest.length,
      fontCount: fontManifest.length,
      particleCount: particleManifest.length,
      audioCount: audioManifest.length,
      channel: textures.some((t) => /mobile/i.test(t.path)) ? 'mobile' : 'desktop',
      fetchedRemote: fetchedCount,
      fetchFailed,
      spineVersions,
      note: spineVersions.some((v) => /^4\./.test(String(v)))
        ? '含 Spine 4.x：动画预览走官方 Spine Web Player 4.1（iframe）'
        : null,
    },
    textures,
    categories: [...new Set(textures.map((t) => t.category))].sort(),
    extensions: [...new Set(textures.map((t) => t.ext))].sort(),
    animationManifest,
    fontManifest,
    particleManifest,
    audioManifest,
  };
}

function guessMimeFromExt(ext) {
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function writeSpinePacks({ outDir, tabId, byPath, atlasByStem, textureByFileName }) {
  const animDir = join(outDir, 'animations', tabId);
  mkdirSync(animDir, { recursive: true });
  const manifest = [];
  const seen = new Set();

  for (const rec of byPath.values()) {
    if (!/\/assets\/spine\/[^/]+\.json$/i.test(rec.path)) continue;
    if (!rec.body) continue;
    let skeletonJson;
    try {
      skeletonJson = JSON.parse(rec.body.toString('utf8'));
    } catch {
      continue;
    }
    if (!skeletonJson?.skeleton && !skeletonJson?.bones) continue;

    const name = basename(rec.path, '.json');
    const id = safeId(name);
    if (seen.has(id)) continue;
    seen.add(id);

    const atlasHit = atlasByStem.get(name);
    if (!atlasHit?.atlasText) continue;

    const pages = parseAtlasPages(atlasHit.atlasText);
    const relBase = `animations/${tabId}/${id}`;
    const packDir = join(animDir, id);
    mkdirSync(packDir, { recursive: true });

    writeFileSync(join(packDir, 'skeleton.json'), JSON.stringify(skeletonJson), 'utf8');
    writeFileSync(join(packDir, 'skeleton.atlas'), atlasHit.atlasText, 'utf8');

    const pageUrls = {};
    const texturePages = {};
    const missingPages = [];
    let primarySrc = null;
    let width = null;
    let height = null;

    for (const page of pages) {
      const tex = textureByFileName.get(page.page);
      let buf = null;
      if (tex?.srcType === 'embedded' && tex.src) {
        const abs = join(outDir, tex.src);
        if (existsSync(abs)) buf = readFileSync(abs);
      }
      if (!buf) {
        missingPages.push(page.page);
        continue;
      }
      writeFileSync(join(packDir, page.page), buf);
      pageUrls[page.page] = `${relBase}/${page.page}`;
      texturePages[page.page] = {
        textureSrc: tex.src,
        width: page.width,
        height: page.height,
      };
      if (!primarySrc) {
        primarySrc = tex.src;
        width = page.width;
        height = page.height;
      }
    }

    const animationNames = Object.keys(skeletonJson.animations || {});
    const defaultAnimation =
      animationNames.find((n) => /idle|loop/i.test(n)) ||
      animationNames[0] ||
      null;
    const spineVersion = skeletonJson.skeleton?.spine ?? null;
    const regionCount = [...parseAtlasRegions(atlasHit.atlasText).values()].reduce(
      (n, p) => n + (p.regions?.length || 0),
      0,
    );

    const slim = {
      id,
      type: 'spine',
      name,
      importUrl: rec.url,
      bundle: 'slotmill',
      textureSrc: primarySrc,
      textureUrl: null,
      textureFileName: pages[0]?.page ?? null,
      width,
      height,
      regionCount,
      sequenceGroups: [],
      animationNames,
      defaultAnimation,
      spineVersion,
      previewFile: `animations/${tabId}/${id}.json`,
      skelUrl: `${relBase}/skeleton.json`,
      atlasUrl: `${relBase}/skeleton.atlas`,
      pageUrls,
      missingExportPages: missingPages,
    };

    writeFileSync(
      join(animDir, `${id}.json`),
      JSON.stringify(
        {
          ...slim,
          atlasText: atlasHit.atlasText,
          skeletonJson,
          texturePages,
          missingAtlasPages: missingPages,
        },
        null,
        0,
      ),
    );
    // Only list packs that have at least skeleton+atlas; pages may still be missing
    manifest.push(slim);

    // Link textures → spine name for「打开动画预览」
    for (const page of pages) {
      const tex = textureByFileName.get(page.page);
      if (tex && !tex.spineName) tex.spineName = name;
    }
  }

  writeFileSync(
    join(animDir, 'manifest.json'),
    JSON.stringify({ tabId, items: manifest }, null, 2),
  );
  return manifest;
}

function writeAudioPacks(outDir, tabId, byPath) {
  const root = join(outDir, 'audio', tabId);
  mkdirSync(root, { recursive: true });
  const manifest = [];
  const seen = new Set();

  for (const rec of byPath.values()) {
    const ext = extFromUrl(rec.url);
    const mime = (rec.mime || '').toLowerCase();
    const isAudio =
      AUDIO_EXT.has(ext) ||
      AUDIO_MIME.test(mime) ||
      /\/assets\/sounds\//i.test(rec.path);
    if (!isAudio || !rec.body) continue;

    const base = fileNameFromUrl(rec.url).replace(/\.[^.]+$/, '');
    let id = safeId(base);
    if (seen.has(id)) id = safeId(`${base}_${seen.size}`);
    seen.add(id);

    const useExt = AUDIO_EXT.has(ext) ? ext : '.ogg';
    const fileName = `${id}${useExt}`;
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), rec.body);

    const item = {
      id,
      kind: 'slotmillAudio',
      name: fileNameFromUrl(rec.url),
      uuid: null,
      duration: null,
      ext: useExt,
      mime: mime || guessAudioMime(useExt),
      size: rec.body.length,
      sizeFmt: fmtSize(rec.body.length),
      url: rec.url,
      importUrl: null,
      audioUrl: `audio/${tabId}/${id}/${fileName}`,
    };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(item, null, 2));
    manifest.push(item);
  }

  manifest.sort((a, b) => (b.size || 0) - (a.size || 0));
  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ tabId, items: manifest }, null, 2),
  );
  return manifest;
}

async function writeFontPacks({
  outDir,
  tabId,
  byPath,
  textureByFileName,
  cdnCacheRoot,
  assetsDir,
  fetchRemote,
  timeoutMs,
}) {
  const fontsDir = join(outDir, 'fonts', tabId);
  mkdirSync(fontsDir, { recursive: true });
  const manifest = [];
  const seen = new Set();

  for (const rec of byPath.values()) {
    if (!/\.fnt$/i.test(rec.path) || !rec.body) continue;
    const xml = rec.body.toString('utf8');
    if (!/<font[\s>]/i.test(xml) && !/common\s+lineHeight/i.test(xml)) continue;

    const parsed = parseBmFontXml(xml);
    const id = safeId(parsed.face || basename(rec.path, '.fnt'));
    if (seen.has(id)) continue;
    seen.add(id);

    const dir = join(fontsDir, id);
    mkdirSync(dir, { recursive: true });

    // Prefer pageFile from XML; fallback same-stem .avif next to .fnt
    let pageName = parsed.pageFile || `${id}.avif`;
    pageName = basename(pageName);
    let tex = textureByFileName.get(pageName);

    // Same-directory companion in HAR
    if (!tex) {
      const companionPath = join(dirname(rec.path), pageName).replace(/\\/g, '/');
      // pathFromUrl uses /, dirname on windows may use \
      const norm = rec.path.replace(/\\/g, '/');
      const dirUrl = norm.slice(0, norm.lastIndexOf('/') + 1);
      const companion = byPath.get(dirUrl + pageName);
      if (companion) {
        // ensure texture entry exists after fetch below
        tex = textureByFileName.get(pageName);
      }
    }

    let pngUrl = null;
    let pngName = pageName;
    if (tex?.srcType === 'embedded' && tex.src) {
      const abs = join(outDir, tex.src);
      if (existsSync(abs)) {
        const buf = readFileSync(abs);
        writeFileSync(join(dir, pngName), buf);
        pngUrl = `fonts/${tabId}/${id}/${pngName}`;
      }
    } else if (fetchRemote) {
      // try construct URL from fnt URL
      const fntUrl = rec.url.split('?')[0];
      const imgUrl = fntUrl.replace(/[^/]+$/, pageName);
      let buf = readCdnCache(cdnCacheRoot, imgUrl);
      if (!buf) {
        const raw = await fetchBinary(imgUrl, { timeoutMs });
        if (raw.ok && isAvifOrImageBuf(raw.buf, raw.mime)) {
          buf = raw.buf;
          writeCdnCache(cdnCacheRoot, imgUrl, buf);
        }
      }
      if (buf) {
        writeFileSync(join(dir, pngName), buf);
        pngUrl = `fonts/${tabId}/${id}/${pngName}`;
        // also drop into embedded for texture browsing
        const embName = `font_${safeId(pageName)}${extname(pageName) || '.avif'}`;
        writeFileSync(join(assetsDir, embName), buf);
      }
    }

    // Keep original XML fnt (already standard BMFont)
    const fntName = `${id}.fnt`;
    writeFileSync(join(dir, fntName), xml, 'utf8');

    manifest.push({
      id,
      name: parsed.face,
      fontSize: parsed.fontSize,
      commonHeight: parsed.commonHeight,
      glyphCount: parsed.glyphCount,
      glyphs: parsed.glyphs,
      atlasWidth: parsed.atlasWidth,
      atlasHeight: parsed.atlasHeight,
      textureFileName: pageName,
      importUrl: rec.url,
      fntUrl: `fonts/${tabId}/${id}/${fntName}`,
      pngUrl,
      fontDefDictionary: parsed.fontDefDictionary,
    });
  }

  writeFileSync(
    join(fontsDir, 'manifest.json'),
    JSON.stringify({ tabId, items: manifest }, null, 2),
  );
  return manifest;
}

/** Sync wrapper for callers that still expect sync (returns Promise). */
export function buildSlotmillTabSync(harPath, outDir, src, opts) {
  return buildSlotmillTab(harPath, outDir, src, opts);
}
