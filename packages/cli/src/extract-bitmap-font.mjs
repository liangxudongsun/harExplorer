#!/usr/bin/env node
/**
 * Extract Cocos Creator BitmapFont from HAR by texture UUID or font name.
 * Usage:
 *   node extract-bitmap-font.mjs <file.har> --uuid <texture-uuid>
 *   node extract-bitmap-font.mjs <file.har> --name countup_01
 *   node extract-bitmap-font.mjs <file.har> --uuid <uuid> --out temp/font-export
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

const args = process.argv.slice(2);
const harPath = args.find((a) => !a.startsWith('--'));
const uuidIdx = args.indexOf('--uuid');
const nameIdx = args.indexOf('--name');
const outIdx = args.indexOf('--out');
const targetUuid = uuidIdx >= 0 ? args[uuidIdx + 1].toLowerCase() : null;
const targetName = nameIdx >= 0 ? args[nameIdx + 1] : null;
const outRoot = outIdx >= 0 ? args[outIdx + 1] : join(process.cwd(), 'dist', 'font-export');

if (!harPath || (!targetUuid && !targetName)) {
  console.error('Usage: node extract-bitmap-font.mjs <file.har> (--uuid <tex-uuid> | --name <font-name>) [--out dir]');
  process.exit(1);
}

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

function bodyBuffer(entry) {
  const c = entry.response?.content;
  if (!c?.text) return null;
  if (c.encoding === 'base64') {
    try {
      return Buffer.from(c.text, 'base64');
    } catch {
      return null;
    }
  }
  return Buffer.from(c.text, 'utf8');
}

/** Parse Cocos serialized import JSON array format for BitmapFont. */
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

  // Texture compressed uuid refs at top: [1,["xxx@6c48a","xxx@f9941"],...]
  const texRefs = [...text.matchAll(/"([A-Za-z0-9+/=_-]{8,}@[6a-f0-9]+)"/g)].map((m) => m[1]);

  return { fontName, fntConfig, texRefs, raw: text };
}

