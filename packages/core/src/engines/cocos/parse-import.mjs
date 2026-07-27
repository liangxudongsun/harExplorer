/**
 * Parse Cocos Creator import JSON from HAR for Spine / sprite atlas / sequence frames.
 */

import {
  extractAllSpineBlobs,
  spineBlobToScanEntry,
  matchTexturesToAtlasPages,
  classifySpinePackType,
} from './spine-extract.mjs';
import { decompressCocosUuid } from './cocos-uuid.mjs';

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

function bundleFromUrl(url) {
  const m3 = url.match(/\/assets\/([^/]+)\//i);
  if (m3?.[1]) return m3[1];
  if (/\/res\/(?:raw-assets|import)\//i.test(url)) return 'res';
  if (/\/raw-assets\//i.test(url)) return 'raw-assets';
  return 'unknown';
}

/** Parse Spine atlas text embedded in JSON (escaped newlines). */
export function parseSpineAtlasText(raw) {
  const text = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  const lines = text.split('\n');
  const pageLine = lines.find((l) => /\.(png|jpg|webp)$/i.test(l.trim()));
  const pageName = pageLine?.trim() ?? '';
  const sizeLine = lines.find((l) => /^size:\s*\d+/i.test(l.trim()));
  let width = 0;
  let height = 0;
  const sm = sizeLine?.match(/size:\s*(\d+)\s*,\s*(\d+)/i);
  if (sm) {
    width = parseInt(sm[1], 10);
    height = parseInt(sm[2], 10);
  }

  const regions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.includes(':') || /\.(png|jpg|webp)$/i.test(line)) continue;
    if (/^(size|format|filter|repeat|rotate|xy|orig|offset|index):/i.test(line)) continue;
    if (lines[i].startsWith(' ') || lines[i].startsWith('\t')) continue;
    regions.push(line);
  }

  return { pageName, width, height, regions };
}

/** Detect numbered sequence groups inside atlas region names. */
export function detectSequenceGroups(regionNames) {
  const groups = new Map();
  const seqRe = /^(.+?)[_ ]?(\d+)$/;

  for (const name of regionNames) {
    const m = name.match(seqRe);
    if (!m) continue;
    const prefix = m[1].replace(/_+$/, '');
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push({ name, num: parseInt(m[2], 10) });
  }

  const out = [];
  for (const [prefix, frames] of groups) {
    if (frames.length < 3) continue;
    frames.sort((a, b) => a.num - b.num);
    out.push({ prefix, count: frames.length, frames: frames.map((f) => f.name) });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

function extractSpineFromText(text, sourceUrl) {
  return extractAllSpineBlobs(text, sourceUrl).map(spineBlobToScanEntry);
}

/**
 * Parse SpriteFrames from a Cocos import JSON, grouped by Texture2D dependency.
 * Supports CC3 packed trailers and CC2 `__type__: cc.SpriteFrame` content blocks.
 * One import file often packs many atlases — must NOT merge them into one pack.
 */
function extractSpriteAtlasFrames(text) {
  if (!text.includes('"rect"') || !text.includes('"name"')) {
    // CC2 may use rect arrays without the word in object form only — still need name
    if (!/"__type__"\s*:\s*"cc\.SpriteFrame"/.test(text)) return [];
  }

  /** @type {any[]} */
  let sharedUuids = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.[1])) sharedUuids = parsed[1];
  } catch {
    sharedUuids = [];
  }

  /** @type {Map<string, any[]>} key = texIdx number or texture uuid string */
  const byTexKey = new Map();

  const pushFrame = (texKey, frame) => {
    if (texKey == null || texKey === '') return;
    const k = String(texKey);
    if (!byTexKey.has(k)) byTexKey.set(k, []);
    byTexKey.get(k).push(frame);
  };

  // --- CC3 packed: object rect + meshType trailer ---
  const startRe =
    /\{"name":"([^"]+)","rect":\{"x":(\d+),"y":(\d+),"width":(\d+),"height":(\d+)\},"offset":\{"x":(-?[\d.]+),"y":(-?[\d.]+)\},"originalSize":\{"width":(\d+),"height":(\d+)\},"rotated":(true|false)/g;

  let m;
  while ((m = startRe.exec(text))) {
    const meshAt = text.indexOf('"meshType":', m.index + m[0].length);
    if (meshAt < 0) continue;
    const afterMesh = text.indexOf('}', meshAt);
    if (afterMesh < 0) continue;
    const after = text.slice(afterMesh + 1, afterMesh + 50);
    const trailer = after.match(
      /^],\[(\d+)\],(\d+),\[([^\]]*)\],\[(\d+)\](?:,\[(\d+)\])?/,
    );
    if (!trailer) continue;
    const texIdx = Number(trailer[5] ?? trailer[4]);
    if (!Number.isFinite(texIdx)) continue;
    pushFrame(texIdx, {
      name: m[1],
      x: parseInt(m[2], 10),
      y: parseInt(m[3], 10),
      width: parseInt(m[4], 10),
      height: parseInt(m[5], 10),
      offsetX: Number(m[6]) || 0,
      offsetY: Number(m[7]) || 0,
      originalWidth: parseInt(m[8], 10),
      originalHeight: parseInt(m[9], 10),
      rotated: m[10] === 'true',
    });
  }

  // --- CC2: {"__type__":"cc.SpriteFrame","content":{...}} ---
  if (/"__type__"\s*:\s*"cc\.SpriteFrame"/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      const visit = (node) => {
        if (!node) return;
        if (Array.isArray(node)) {
          for (const c of node) visit(c);
          return;
        }
        if (typeof node !== 'object') return;
        if (node.__type__ === 'cc.SpriteFrame' && node.content) {
          const c = node.content;
          const name = String(c.name ?? '');
          if (!name) return;
          let x = 0;
          let y = 0;
          let width = 0;
          let height = 0;
          if (Array.isArray(c.rect) && c.rect.length >= 4) {
            [x, y, width, height] = c.rect.map(Number);
          } else if (c.rect && typeof c.rect === 'object') {
            x = Number(c.rect.x) || 0;
            y = Number(c.rect.y) || 0;
            width = Number(c.rect.width) || 0;
            height = Number(c.rect.height) || 0;
          }
          let offsetX = 0;
          let offsetY = 0;
          if (Array.isArray(c.offset) && c.offset.length >= 2) {
            offsetX = Number(c.offset[0]) || 0;
            offsetY = Number(c.offset[1]) || 0;
          } else if (c.offset && typeof c.offset === 'object') {
            offsetX = Number(c.offset.x) || 0;
            offsetY = Number(c.offset.y) || 0;
          }
          let originalWidth = width;
          let originalHeight = height;
          if (Array.isArray(c.originalSize) && c.originalSize.length >= 2) {
            originalWidth = Number(c.originalSize[0]) || width;
            originalHeight = Number(c.originalSize[1]) || height;
          } else if (c.originalSize && typeof c.originalSize === 'object') {
            originalWidth = Number(c.originalSize.width) || width;
            originalHeight = Number(c.originalSize.height) || height;
          }
          const rotated = c.rotated === true || c.rotated === 1 || c.rotated === '1';
          const tex =
            typeof c.texture === 'string'
              ? c.texture
              : typeof c.texture === 'number'
                ? sharedUuids[c.texture]
                : null;
          pushFrame(tex ?? `name:${name}`, {
            name,
            x,
            y,
            width,
            height,
            offsetX,
            offsetY,
            originalWidth,
            originalHeight,
            rotated: !!rotated,
          });
          return;
        }
        for (const v of Object.values(node)) visit(v);
      };
      visit(parsed);
    } catch {
      /* ignore malformed */
    }
  }

  /** @type {any[]} */
  const atlases = [];
  for (const [texKey, frames] of byTexKey) {
    if (!frames.length) continue;
    const asIdx = Number(texKey);
    const rawUuid = Number.isFinite(asIdx)
      ? sharedUuids[asIdx] != null
        ? String(sharedUuids[asIdx])
        : null
      : texKey.startsWith('name:')
        ? null
        : texKey;
    const decoded = rawUuid ? decompressCocosUuid(rawUuid) : null;
    const sequenceGroups = detectSequenceGroups(frames.map((f) => f.name));
    atlases.push({
      frameCount: frames.length,
      frames,
      sequenceGroups,
      hasSequenceFrames: sequenceGroups.length > 0,
      textureUuid: rawUuid,
      textureUuidDecoded: decoded,
      textureDepIndex: Number.isFinite(asIdx) ? asIdx : null,
    });
  }
  return atlases;
}

