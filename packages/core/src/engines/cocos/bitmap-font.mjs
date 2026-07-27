/**
 * Cocos Creator BitmapFont (cc.BitmapFont / fntConfig) extraction from HAR
 * import JSONs, plus conversion to the standard BMFont .fnt text format.
 */

import { decodeCocosUuid } from './cocos-uuid.mjs';

export { decodeCocosUuid };

function bodyText(entry) {
  const c = entry.response?.content;
  if (!c?.text) return null;
  if (c.encoding === 'base64') {
    try {
      return Buffer.from(c.text, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  return c.text;
}

/** Parse a Cocos serialized import JSON that contains a cc.BitmapFont. */
function parseBitmapFontImport(text) {
  if (!text?.includes('cc.BitmapFont') || !text.includes('fntConfig')) return null;
  const nameM = text.match(/\[\[0,"([^"]+)",\d+,\{/);
  if (!nameM) return null;
  const fontName = nameM[1];
  const cfgStart = text.indexOf(',{', nameM.index);
  if (cfgStart < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let cfgEnd = -1;
  for (let i = cfgStart + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) {
        cfgEnd = i;
        break;
      }
    }
  }
  if (cfgEnd < 0) return null;
  let fntConfig;
  try {
    fntConfig = JSON.parse(text.slice(cfgStart + 1, cfgEnd + 1));
  } catch {
    return null;
  }
  if (!fntConfig?.fontDefDictionary) return null;
  return { fontName, fntConfig };
}

/** Max glyph extents = minimum atlas texture size the font needs. */
export function fontAtlasExtent(fntConfig) {
  let w = 0;
  let h = 0;
  for (const d of Object.values(fntConfig.fontDefDictionary ?? {})) {
    const r = d.rect;
    if (!r) continue;
    w = Math.max(w, (r.x ?? 0) + (r.width ?? 0));
    h = Math.max(h, (r.y ?? 0) + (r.height ?? 0));
  }
  return { w, h };
}

export function glyphPreview(defs) {
  return Object.keys(defs ?? {})
    .map((k) => parseInt(k, 10))
    .filter((n) => n > 32)
    .sort((a, b) => a - b)
    .map((n) => String.fromCharCode(n))
    .join('');
}

/** Serialize a fntConfig as standard BMFont .fnt text. */
export function fntConfigToBmFont(fntConfig, fontName, atlasFile) {
  const lines = [];
  const commonHeight = fntConfig.commonHeight ?? fntConfig.fontSize ?? 32;
  const fontSize = fntConfig.fontSize ?? commonHeight;
  const defs = fntConfig.fontDefDictionary ?? {};
  const { w: atlasW, h: atlasH } = fontAtlasExtent(fntConfig);

  lines.push(
    `info face="${fontName}" size=${fontSize} bold=0 italic=0 charset="" unicode=0 stretchH=100 smooth=1 aa=1 padding=0,0,0,0 spacing=1,1`,
  );
  lines.push(
    `common lineHeight=${commonHeight} base=${Math.round(commonHeight * 0.8)} scaleW=${atlasW} scaleH=${atlasH} pages=1 packed=0`,
  );
  lines.push(`page id=0 file="${atlasFile}"`);
  lines.push('chars count=' + Object.keys(defs).length);

  for (const [codeStr, d] of Object.entries(defs)) {
    const code = parseInt(codeStr, 10);
    const ch = code === 32 ? 'space' : String.fromCharCode(code);
    const r = d.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    lines.push(
      `char id=${code} x=${r.x ?? 0} y=${r.y ?? 0} width=${r.width ?? 0} height=${r.height ?? 0} ` +
        `xoffset=${d.xOffset ?? 0} yoffset=${d.yOffset ?? 0} xadvance=${d.xAdvance ?? r.width ?? 0} ` +
        `page=0 chnl=0 letter="${ch === '"' ? '\\"' : ch}"`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Deep-walk a parsed import JSON for fntConfig objects. Works for both
 * Cocos Creator 2.x single-asset imports (`[[0,"name",N,{fntConfig}...]]`)
 * and 3.x packed bundles (`[typeIdx,"name",fontSize,{fntConfig}]` instances):
 * in both, the font name is the first string sibling in the containing array.
 */
function collectFontsFromJson(root) {
  const found = [];
  const visit = (node, parent) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, node);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.fontDefDictionary && typeof node.fontDefDictionary === 'object') {
      let fontName = null;
      if (Array.isArray(parent)) {
        fontName = parent.find((sib) => typeof sib === 'string') ?? null;
      }
      if (fontName && Object.keys(node.fontDefDictionary).length) {
        found.push({ fontName, fntConfig: node });
      }
      return;
    }
    for (const v of Object.values(node)) visit(v, node);
  };
  visit(root, null);
  return found;
}

/** Find all bitmap fonts in HAR entries (deduped by font name). */
export function extractBitmapFonts(entries) {
  const fonts = [];
  const seen = new Set();
  for (const e of entries) {
    const url = e.request?.url ?? '';
    if (!/\/import\//.test(url)) continue;
    const text = bodyText(e);
    if (!text?.includes('fontDefDictionary')) continue;

    let parsedFonts = [];
    const cc2 = parseBitmapFontImport(text);
    if (cc2) {
      parsedFonts = [cc2];
    } else {
      try {
        parsedFonts = collectFontsFromJson(JSON.parse(text));
      } catch {
        continue;
      }
    }
    for (const p of parsedFonts) {
      if (seen.has(p.fontName)) continue;
      seen.add(p.fontName);
      fonts.push({ ...p, importUrl: url });
    }
  }
  return fonts;
}

/** When an import JSON is dedicated to one font, its lone @6c48a ref is the atlas. */
function textureUuidFromImport(importUrl, importTexts) {
  if (!importUrl || !importTexts) return null;
  const text = importTexts.get(importUrl);
  if (!text) return null;
  const hits = text.match(/["']([A-Za-z0-9+/=_-]+@6c48a)["']/g);
  if (!hits || hits.length !== 1) return null;
  const raw = hits[0].slice(1, -1).split('@')[0];
  return decodeCocosUuid(raw);
}

function findTextureByUuid(textures, uuid) {
  if (!uuid) return null;
  const low = uuid.toLowerCase();
  return (
    textures.find((t) => t.srcType === 'embedded' && t.fileName?.toLowerCase().startsWith(low)) ??
    null
  );
}

/**
 * Match each font to a texture from the tab's texture list by atlas size
 * (fonts need a texture at least as large as their glyph extents, and Cocos
 * packs each bitmap font into its own atlas that closely fits the glyphs).
 *
 * Multiple fonts may reference the same atlasName (e.g. countup_04 →
 * countup_02.png); they must share one texture, not compete via usedSrcs.
 *
 * @param {Map<string,string>} [importTexts] importUrl → raw JSON text
 */
export function matchAllFontTextures(fonts, textures, importTexts) {
  const byFont = new Map();
  const claimed = new Set();

  // Group fonts that share the same atlas image.
  const groups = new Map();
  for (const font of fonts) {
    const key = String(font.fntConfig.atlasName ?? `${font.fontName}.png`).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(font);
  }

  // Match larger atlases first so small fonts don't steal big textures.
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const maxA = Math.max(...a[1].map((f) => fontAtlasExtent(f.fntConfig).w * fontAtlasExtent(f.fntConfig).h));
    const maxB = Math.max(...b[1].map((f) => fontAtlasExtent(f.fntConfig).w * fontAtlasExtent(f.fntConfig).h));
    return maxB - maxA;
  });

  for (const [, group] of sortedGroups) {
    const needW = Math.max(...group.map((f) => fontAtlasExtent(f.fntConfig).w));
    const needH = Math.max(...group.map((f) => fontAtlasExtent(f.fntConfig).h));
    let tex = null;
    for (const font of group) {
      const uuid = textureUuidFromImport(font.importUrl, importTexts);
      tex = findTextureByUuid(textures, uuid);
      if (tex) break;
    }
    if (!tex) tex = pickFontTexture(needW, needH, textures, claimed);
    if (tex) claimed.add(tex.src);
    for (const font of group) byFont.set(font.fontName, tex);
  }
  return byFont;
}

/** @deprecated use matchAllFontTextures */
export function matchFontTexture(font, textures, usedSrcs) {
  const need = fontAtlasExtent(font.fntConfig);
  return pickFontTexture(need.w, need.h, textures, usedSrcs ?? new Set());
}

function pickFontTexture(needW, needH, textures, claimed) {
  if (!needW || !needH) return null;

  let best = null;
  let bestScore = Infinity;

  for (const t of textures) {
    if (!t.width || !t.height || t.srcType !== 'embedded') continue;
    if (t.width < needW - 2 || t.height < needH - 2) continue;

    const dw = t.width - needW;
    const dh = t.height - needH;
    if (dw > 64 || dh > 64) continue;

    let score = dw + dh;
    if (dw > 24 || dh > 24) score += (Math.max(0, dw - 24) + Math.max(0, dh - 24)) * 2;
    // Bitmap font atlases are PNG/WebP with alpha; JPEG backgrounds are never fonts.
    const ext = (t.ext ?? '').toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') score += 800;
    if (claimed.has(t.src)) score += 2000;

    if (score < bestScore || (score === bestScore && best && (t.fileName ?? '') < (best.fileName ?? ''))) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}
