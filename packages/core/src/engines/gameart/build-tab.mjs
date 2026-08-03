/**
 * GameArt / HyperGaming HAR → texture-viewer tab.
 *
 * 典型布局（Lunar Rabbit 等）：
 *   .../graphics/mobile/spines/oneAtlas/
 *     spineMain.atlas + spineMain.webp … _N.webp   ← 多 skeleton 共享图集
 *     main_sym_WILD.json / main_background.json … ← Spine 4.1 skeleton
 *   .../graphics/mobile/spines/singleSpines/
 *     BuyMenu_Menu.{json,atlas,webp}               ← 一对一
 *   .../graphics/mobile/intro/spine/
 *   .../graphics/mobile/spritesheets/*.json+.webp  ← PIXI / TexturePacker
 *   .../sounds/*.ogg
 *
 * 输出与 Cocos / Slotmill tab 对齐。
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'fs';
import { join, basename, dirname } from 'path';
import {
  parseAtlasPages,
  parseAtlasRegions,
} from '../slotmill/build-tab.mjs';

const TEXTURE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif',
]);
const TEXTURE_MIME = /^image\//;
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac']);
const AUDIO_MIME = /^audio\//;

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('?')[0];
    const m = p.match(/(\.[a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '(no-ext)';
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

function classifyPath(path) {
  const p = path.toLowerCase();
  if (/\.atlas$/i.test(p) || /\/spines?\//.test(p) || /\/spine\//.test(p)) {
    return 'spine';
  }
  if (/\/spritesheets?\//.test(p)) return 'spritesheet';
  if (/\/statics?\//.test(p)) return 'static';
  if (/\/loading/.test(p)) return 'loading';
  if (/\/brands?\//.test(p)) return 'brand';
  if (/\/fonts?\//.test(p)) return 'font';
  if (/\/sounds?\//.test(p) || /\/audio\//.test(p)) return 'audio';
  if (/\/intro\//.test(p)) return 'intro';
  return 'other';
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

function guessAudioMime(ext) {
  switch (ext) {
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    default:
      return 'application/octet-stream';
  }
}

function dirOfPath(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
}

/** TexturePacker / PIXI JSON hash → viewer frames */
function parsePixiSheetFrames(json) {
  if (!json?.frames || typeof json.frames !== 'object') return null;
  const frames = [];
  for (const [name, fr] of Object.entries(json.frames)) {
    const box = fr?.frame;
    if (!box) continue;
    frames.push({
      name,
      x: box.x ?? 0,
      y: box.y ?? 0,
      width: box.w ?? box.width ?? 0,
      height: box.h ?? box.height ?? 0,
      rotated: !!fr.rotated,
      origW: fr.sourceSize?.w ?? fr.sourceSize?.width,
      origH: fr.sourceSize?.h ?? fr.sourceSize?.height,
    });
  }
  return frames.length ? frames : null;
}

/**
 * Resolve atlas for a skeleton JSON path.
 * GameArt oneAtlas: many skeletons share spineMain.atlas in the same folder.
 */
function resolveAtlasForSkeleton(skelPath, atlasesByDir) {
  const dir = dirOfPath(skelPath);
  const stem = basename(skelPath, '.json');
  const list = atlasesByDir.get(dir) || [];
  if (!list.length) return null;

  const sameStem = list.find(
    (a) => basename(a.path).replace(/\.atlas$/i, '') === stem,
  );
  if (sameStem) return { atlas: sameStem, matchHow: 'same-stem' };

  if (list.length === 1) return { atlas: list[0], matchHow: 'sole-in-dir' };

  const main = list.find((a) => /(?:^|\/)spineMain\.atlas$/i.test(a.path))
    || list.find((a) => /Main\.atlas$/i.test(a.path));
  if (main) return { atlas: main, matchHow: 'shared-main' };

  // Prefer largest atlas text (most pages/regions)
  const sorted = [...list].sort(
    (a, b) => (b.atlasText?.length || 0) - (a.atlasText?.length || 0),
  );
  return { atlas: sorted[0], matchHow: 'largest-in-dir' };
}