function extractAnimationClips(text, sourceUrl) {
  if (!text.includes('cc.AnimationClip') && !text.includes('"_spriteFrames"')) return [];

  const clips = [];
  const sfMatch = text.match(/"_spriteFrames":\[[^\]]*\]/g);
  if (sfMatch) {
    for (const block of sfMatch) {
      const count = (block.match(/@f9941/g) ?? []).length;
      if (count >= 3) {
        clips.push({ name: 'sprite-animation', frameCount: count, sourceUrl });
      }
    }
  }
  return clips;
}

function tagTextureBySpine(tex, spines) {
  const fileLower = tex.fileName.toLowerCase();
  const dimKey = tex.width && tex.height ? `${tex.width}x${tex.height}` : null;

  for (const sp of spines) {
    const page = sp.texturePage.toLowerCase();
    const pageBase = page.replace(/\.(png|jpg|webp)$/i, '');

    const pageMatch =
      fileLower === page ||
      fileLower.includes(pageBase) ||
      tex.path.toLowerCase().includes(pageBase);

    const dimMatch =
      dimKey && sp.width && sp.height && `${sp.width}x${sp.height}` === dimKey;

    if (pageMatch || dimMatch) {
      const mainSeq = sp.sequenceGroups[0];
      return {
        resourceType: sp.hasSequenceFrames ? 'spine-sequence' : 'spine',
        spineName: sp.name,
        atlasRegions: sp.regionCount,
        sequenceGroups: sp.sequenceGroups,
        sequencePrefix: mainSeq?.prefix ?? null,
        sequenceFrameCount: mainSeq?.count ?? sp.regionCount,
        bundle: sp.bundle,
      };
    }
  }
  return null;
}

