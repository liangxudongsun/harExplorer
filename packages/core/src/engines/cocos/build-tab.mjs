import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { scanCocosHar, tagCocosTextures } from './parse-import.mjs';
import { extractCocosAnimationPacks, bakeAnimationFrames } from './extract-animations.mjs';
import { parseAtlasPages, normalizeSkeletonJsonForRuntime } from './spine-extract.mjs';
import { extractBitmapFonts, matchAllFontTextures, fntConfigToBmFont, glyphPreview, fontAtlasExtent } from './bitmap-font.mjs';

const TEXTURE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif',
]);
const TEXTURE_MIME = /^image\//;

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('?')[0];
    const m = p.match(/\.([a-z0-9]+)$/i);
    return m ? `.${m[1].toLowerCase()}` : '(no-ext)';
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
  if (
    !buf ||
    buf.length < 30 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  // Chunk tag lives at offset 12 (after RIFF size + 'WEBP').
  const tag = buf.toString('ascii', 12, 16);
  if (tag === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { w, h };
  }
  if (tag === 'VP8 ') {
    return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  if (tag === 'VP8L') {
    const n = buf.readUInt32LE(21);
    return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function imageDimensions(buf, ext) {
  if (!buf) return null;
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) return pngSize(buf);
  if (ext === '.webp') {
    const w = webpSize(buf);
    if (w) return w;
  }
  if (ext === '.jpg' || ext === '.jpeg') return jpgSize(buf);
  return pngSize(buf) ?? webpSize(buf) ?? jpgSize(buf);
}

function classifyCocosPath(path) {
  const p = path.toLowerCase();
  const bundle = p.match(/\/assets\/([^/]+)\/native\//)?.[1];
  if (bundle) return bundle;
  if (p.includes('/slotframework/')) return 'slotFramework';
  if (p.includes('/public/')) return 'public';
  if (p.includes('/images/logos/')) return 'logo';
  return 'other';
}

function gameNameFromTitle(title) {
  const gn = title?.match(/[?&]gn=([^&]+)/)?.[1];
  if (gn) return decodeURIComponent(gn);
  const m = title?.match(/gname=([^&]+)/i)?.[1];
  return m ? decodeURIComponent(m) : null;
}

function safeId(url, idx) {
  const p = pathFromUrl(url).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${String(idx).padStart(3, '0')}_${p}`.slice(0, 100);
}

function safeAnimId(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/**
 * Write real Spine export files (skeleton.json + skeleton.atlas + page images)
 * into animations/<tabId>/<id>/, mirroring extract-cocos-spine-packs.mjs so the
 * in-browser viewer can load them over HTTP exactly like a Spine online viewer.
 * Returns URLs relative to the build root, or null when no atlas pages resolved.
 */
function writeSpineExport(outDir, tabId, id, pack) {
  if (!pack.skeletonJson || !pack.atlasText) return null;
  const dir = join(outDir, 'animations', tabId, id);
  const relBase = `animations/${tabId}/${id}`;
  const atlasPages = parseAtlasPages(pack.atlasText);
  const pageUrls = {};
  const missingPages = [];

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'skeleton.json'),
    JSON.stringify(normalizeSkeletonJsonForRuntime(pack.skeletonJson)),
    'utf8',
  );
  writeFileSync(join(dir, 'skeleton.atlas'), pack.atlasText, 'utf8');

  for (const page of atlasPages) {
    const hit = pack.texturePages?.[page.page];
    let buf = null;
    if (hit?.textureSrc) {
      const abs = join(outDir, hit.textureSrc);
      if (existsSync(abs)) buf = readFileSync(abs);
    }
    if (!buf && pack.textureSrc && atlasPages.length === 1) {
      const abs = join(outDir, pack.textureSrc);
      if (existsSync(abs)) buf = readFileSync(abs);
    }
    if (!buf) {
      missingPages.push(page.page);
      continue;
    }
    writeFileSync(join(dir, page.page), buf);
    pageUrls[page.page] = `${relBase}/${page.page}`;
  }

  return {
    skelUrl: `${relBase}/skeleton.json`,
    atlasUrl: `${relBase}/skeleton.atlas`,
    pageUrls,
    missingPages,
  };
}

function writeAnimationPacks(outDir, tabId, packs) {
  const animDir = join(outDir, 'animations', tabId);
  mkdirSync(animDir, { recursive: true });

  const manifest = [];
  const seen = new Set();

  for (const pack of packs) {
    const hasTex =
      pack.textureSrc ||
      Object.keys(pack.texturePages ?? {}).length > 0;
    if (!hasTex || !pack.skeletonJson || !pack.atlasText) continue;
    const id = safeAnimId(pack.id);
    if (seen.has(id)) continue;
    seen.add(id);

    const previewFile = `animations/${tabId}/${id}.json`;
    const isSpine = String(pack.type ?? '').startsWith('spine');
    const spineExport = isSpine ? writeSpineExport(outDir, tabId, id, pack) : null;
    const slim = {
      id,
      type: pack.type,
      name: pack.name,
      importUrl: pack.importUrl,
      bundle: pack.bundle,
      textureSrc: pack.textureSrc,
      textureUrl: pack.textureUrl ?? null,
      textureFileName: pack.textureFileName ?? null,
      width: pack.width ?? null,
      height: pack.height ?? null,
      regionCount: pack.regionCount ?? pack.frameCount ?? 0,
      sequenceGroups: pack.sequenceGroups ?? [],
      animationNames: pack.animationNames ?? [],
      defaultAnimation: pack.defaultAnimation ?? null,
      spineVersion: pack.spineVersion ?? null,
      previewFile,
      skelUrl: spineExport?.skelUrl ?? null,
      atlasUrl: spineExport?.atlasUrl ?? null,
      pageUrls: spineExport?.pageUrls ?? null,
      missingExportPages: spineExport?.missingPages ?? [],
    };

    writeFileSync(
      join(animDir, `${id}.json`),
      JSON.stringify(
        {
          ...slim,
          regions: pack.regions ?? null,
          frames: pack.frames ?? null,
          atlasText: pack.atlasText ?? null,
          skeletonJson: pack.skeletonJson ?? null,
          texturePages: pack.texturePages ?? {},
          missingAtlasPages: pack.missingAtlasPages ?? [],
          timelines: pack.timelines ?? {},
          colorTimelines: pack.colorTimelines ?? {},
          bakedFrames: pack.bakedFrames ?? {},
        },
        null,
        0,
      ),
    );
    manifest.push(slim);
  }

  manifest.sort((a, b) => (b.regionCount ?? 0) - (a.regionCount ?? 0));
  writeFileSync(join(animDir, 'manifest.json'), JSON.stringify({ tabId, items: manifest }, null, 2));
  return manifest;
}

/**
 * Extract cc.BitmapFont assets, write <name>.fnt + <name>.png under
 * fonts/<tabId>/<id>/ and return the manifest (also inlined into the tab so
 * the viewer needs no extra fetch).
 */
function writeBitmapFonts(outDir, tabId, entries, textures) {
  const fonts = extractBitmapFonts(entries);
  if (!fonts.length) return [];
  const fontsDir = join(outDir, 'fonts', tabId);
  const manifest = [];
  const importTexts = new Map();
  for (const e of entries) {
    const url = e.request?.url ?? '';
    if (!/\/import\//.test(url)) continue;
    const c = e.response?.content;
    if (!c?.text) continue;
    const text = c.encoding === 'base64' ? Buffer.from(c.text, 'base64').toString('utf8') : c.text;
    if (text.includes('fontDefDictionary')) importTexts.set(url, text);
  }
  const texByFont = matchAllFontTextures(fonts, textures, importTexts);

  for (const font of fonts) {
    const id = safeAnimId(font.fontName);
    const tex = texByFont.get(font.fontName) ?? null;
    const dir = join(fontsDir, id);
    mkdirSync(dir, { recursive: true });

    // Keep the texture's real format (CC3 often ships webp, not png).
    const texExt = tex?.src?.match(/(\.[a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '.png';
    const pngName = `${id}${texExt}`;
    const fntName = `${id}.fnt`;
    let pngUrl = null;
    if (tex) {
      const abs = join(outDir, tex.src);
      if (existsSync(abs)) {
        writeFileSync(join(dir, pngName), readFileSync(abs));
        pngUrl = `fonts/${tabId}/${id}/${pngName}`;
      }
    }
    writeFileSync(join(dir, fntName), fntConfigToBmFont(font.fntConfig, font.fontName, pngName), 'utf8');

    const defs = font.fntConfig.fontDefDictionary ?? {};
    const extent = fontAtlasExtent(font.fntConfig);
    manifest.push({
      id,
      name: font.fontName,
      fontSize: font.fntConfig.fontSize ?? null,
      commonHeight: font.fntConfig.commonHeight ?? null,
      glyphCount: Object.keys(defs).length,
      glyphs: glyphPreview(defs),
      atlasWidth: tex?.width ?? extent.w,
      atlasHeight: tex?.height ?? extent.h,
      textureFileName: tex?.fileName ?? null,
      importUrl: font.importUrl,
      fntUrl: `fonts/${tabId}/${id}/${fntName}`,
      pngUrl,
      fontDefDictionary: defs,
    });
  }

  writeFileSync(join(fontsDir, 'manifest.json'), JSON.stringify({ tabId, items: manifest }, null, 2));
  return manifest;
}

function fmtSize(size) {
  if (size >= 1048576) return `${(size / 1048576).toFixed(2)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

export function buildCocosTab(harPath, outDir, src) {
  if (!existsSync(harPath)) {
    if (src.optional) {
      console.warn(`  skip optional HAR: ${harPath}`);
      return {
        id: src.id,
        label: src.label,
        meta: { harPath, missing: true, total: 0, vramBytes: 0 },
        textures: [],
        categories: [],
        extensions: [],
      };
    }
    throw new Error(`HAR not found: ${harPath}`);
  }

  const har = JSON.parse(readFileSync(harPath, 'utf8'));
  const entries = har.log?.entries ?? [];
  const pageTitle = har.log?.pages?.[0]?.title ?? '';
  const assetsDir = join(outDir, 'embedded', src.id);
  mkdirSync(assetsDir, { recursive: true });

  const urlMap = new Map();
  let idx = 0;
  let vramBytes = 0;

  for (const entry of entries) {
    const url = entry.request?.url ?? '';
    const mime = entry.response?.content?.mimeType ?? '';
    const ext = extFromUrl(url);
    const isTex = TEXTURE_EXT.has(ext) || TEXTURE_MIME.test(mime.toLowerCase());
    if (!isTex) continue;
    if (entry.response?.status && (entry.response.status < 200 || entry.response.status >= 400)) continue;

    const size = getBodySize(entry);
    const path = pathFromUrl(url);
    const prev = urlMap.get(url);
    if (prev && prev.size >= size) continue;

    const fileName = basename(path.split('?')[0]);
    const buf = getImageBuffer(entry);
    const dim = imageDimensions(buf, ext);
    const texVram = dim ? dim.w * dim.h * 4 : 0;

    let srcPath = url;
    let srcType = 'remote';

    if (buf && mime.startsWith('image/')) {
      const outFile = `${safeId(url, idx)}${ext}`;
      writeFileSync(join(assetsDir, outFile), buf);
      srcPath = `embedded/${src.id}/${outFile}`;
      srcType = 'embedded';
    }

    urlMap.set(url, {
      id: idx++,
      url,
      path,
      fileName,
      ext,
      mime,
      size,
      sizeFmt: fmtSize(size),
      category: classifyCocosPath(path),
      src: srcPath,
      srcType,
      width: dim?.w ?? null,
      height: dim?.h ?? null,
      vramBytes: texVram,
      source: 'direct',
    });
  }

  const textures = [...urlMap.values()].sort((a, b) => b.size - a.size);
  for (const t of textures) vramBytes += t.vramBytes || 0;

  const scan = scanCocosHar(entries);
  const animExtract = extractCocosAnimationPacks(entries, textures);
  for (const pack of animExtract.all) {
    if (pack.regions) pack.bakedFrames = bakeAnimationFrames(pack);
  }
  const tagged = tagCocosTextures(textures, scan, animExtract.spinePacks);
  const animationManifest = writeAnimationPacks(outDir, src.id, animExtract.all);
  const fontManifest = writeBitmapFonts(outDir, src.id, entries, textures);
  const resourceTypes = [...new Set(tagged.textures.map((t) => t.resourceType))].sort();

  return {
    id: src.id,
    label: src.label,
    meta: {
      harPath: harPath.replace(/\\/g, '/'),
      pageTitle,
      gameName: gameNameFromTitle(pageTitle),
      builtAt: new Date().toISOString(),
      engine: 'Cocos Creator',
      total: tagged.textures.length,
      embedded: tagged.textures.filter((t) => t.srcType === 'embedded').length,
      remote: tagged.textures.filter((t) => t.srcType === 'remote').length,
      vramBytes,
      vramFmt: fmtSize(vramBytes),
      channel: /client_type=web/i.test(pageTitle) ? 'web' : 'unknown',
      harEntries: entries.length,
      previewCount: animationManifest.length,
      fontCount: fontManifest.length,
      ...tagged.meta,
    },
    textures: tagged.textures,
    spineAssets: tagged.spineAssets,
    sequenceSummary: tagged.sequenceSummary,
    animationManifest,
    fontManifest,
    categories: [...new Set(tagged.textures.map((t) => t.category))].sort(),
    extensions: [...new Set(tagged.textures.map((t) => t.ext))].sort(),
    resourceTypes,
  };
}