function fntConfigToBmFont(fntConfig, fontName, atlasFile) {
  const lines = [];
  const commonHeight = fntConfig.commonHeight ?? fntConfig.fontSize ?? 32;
  const fontSize = fntConfig.fontSize ?? commonHeight;
  const defs = fntConfig.fontDefDictionary ?? {};

  let atlasW = 0;
  let atlasH = 0;
  for (const d of Object.values(defs)) {
    const r = d.rect;
    if (!r) continue;
    atlasW = Math.max(atlasW, (r.x ?? 0) + (r.width ?? 0));
    atlasH = Math.max(atlasH, (r.y ?? 0) + (r.height ?? 0));
  }

  lines.push(`info face="${fontName}" size=${fontSize} bold=0 italic=0 charset="" unicode=0 stretchH=100 smooth=1 aa=1 padding=0,0,0,0 spacing=1,1`);
  lines.push(`common lineHeight=${commonHeight} base=${Math.round(commonHeight * 0.8)} scaleW=${atlasW} scaleH=${atlasH} pages=1 packed=0`);
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

function glyphPreview(defs) {
  const chars = Object.keys(defs)
    .map((k) => parseInt(k, 10))
    .filter((n) => n > 32)
    .sort((a, b) => a - b)
    .map((n) => String.fromCharCode(n))
    .join('');
  return chars;
}

const har = JSON.parse(readFileSync(harPath, 'utf8'));
const entries = har.log?.entries ?? [];

// Build texture index: full uuid path -> entry
const texByUuid = new Map();
for (const e of entries) {
  const url = e.request?.url ?? '';
  const m = url.match(/native\/[0-9a-f]{2}\/([0-9a-f-]{36})\.(png|jpg|webp)/i);
  if (!m) continue;
  texByUuid.set(m[1].toLowerCase(), e);
}

// Find bitmap font import entries
const fonts = [];
for (const e of entries) {
  const url = e.request?.url ?? '';
  if (!/\/import\//.test(url)) continue;
  const text = bodyText(e);
  const parsed = parseBitmapFontImport(text);
  if (!parsed) continue;
  fonts.push({ ...parsed, importUrl: url });
}

console.error(`Found ${fonts.length} BitmapFont(s) in HAR`);

let picked = null;
if (targetName) {
  picked = fonts.find((f) => f.fontName === targetName);
}
if (!picked && targetUuid) {
  // Match by resolving texture: find font whose import is near same uuid prefix in bundle
  // or whose linked native texture matches targetUuid
  for (const f of fonts) {
    // Search import raw for uuid substring
    if (f.raw.toLowerCase().includes(targetUuid.replace(/-/g, '').slice(0, 8))) {
      picked = f;
      break;
    }
  }
  if (!picked) {
    // Match by atlas dimensions from fntConfig vs known texture
    const texEntry = texByUuid.get(targetUuid.toLowerCase());
    if (texEntry) {
      const buf = bodyBuffer(texEntry);
      const w = buf?.readUInt32BE?.(16);
      const h = buf?.readUInt32BE?.(20);
      for (const f of fonts) {
        let maxW = 0;
        let maxH = 0;
        for (const d of Object.values(f.fntConfig.fontDefDictionary ?? {})) {
          const r = d.rect;
          if (!r) continue;
          maxW = Math.max(maxW, (r.x ?? 0) + (r.width ?? 0));
          maxH = Math.max(maxH, (r.y ?? 0) + (r.height ?? 0));
        }
        if (w && h && Math.abs(maxW - w) < 20 && Math.abs(maxH - h) < 20) {
          picked = f;
          break;
        }
      }
    }
  }
}

if (!picked) {
  console.error('No matching BitmapFont. Available:');
  for (const f of fonts) {
    const prev = glyphPreview(f.fntConfig.fontDefDictionary ?? {});
    console.error(`  - ${f.fontName}  glyphs: ${prev || '(empty)'}`);
  }
  process.exit(1);
}

const texEntry = texByUuid.get(targetUuid?.toLowerCase()) ?? null;
let pngBuf = texEntry ? bodyBuffer(texEntry) : null;
if (!pngBuf) {
  // fallback: search any png with matching atlas name in fntConfig
  const atlasName = picked.fntConfig.atlasName ?? `${picked.fontName}.png`;
  for (const e of entries) {
    const url = e.request?.url ?? '';
    if (!url.toLowerCase().endsWith('.png')) continue;
    const buf = bodyBuffer(e);
    if (!buf) continue;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    let maxW = 0;
    let maxH = 0;
    for (const d of Object.values(picked.fntConfig.fontDefDictionary ?? {})) {
      const r = d.rect;
      if (!r) continue;
      maxW = Math.max(maxW, (r.x ?? 0) + (r.width ?? 0));
      maxH = Math.max(maxH, (r.y ?? 0) + (r.height ?? 0));
    }
    if (Math.abs(maxW - w) < 30 && Math.abs(maxH - h) < 30) {
      pngBuf = buf;
      break;
    }
  }
}

if (!pngBuf) {
  console.error('Texture PNG not found in HAR');
  process.exit(1);
}

const fontName = picked.fontName;
const dir = join(outRoot, fontName);
mkdirSync(dir, { recursive: true });

const pngName = `${fontName}.png`;
const fntName = `${fontName}.fnt`;
writeFileSync(join(dir, pngName), pngBuf);
writeFileSync(join(dir, fntName), fntConfigToBmFont(picked.fntConfig, fontName, pngName));
writeFileSync(
  join(dir, 'meta.json'),
  JSON.stringify(
    {
      name: fontName,
      fontSize: picked.fntConfig.fontSize,
      commonHeight: picked.fntConfig.commonHeight,
      atlasName: picked.fntConfig.atlasName,
      importUrl: picked.importUrl,
      textureUuid: targetUuid,
      glyphs: glyphPreview(picked.fntConfig.fontDefDictionary ?? {}),
      fontDefDictionary: picked.fntConfig.fontDefDictionary,
    },
    null,
    2,
  ),
);

console.log(
  JSON.stringify(
    {
      ok: true,
      name: fontName,
      out: dir,
      files: [pngName, fntName, 'meta.json'],
      glyphs: glyphPreview(picked.fntConfig.fontDefDictionary ?? {}),
      glyphCount: Object.keys(picked.fntConfig.fontDefDictionary ?? {}).length,
    },
    null,
    2,
  ),
);