function tagTextureBySpriteAtlas(tex, atlasAssignments) {
  return atlasAssignments.get(tex.url) ?? null;
}

/** Match each sprite atlas pack to at most one native texture (UUID first, tight bbox fallback). */
function assignSpriteAtlasTextures(textures, atlases, excludeUrls) {
  const assignments = new Map();
  const usedUrls = new Set(excludeUrls);

  const uuidIndex = new Map();
  for (const tex of textures) {
    for (const field of [tex.fileName, tex.path, tex.src, tex.url]) {
      const m = String(field || '').match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      if (m) uuidIndex.set(m[0].toLowerCase(), tex);
    }
  }

  // Prefer larger packs first so they claim their sheet before tiny leftovers
  const ordered = [...atlases].sort((a, b) => (b.frameCount || 0) - (a.frameCount || 0));

  for (const atlas of ordered) {
    if (!atlas.frames?.length) continue;

    let maxW = 0;
    let maxH = 0;
    for (const f of atlas.frames) {
      maxW = Math.max(maxW, f.x + f.width);
      maxH = Math.max(maxH, f.y + f.height);
    }

    /** @type {any} */
    let best = null;
    let matchHow = '';

    const decoded = atlas.textureUuidDecoded || decompressCocosUuid(atlas.textureUuid);
    if (decoded && uuidIndex.has(decoded.toLowerCase())) {
      const hit = uuidIndex.get(decoded.toLowerCase());
      if (hit && !usedUrls.has(hit.url)) {
        best = hit;
        matchHow = 'uuid';
      }
    }

    if (!best) {
      let bestScore = Infinity;
      let bestArea = Infinity;
      for (const tex of textures) {
        if (!tex.width || !tex.height || usedUrls.has(tex.url)) continue;
        if (tex.width < maxW || tex.height < maxH) continue;
        const score = Math.abs(tex.width - maxW) + Math.abs(tex.height - maxH);
        const areaRatio = (tex.width * tex.height) / Math.max(1, maxW * maxH);
        // Reject loose fits — this was attaching free_bg rects onto unrelated huge sheets
        if (score > 320) continue;
        if (areaRatio > 2.2 && score > 80) continue;
        if (score < bestScore || (score === bestScore && areaRatio < bestArea)) {
          bestScore = score;
          bestArea = areaRatio;
          best = tex;
          matchHow = `bbox:${bestScore}`;
        }
      }
    }

    if (!best) continue;

    // Skip trivial "whole texture = one frame" packs — not useful as atlas splits
    if (
      atlas.frames.length === 1 &&
      atlas.frames[0].x === 0 &&
      atlas.frames[0].y === 0 &&
      atlas.frames[0].width === best.width &&
      atlas.frames[0].height === best.height &&
      !atlas.frames[0].rotated
    ) {
      continue;
    }

    usedUrls.add(best.url);

    const mainSeq = atlas.sequenceGroups[0];
    assignments.set(best.url, {
      resourceType: atlas.hasSequenceFrames ? 'sprite-sequence' : 'sprite-atlas',
      atlasFrameCount: atlas.frameCount,
      sequenceGroups: atlas.sequenceGroups,
      sequencePrefix: mainSeq?.prefix ?? null,
      sequenceFrameCount: mainSeq?.count ?? atlas.frameCount,
      atlasBounds: `${maxW}×${maxH}`,
      frames: atlas.frames,
      textureUuid: atlas.textureUuid || null,
      textureUuidDecoded: decoded || null,
      matchHow,
    });
  }

  return assignments;
}

