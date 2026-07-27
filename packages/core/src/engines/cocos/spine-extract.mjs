/**
 * Shared Spine SkeletonData extraction from Cocos Creator import JSON.
 * Supports CC2 standalone ([[0,"name",...) and bundled ([[[5,"name",...)
 * formats, plus CC3 packed instances (,"name","\r\npage.png\r\nsize: ...)
 * whose atlas text uses \r\n escapes.
 */

import { detectSequenceGroups, parseSpineAtlasText } from './parse-import.mjs';
import { decodeCocosUuid } from './cocos-uuid.mjs';

export { decodeCocosUuid };

const SPINE_BLOB_RE =
  /[\[,](\d+,)?"([^"\\]+)","(?:\\r)?\\n([^"\\]+?)(?:\\r)?\\nsize:\s*(\d+)\s*,\s*(\d+)/g;

function extractJsonObject(text, startIdx) {
  if (startIdx < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < text.length; i++) {
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
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function findAtlasEnd(text, contentStart) {
  const candidates = [];
  for (const marker of ['",["', '","{']) {
    const idx = text.indexOf(marker, contentStart + 10);
    if (idx > contentStart) candidates.push(idx);
  }
  return candidates.length ? Math.min(...candidates) : Math.min(text.length, contentStart + 20000);
}

/** Region / mesh paths referenced by skeleton skins (not paths, bbox, etc.). */
export function listSkeletonAtlasPaths(skeletonJson) {
  const paths = new Set();
  if (!skeletonJson) return paths;
  const skins = Array.isArray(skeletonJson.skins)
    ? skeletonJson.skins
    : Object.entries(skeletonJson.skins ?? {}).map(([name, data]) =>
        data?.attachments ? { name, ...data } : { name, attachments: data ?? {} },
      );
  for (const skin of skins) {
    for (const atts of Object.values(skin.attachments ?? {})) {
      for (const [name, att] of Object.entries(atts)) {
        if (!att || typeof att !== 'object') continue;
        const type = att.type ?? 'region';
        if (type !== 'region' && type !== 'mesh' && type !== 'linkedmesh') continue;
        paths.add(att.path ?? name);
      }
    }
  }
  return paths;
}

/** Split normalized atlas text into page blocks (header + regions). */
export function splitAtlasPageBlocks(atlasText) {
  const text = normalizeSpineAtlasText(String(atlasText ?? ''));
  const lines = text.split('\n');
  const blocks = [];
  let cur = null;
  let headerLeft = 0;

  const flush = () => {
    if (!cur) return;
    blocks.push({
      page: cur.page,
      text: cur.lines.join('\n'),
      regions: cur.regions,
    });
    cur = null;
    headerLeft = 0;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (!cur) {
      cur = { page: line, lines: [line], regions: [] };
      headerLeft = 4;
      continue;
    }
    cur.lines.push(line);
    if (headerLeft > 0) {
      headerLeft--;
      continue;
    }
    if (!line.includes(':')) cur.regions.push(line);
  }
  flush();
  return blocks;
}

export function listAtlasRegionNames(atlasText) {
  const names = new Set();
  for (const block of splitAtlasPageBlocks(atlasText)) {
    for (const r of block.regions) names.add(r.trim());
  }
  return names;
}

/**
 * Cocos character skeletons often reference regions from sibling Spine blobs in the
 * same import JSON (e.g. frame_00 on `frame` / `front_chaA_2` but not on `front_chaB`).
 */
export function mergeSupplementalAtlasPages(pack, donorBlobs) {
  const needed = listSkeletonAtlasPaths(pack.skeletonJson);
  const have = listAtlasRegionNames(pack.atlasText);
  const packPageNames = new Set(parseAtlasPages(pack.atlasText).map((p) => p.page));
  const appended = [];

  for (const path of needed) {
    if (have.has(path)) continue;
    for (const donor of donorBlobs) {
      if (donor.name === pack.name || donor.name === pack.id) continue;
      for (const block of splitAtlasPageBlocks(donor.atlasText)) {
        if (!block.regions.includes(path)) continue;
        if (packPageNames.has(block.page)) {
          have.add(path);
          break;
        }
        pack.atlasText = `${pack.atlasText.trim()}\n\n${block.text}`;
        pack.atlasPages = parseAtlasPages(pack.atlasText);
        packPageNames.add(block.page);
        appended.push({ from: donor.name, page: block.page });
        for (const r of block.regions) have.add(r);
        break;
      }
      if (have.has(path)) break;
    }
  }

  if (appended.length) pack.supplementalAtlasPages = appended;
  return appended.length;
}

export function parseAtlasPages(atlasText) {
  const text = String(atlasText ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
  const pages = [];
  const re = /(?:^|\n)([^\n]+\.(?:png|jpg|webp))\nsize:\s*(\d+)\s*,\s*(\d+)/gi;
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

/**
 * Parse `["uuid","uuid"]` (or compressed 22/23-char forms) starting at `[`.
 * Returns standard hyphenated UUIDs in page order.
 */
export function parseTextureUuidArray(text, bracketIdx) {
  if (bracketIdx < 0 || text[bracketIdx] !== '[') return [];
  let depth = 0;
  let end = -1;
  for (let i = bracketIdx; i < Math.min(text.length, bracketIdx + 4000); i++) {
    const c = text[i];
    if (c === '[') depth++;
    if (c === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const slice = text.slice(bracketIdx, end + 1);
  const out = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(slice))) {
    const raw = m[1].split('@')[0];
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw)) {
      out.push(raw.toLowerCase());
    } else {
      const decoded = decodeCocosUuid(raw);
      if (decoded && /^[0-9a-f]{8}-/i.test(decoded)) {
        out.push(decoded.toLowerCase());
      }
    }
  }
  return out;
}

function findTextureByUuid(textures, uuid) {
  if (!uuid) return null;
  const low = String(uuid).toLowerCase();
  const short = low.replace(/-/g, '');
  return (
    textures.find((t) => {
      const file = String(t.fileName ?? '').toLowerCase();
      const url = String(t.url ?? '').toLowerCase();
      const src = String(t.src ?? '').toLowerCase();
      return (
        file.startsWith(low) ||
        file.includes(low) ||
        url.includes(low) ||
        src.includes(low) ||
        file.replace(/-/g, '').includes(short.slice(0, 16))
      );
    }) ?? null
  );
}

/**
 * Cocos Creator exports skins as `{ "default": { slot: {...} } }`.
 * Spine 3.8 Runtime expects `[{ name, attachments }]`.
 */
export function normalizeSkeletonJsonForRuntime(json) {
  if (!json || typeof json !== 'object') return json;
  const out = { ...json };
  if (out.skins && !Array.isArray(out.skins)) {
    out.skins = Object.entries(out.skins).map(([name, data]) => {
      if (data && typeof data === 'object' && data.attachments) {
        return { name, ...data };
      }
      return { name, attachments: data ?? {} };
    });
  }
  return out;
}

/** Spine 3.7 editor/runtime JSON uses `{ default: { slot: att } }` skin map. */
export function skeletonJsonForSpine37(json) {
  if (!json || typeof json !== 'object') return json;
  if (Array.isArray(json.skins)) {
    const skins = {};
    for (const skin of json.skins) {
      const name = skin.name ?? 'default';
      skins[name] = skin.attachments ?? skin;
    }
    return { ...json, skins };
  }
  return json;
}

export function skeletonJsonForExport(json) {
  const ver = String(json?.skeleton?.spine ?? '');
  if (ver.startsWith('3.7')) return skeletonJsonForSpine37(json);
  return normalizeSkeletonJsonForRuntime(json);
}

/** Fix atlas text extracted from Cocos JSON (extra blank lines break Spine Runtime parser). */
export function normalizeSpineAtlasText(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/size:\s*(\d+)\s*,\s*(\d+)\n+\n+(format:)/gi, 'size: $1,$2\n$3')
    .replace(/^\n+/, '');
}

export function extractAllSpineBlobs(text, sourceUrl) {
  if (!text.includes('sp.SkeletonData')) return [];

  const blobs = [];
  const seen = new Set();
  SPINE_BLOB_RE.lastIndex = 0;
  let m;

  while ((m = SPINE_BLOB_RE.exec(text))) {
    const name = m[2];
    const key = `${name}::${m[4]}x${m[5]}::${sourceUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const contentStart = m.index + m[0].length;
    const atlasEnd = findAtlasEnd(text, contentStart);
    const atlasChunk = text.slice(contentStart, atlasEnd).replace(/^[\r\n]+/, '');
    // Strip CC3's \r escapes so downstream parsing sees plain \n line breaks.
    const atlasRaw = `\\n${m[3]}\\nsize: ${m[4]},${m[5]}\\n${atlasChunk}`.replace(/\\r/g, '');

    const texArrayStart = text.indexOf('",["', atlasEnd);
    const skSearchFrom = texArrayStart >= 0 ? texArrayStart : atlasEnd;
    const skIdx = text.indexOf('{"skeleton"', skSearchFrom);
    const skBlob = extractJsonObject(text, skIdx);
    let skeletonJson = null;
    if (skBlob) {
      try {
        skeletonJson = JSON.parse(skBlob);
      } catch {
        skeletonJson = null;
      }
    }

    const atlasText = normalizeSpineAtlasText(
      atlasRaw.replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
    );
    const atlasMeta = parseSpineAtlasText(atlasRaw);
    const atlasPages = parseAtlasPages(atlasText);
    // Cocos SkeletonData：atlas 后紧跟贴图 UUID 数组（与 atlas page 顺序对齐）
    const textureUuids =
      texArrayStart >= 0
        ? parseTextureUuidArray(text, texArrayStart + 2)
        : [];

    blobs.push({
      name,
      atlasRaw,
      atlasText,
      atlasMeta,
      atlasPages,
      textureUuids,
      skeletonJson,
      index: m.index,
      sourceUrl,
      bundle: sourceUrl.match(/\/assets\/([^/]+)\//i)?.[1] ?? 'unknown',
    });
  }

  return blobs;
}

/**
 * Bind atlas pages to HAR textures.
 * Prefer Cocos import UUID (page-aligned); fall back to exact WxH with
 * **largest** byte size (dense Spine atlases beat sparse UI sheets).
 *
 * @param {Array<{page:string,width:number,height:number}>} atlasPages
 * @param {object[]} textures
 * @param {Set<string>} [usedUrls]
 * @param {string[]} [textureUuids] page-aligned UUIDs from SkeletonData
 */
export function matchTexturesToAtlasPages(
  atlasPages,
  textures,
  usedUrls = new Set(),
  textureUuids = [],
) {
  const matched = {};
  const localUsed = new Set(usedUrls);

  for (let pi = 0; pi < atlasPages.length; pi++) {
    const page = atlasPages[pi];
    const uuid = textureUuids[pi] ?? null;
    const uuidHit = uuid ? findTextureByUuid(textures, uuid) : null;
    let best = uuidHit;

    if (!best) {
      const dimKey = `${page.width}x${page.height}`;
      let bestScore = -Infinity;
      let bestUsed = null;
      let bestUsedScore = -Infinity;

      for (const tex of textures) {
        if (!tex.width || !tex.height) continue;
        if (`${tex.width}x${tex.height}` !== dimKey) continue;
        // Prefer denser (larger) files — 2048² UI bg often shares size with
        // real Spine pages but is much smaller when sparsely packed.
        const score = Number(tex.size ?? 0);
        if (localUsed.has(tex.url)) {
          if (score > bestUsedScore) {
            bestUsedScore = score;
            bestUsed = tex;
          }
        } else if (score > bestScore) {
          bestScore = score;
          best = tex;
        }
      }
      if (!best && bestUsed) best = bestUsed;
    }

    if (best) {
      localUsed.add(best.url);
      matched[page.page] = {
        page: page.page,
        width: page.width,
        height: page.height,
        textureSrc: best.src,
        textureUrl: best.url,
        textureFileName: best.fileName,
        matchedBy: uuidHit ? 'uuid' : 'size',
        textureUuid: uuid ?? null,
      };
    }
  }

  return { matched, usedUrls: localUsed };
}

export function classifySpinePackType(skeletonJson, sequenceGroups, regionCount) {
  if (!sequenceGroups?.length) return 'spine';
  const boneCount = skeletonJson?.bones?.length ?? 0;
  const animCount = Object.keys(skeletonJson?.animations ?? {}).length;
  if (boneCount > 10 && animCount > 0) return 'spine';
  const seqRegions = new Set(sequenceGroups.flatMap((g) => g.frames));
  if (seqRegions.size / Math.max(regionCount, 1) > 0.85 && boneCount <= 6) {
    return 'spine-sequence';
  }
  return boneCount > 4 ? 'spine' : 'spine-sequence';
}

export function spineBlobToScanEntry(blob) {
  const regions = blob.atlasMeta.regions ?? [];
  const sequenceGroups = detectSequenceGroups(regions);
  return {
    name: blob.name,
    texturePage: blob.atlasMeta.pageName || blob.atlasPages[0]?.page || '',
    width: blob.atlasMeta.width || blob.atlasPages[0]?.width || 0,
    height: blob.atlasMeta.height || blob.atlasPages[0]?.height || 0,
    regionCount: regions.length,
    regions: regions.slice(0, 20),
    sequenceGroups,
    hasSequenceFrames:
      classifySpinePackType(blob.skeletonJson, sequenceGroups, regions.length) ===
      'spine-sequence',
    textureUuid: null,
    bundle: blob.bundle,
    sourceUrl: blob.sourceUrl,
    atlasPages: blob.atlasPages,
  };
}