function writeSpinePacks({ outDir, tabId, byPath, textureByFileName }) {
  const animDir = join(outDir, 'animations', tabId);
  mkdirSync(animDir, { recursive: true });
  const manifest = [];
  const seen = new Set();

  /** @type {Map<string, Array<{ path: string, url: string, atlasText: string }>>} */
  const atlasesByDir = new Map();
  for (const rec of byPath.values()) {
    if (!/\.atlas$/i.test(rec.path) || !rec.body) continue;
    const atlasText = rec.body.toString('utf8');
    if (!/\.(webp|png|jpg|jpeg|avif)\b/i.test(atlasText)) continue;
    const dir = dirOfPath(rec.path);
    if (!atlasesByDir.has(dir)) atlasesByDir.set(dir, []);
    atlasesByDir.get(dir).push({
      path: rec.path,
      url: rec.url,
      atlasText,
    });
  }

  // atlas page fileName → packs that use it (for texture.spineName linking)
  const pageToPackNames = new Map();

  for (const rec of byPath.values()) {
    if (!/\.json$/i.test(rec.path) || !rec.body) continue;
    let skeletonJson;
    try {
      skeletonJson = JSON.parse(rec.body.toString('utf8'));
    } catch {
      continue;
    }
    if (!skeletonJson?.skeleton && !Array.isArray(skeletonJson?.bones)) continue;
    // Skip empty stub skeletons (only root, no animations) unless they have slots
    const animNames = Object.keys(skeletonJson.animations || {});
    const boneCount = skeletonJson.bones?.length ?? 0;
    const slotCount = skeletonJson.slots?.length ?? 0;
    if (animNames.length === 0 && boneCount <= 1 && slotCount === 0) continue;

    const name = basename(rec.path, '.json');
    let id = safeId(name);
    if (seen.has(id)) id = safeId(`${name}_${seen.size}`);
    seen.add(id);

    const resolved = resolveAtlasForSkeleton(rec.path, atlasesByDir);
    if (!resolved?.atlas?.atlasText) continue;
    const { atlas, matchHow } = resolved;

    const pages = parseAtlasPages(atlas.atlasText);
    if (!pages.length) continue;

    const relBase = `animations/${tabId}/${id}`;
    const packDir = join(animDir, id);
    mkdirSync(packDir, { recursive: true });

    writeFileSync(join(packDir, 'skeleton.json'), JSON.stringify(skeletonJson), 'utf8');
    writeFileSync(join(packDir, 'skeleton.atlas'), atlas.atlasText, 'utf8');

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
      // Fallback: same-dir companion still in HAR byPath
      if (!buf) {
        const pagePath = dirOfPath(atlas.path) + page.page;
        const pageRec = byPath.get(pagePath);
        if (pageRec?.body) buf = pageRec.body;
      }
      if (!buf) {
        missingPages.push(page.page);
        continue;
      }
      writeFileSync(join(packDir, page.page), buf);
      pageUrls[page.page] = `${relBase}/${page.page}`;
      texturePages[page.page] = {
        textureSrc: tex?.src ?? null,
        width: page.width,
        height: page.height,
      };
      if (!primarySrc) {
        primarySrc = tex?.src ?? `${relBase}/${page.page}`;
        width = page.width;
        height = page.height;
      }
      if (!pageToPackNames.has(page.page)) pageToPackNames.set(page.page, []);
      pageToPackNames.get(page.page).push({ name, animCount: animNames.length });
    }

    const defaultAnimation =
      animNames.find((n) => /idle|loop|win/i.test(n)) ||
      animNames[0] ||
      null;
    const spineVersion = skeletonJson.skeleton?.spine ?? null;
    const regionCount = [...parseAtlasRegions(atlas.atlasText).values()].reduce(
      (n, p) => n + (p.regions?.length || 0),
      0,
    );

    const slim = {
      id,
      type: 'spine',
      name,
      importUrl: rec.url,
      bundle: 'gameart',
      atlasMatch: matchHow,
      sharedAtlas: matchHow !== 'same-stem',
      atlasStem: basename(atlas.path).replace(/\.atlas$/i, ''),
      textureSrc: primarySrc,
      textureUrl: null,
      textureFileName: pages[0]?.page ?? null,
      width,
      height,
      regionCount,
      sequenceGroups: [],
      animationNames: animNames,
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
          atlasText: atlas.atlasText,
          skeletonJson,
          texturePages,
          missingAtlasPages: missingPages,
        },
        null,
        0,
      ),
    );
    manifest.push(slim);
  }

  // Link atlas page textures → best spine pack name (most animations)
  for (const [pageName, packs] of pageToPackNames) {
    const tex = textureByFileName.get(pageName);
    if (!tex) continue;
    packs.sort((a, b) => b.animCount - a.animCount);
    if (!tex.spineName) tex.spineName = packs[0].name;
  }

  manifest.sort((a, b) => {
    const ac = a.animationNames?.length || 0;
    const bc = b.animationNames?.length || 0;
    if (bc !== ac) return bc - ac;
    return String(a.name).localeCompare(String(b.name));
  });

  writeFileSync(
    join(animDir, 'manifest.json'),
    JSON.stringify({ tabId, engine: 'gameart', items: manifest }, null, 2),
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
      /\/sounds?\//i.test(rec.path);
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
      kind: 'gameartAudio',
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

/**
 * Attach PIXI spritesheet frames onto matching texture rows.
 * Sheet JSON and image often share stem (symStatic.json + symStatic.webp).
 */
function attachPixiSheetFrames(byPath, textureByFileName) {
  let sheetCount = 0;
  for (const rec of byPath.values()) {
    if (!/\.json$/i.test(rec.path) || !rec.body) continue;
    if (!/spritesheet/i.test(rec.path) && !/\/spritesheets\//i.test(rec.path)) {
      // Also accept any TexturePacker JSON next to an image
    }
    let json;
    try {
      json = JSON.parse(rec.body.toString('utf8'));
    } catch {
      continue;
    }
    const frames = parsePixiSheetFrames(json);
    if (!frames) continue;

    const metaImage = json.meta?.image;
    const stem = basename(rec.path, '.json');
    const candidates = [];
    if (metaImage) candidates.push(basename(String(metaImage)));
    for (const ext of ['.webp', '.png', '.jpg', '.jpeg', '.avif']) {
      candidates.push(stem + ext);
    }
    // Same directory listing
    const dir = dirOfPath(rec.path);
    let tex = null;
    for (const name of candidates) {
      tex = textureByFileName.get(name);
      if (tex) break;
      const companion = byPath.get(dir + name);
      if (companion) {
        tex = textureByFileName.get(fileNameFromUrl(companion.url));
        if (tex) break;
      }
    }
    if (!tex) continue;
    if (tex.frames?.length) continue; // prefer spine-atlas frames if already set
    tex.frames = frames;
    tex.atlasFrameCount = frames.length;
    tex.matchHow = 'pixi-spritesheet';
    const metaSize = json.meta?.size;
    if (metaSize) {
      tex.width = metaSize.w ?? metaSize.width ?? tex.width;
      tex.height = metaSize.h ?? metaSize.height ?? tex.height;
    }
    sheetCount += 1;
  }
  return sheetCount;
}

function attachSpineAtlasFrames(byPath, textureByFileName) {
  for (const rec of byPath.values()) {
    if (!/\.atlas$/i.test(rec.path) || !rec.body) continue;
    const atlasText = rec.body.toString('utf8');
    const byPage = parseAtlasRegions(atlasText);
    for (const [pageName, page] of byPage) {
      const tex = textureByFileName.get(pageName);
      if (!tex || tex.frames?.length) continue;
      tex.frames = page.regions.map((r) => ({
        name: r.name,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        rotated: !!r.rotate,
        origW: r.origW || undefined,
        origH: r.origH || undefined,
      }));
      tex.width = page.width || tex.width;
      tex.height = page.height || tex.height;
      tex.atlasRegions = page.regions.length;
      tex.atlasFrameCount = page.regions.length;
      tex.atlasPath = rec.path;
      tex.matchHow = 'spine-atlas';
    }
  }
}

export function buildGameartTab(harPath, outDir, src) {
  if (!existsSync(harPath)) {
    if (src.optional) {
      console.warn(`  skip optional HAR: ${harPath}`);
      return {
        id: src.id,
        label: src.label,
        meta: {
          harPath,
          missing: true,
          total: 0,
          embedded: 0,
          remote: 0,
          channel: 'mobile',
          engine: 'GameArt',
          engineFamily: 'gameart',
        },
        textures: [],
        categories: [],
        extensions: [],
        animationManifest: [],
        fontManifest: [],
        particleManifest: [],
        audioManifest: [],
      };
    }
    throw new Error(`HAR not found: ${harPath}`);
  }

  const har = JSON.parse(readFileSync(harPath, 'utf8'));
  const entries = har.log?.entries ?? [];
  const pageTitle = har.log?.pages?.[0]?.title ?? '';
  const assetsDir = join(outDir, 'embedded', src.id);
  mkdirSync(assetsDir, { recursive: true });

  /** @type {Map<string, any>} */
  const byPath = new Map();
  for (const entry of entries) {
    const url = entry.request?.url ?? '';
    if (!url || url.startsWith('data:')) continue;
    const status = entry.response?.status ?? 0;
    if (status && (status < 200 || status >= 400)) continue;
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

  const urlMap = new Map();
  let idx = 0;
  for (const rec of byPath.values()) {
    const ext = extFromUrl(rec.url);
    const isTex =
      TEXTURE_EXT.has(ext) || TEXTURE_MIME.test((rec.mime || '').toLowerCase());
    if (!isTex || !rec.body) continue;

    const fileName = fileNameFromUrl(rec.url);
    const outFile = safeFileId(rec.url, idx) + (TEXTURE_EXT.has(ext) ? ext : '.bin');
    writeFileSync(join(assetsDir, outFile), rec.body);

    urlMap.set(rec.url, {
      id: idx++,
      url: rec.url,
      path: rec.path,
      fileName,
      ext,
      mime: rec.mime || guessMimeFromExt(ext),
      size: rec.body.length,
      sizeFmt: fmtSize(rec.body.length),
      category: classifyPath(rec.path),
      src: `embedded/${src.id}/${outFile}`,
      srcType: 'embedded',
      width: null,
      height: null,
      frames: null,
      spineName: null,
      matchHow: null,
    });
  }

  const textures = [...urlMap.values()].sort((a, b) => b.size - a.size);
  const textureByFileName = new Map();
  for (const t of textures) {
    // Prefer first (largest) if duplicate fileNames across dirs — rare for GameArt
    if (!textureByFileName.has(t.fileName)) textureByFileName.set(t.fileName, t);
  }

  attachSpineAtlasFrames(byPath, textureByFileName);
  const pixiSheets = attachPixiSheetFrames(byPath, textureByFileName);

  const animationManifest = writeSpinePacks({
    outDir,
    tabId: src.id,
    byPath,
    textureByFileName,
  });

  const audioManifest = writeAudioPacks(outDir, src.id, byPath);

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
      engine: 'GameArt',
      engineFamily: 'gameart',
      total: textures.length,
      embedded: textures.filter((t) => t.srcType === 'embedded').length,
      remote: textures.filter((t) => t.srcType === 'remote').length,
      previewCount: animationManifest.length,
      fontCount: 0,
      particleCount: 0,
      audioCount: audioManifest.length,
      pixiSheetCount: pixiSheets,
      channel: textures.some((t) => /mobile/i.test(t.path)) ? 'mobile' : 'desktop',
      spineVersions,
      note: spineVersions.some((v) => /^4\./.test(String(v)))
        ? 'GameArt：Spine 4.x + PIXI spritesheet；oneAtlas 为多 skeleton 共享图集'
        : 'GameArt / HyperGaming（PIXI + Spine）',
    },
    textures,
    categories: [...new Set(textures.map((t) => t.category))].sort(),
    extensions: [...new Set(textures.map((t) => t.ext))].sort(),
    animationManifest,
    fontManifest: [],
    particleManifest: [],
    audioManifest,
  };
}