export function scanCocosHar(entries) {
  const spines = [];
  const spriteAtlases = [];
  const animationClips = [];
  const seenSpine = new Set();

  for (const entry of entries) {
    const url = entry.request?.url ?? '';
    if (!/\/import\/|config\.json|\.json(\?|$)/i.test(url)) continue;
    const text = bodyText(entry);
    if (!text || text.length < 80) continue;

    for (const sp of extractSpineFromText(text, url)) {
      const key = `${sp.name}::${sp.width}x${sp.height}`;
      if (seenSpine.has(key)) continue;
      seenSpine.add(key);
      spines.push(sp);
    }

    for (const atlas of extractSpriteAtlasFrames(text)) {
      spriteAtlases.push({ ...atlas, sourceUrl: url });
    }

    for (const clip of extractAnimationClips(text, url)) {
      animationClips.push(clip);
    }
  }

  spines.sort((a, b) => b.regionCount - a.regionCount);

  return {
    spines,
    spriteAtlases,
    animationClips,
    summary: {
      spineCount: spines.length,
      spineWithSequence: spines.filter((s) => s.hasSequenceFrames).length,
      spriteAtlasCount: spriteAtlases.length,
      animationClipCount: animationClips.length,
      totalSequenceGroups:
        spines.reduce((n, s) => n + s.sequenceGroups.length, 0) +
        spriteAtlases.reduce((n, a) => n + a.sequenceGroups.length, 0),
    },
  };
}

function buildSequenceSummary(scan) {
  const groups = [];
  for (const sp of scan.spines) {
    for (const g of sp.sequenceGroups) {
      groups.push({
        type: 'spine',
        asset: sp.name,
        prefix: g.prefix,
        frameCount: g.count,
        texturePage: sp.texturePage,
        atlasSize: `${sp.width}×${sp.height}`,
      });
    }
  }
  for (const atlas of scan.spriteAtlases) {
    for (const g of atlas.sequenceGroups) {
      groups.push({
        type: 'sprite-atlas',
        asset: atlas.sourceUrl?.split('/').pop() ?? 'atlas',
        prefix: g.prefix,
        frameCount: g.count,
      });
    }
  }
  groups.sort((a, b) => b.frameCount - a.frameCount);
  return groups;
}

export function tagCocosTextures(textures, scan, spinePacks = []) {
  const spineByUrl = new Map();
  for (const tex of textures) {
    const spineTag = tagTextureBySpine(tex, scan.spines);
    if (spineTag) spineByUrl.set(tex.url, spineTag);
  }

  for (const pack of spinePacks) {
    const tagBase = {
      resourceType: pack.type?.includes('sequence') ? 'spine-sequence' : 'spine',
      spineName: pack.name,
      atlasRegions: pack.regionCount,
      sequenceGroups: pack.sequenceGroups ?? [],
      sequencePrefix: pack.sequenceGroups?.[0]?.prefix ?? null,
      sequenceFrameCount:
        pack.sequenceGroups?.[0]?.count ?? pack.regionCount ?? 0,
      bundle: pack.bundle,
    };
    if (pack.textureUrl) spineByUrl.set(pack.textureUrl, tagBase);
    for (const page of Object.values(pack.texturePages ?? {})) {
      if (page.textureUrl) {
        spineByUrl.set(page.textureUrl, { ...tagBase, atlasPage: page.page });
      }
    }
  }

  const atlasAssignments = assignSpriteAtlasTextures(
    textures,
    scan.spriteAtlases,
    new Set(spineByUrl.keys()),
  );

  const tagged = textures.map((tex) => {
    const tag =
      spineByUrl.get(tex.url) ??
      tagTextureBySpriteAtlas(tex, atlasAssignments) ??
      { resourceType: 'static' };

    const category = tag.resourceType?.startsWith('spine')
      ? `spine/${tag.spineName ?? 'unknown'}`
      : tag.resourceType?.includes('sequence')
        ? `sequence/${tag.sequencePrefix ?? 'frames'}`
        : tag.resourceType === 'sprite-atlas'
          ? 'sprite-atlas'
          : tex.category;

    return { ...tex, ...tag, category };
  });

  return {
    textures: tagged,
    spineAssets: scan.spines,
    sequenceSummary: buildSequenceSummary(scan),
    meta: {
      spineCount: scan.summary.spineCount,
      spineSequenceCount: scan.summary.spineWithSequence,
      spriteAtlasCount: scan.summary.spriteAtlasCount,
      sequenceGroupCount: scan.summary.totalSequenceGroups,
    },
  };
}
