/**
 * Extract Spine / sequence-frame preview packs from Cocos Creator HAR import JSON.
 */

import {
  extractAllSpineBlobs,
  matchTexturesToAtlasPages,
  classifySpinePackType,
  parseAtlasPages,
  normalizeSkeletonJsonForRuntime,
  mergeSupplementalAtlasPages,
} from './spine-extract.mjs';

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
  return url.match(/\/assets\/([^/]+)\//i)?.[1] ?? 'unknown';
}

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

/** Full Spine atlas parse with region rects. */
export function parseSpineAtlasRegions(raw) {
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

  const regions = {};
  const regionNames = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (
      !line ||
      line.includes(':') ||
      /\.(png|jpg|webp)$/i.test(line) ||
      /^(size|format|filter|repeat):/i.test(line)
    ) {
      i++;
      continue;
    }
    if (lines[i].startsWith(' ') || lines[i].startsWith('\t')) {
      i++;
      continue;
    }

    const name = line;
    const region = { name, rotate: false, x: 0, y: 0, width: 0, height: 0, origW: 0, origH: 0 };
    i++;
    while (i < lines.length && (lines[i].startsWith(' ') || lines[i].startsWith('\t'))) {
      const l = lines[i].trim();
      const rm = l.match(/^rotate:\s*(true|false)/i);
      const xym = l.match(/^xy:\s*(\d+)\s*,\s*(\d+)/);
      const sm2 = l.match(/^size:\s*(\d+)\s*,\s*(\d+)/);
      const om = l.match(/^orig:\s*(\d+)\s*,\s*(\d+)/);
      if (rm) region.rotate = rm[1] === 'true';
      if (xym) {
        region.x = parseInt(xym[1], 10);
        region.y = parseInt(xym[2], 10);
      }
      if (sm2) {
        region.width = parseInt(sm2[1], 10);
        region.height = parseInt(sm2[2], 10);
      }
      if (om) {
        region.origW = parseInt(om[1], 10);
        region.origH = parseInt(om[2], 10);
      }
      i++;
    }
    if (region.width > 0) {
      regions[name] = region;
      regionNames.push(name);
    }
  }

  return { pageName, width, height, regions, regionNames };
}

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
    out.push({
      prefix,
      count: frames.length,
      frames: frames.map((f) => f.name),
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

function buildAnimationTimelines(skeletonJson) {
  const timelines = {};
  const animations = skeletonJson?.animations ?? {};
  for (const [animName, anim] of Object.entries(animations)) {
    timelines[animName] = {};
    const slots = anim.slots ?? {};
    for (const [slotName, slotData] of Object.entries(slots)) {
      const attachments = slotData.attachment ?? [];
      const frames = attachments
        .filter((a) => a.name)
        .map((a) => ({ time: a.time ?? 0, region: a.name }));
      if (frames.length) timelines[animName][slotName] = frames;
    }
  }
  return timelines;
}

function parseSpineColorAlpha(colorStr) {
  const s = String(colorStr ?? '').replace('#', '');
  if (s.length >= 8) return parseInt(s.slice(6, 8), 16) / 255;
  if (s.length === 6) return 1;
  return 1;
}

function buildColorTimelines(skeletonJson) {
  const timelines = {};
  const animations = skeletonJson?.animations ?? {};
  for (const [animName, anim] of Object.entries(animations)) {
    timelines[animName] = {};
    const slots = anim.slots ?? {};
    for (const [slotName, slotData] of Object.entries(slots)) {
      const colors = slotData.color ?? [];
      const frames = colors
        .filter((c) => c.color)
        .map((c) => ({
          time: c.time ?? 0,
          alpha: parseSpineColorAlpha(c.color),
          curve: c.curve ?? null,
        }));
      if (frames.length) timelines[animName][slotName] = frames;
    }
  }
  return timelines;
}

function sampleAt(keys, time, valueKey) {
  if (!keys?.length) return null;
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  if (time < sorted[0].time) return valueKey === 'alpha' ? 0 : sorted[0][valueKey];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].time <= time) {
      const cur = sorted[i];
      const next = sorted[i + 1];
      if (valueKey === 'alpha') {
        if (!next || cur.curve === 'stepped') return cur.alpha;
        const t = (time - cur.time) / (next.time - cur.time);
        return cur.alpha + (next.alpha - cur.alpha) * t;
      }
      return cur[valueKey];
    }
  }
  return sorted[0][valueKey];
}

/** Pre-bake canvas playback frames (multi-layer alpha + attachment swaps). */
export function bakeAnimationFrames(pack, fps = 24) {
  const result = {};
  const timelines = pack.timelines ?? {};
  const colorTimelines = pack.colorTimelines ?? {};
  const regions = pack.regions ?? {};
  const baseRegion = Object.prototype.hasOwnProperty.call(regions, 'bg_base')
    ? 'bg_base'
    : null;
  const animNames =
    pack.animationNames?.length
      ? pack.animationNames
      : [...new Set([...Object.keys(timelines), ...Object.keys(colorTimelines)])];

  for (const animName of animNames) {
    const attachSlots = timelines[animName] ?? {};
    const colorSlots = colorTimelines[animName] ?? {};
    const slotNames = new Set([...Object.keys(attachSlots), ...Object.keys(colorSlots)]);
    if (!slotNames.size) continue;

    const hasColor = Object.keys(colorSlots).length > 0;
    let maxT = 0.1;
    for (const keys of Object.values(colorSlots)) {
      for (const k of keys) maxT = Math.max(maxT, k.time);
    }
    for (const keys of Object.values(attachSlots)) {
      for (const k of keys) maxT = Math.max(maxT, k.time);
    }

    const sampleTimes = [];
    if (hasColor) {
      const step = 1 / fps;
      for (let t = 0; t <= maxT + step / 2; t += step) {
        sampleTimes.push(+t.toFixed(4));
      }
    } else {
      const times = new Set([0]);
      for (const keys of Object.values(attachSlots)) {
        for (const k of keys) times.add(k.time);
      }
      sampleTimes.push(...[...times].sort((a, b) => a - b));
    }

    const baked = [];
    for (let i = 0; i < sampleTimes.length; i++) {
      const t = sampleTimes[i];
      const nextT = sampleTimes[i + 1];
      const duration =
        nextT != null ? Math.max(nextT - t, 1 / 60) : hasColor ? 1 / fps : 0.1;
      const layers = [];

      if (baseRegion) layers.push({ region: baseRegion, alpha: 1, add: 0 });

      for (const slotName of slotNames) {
        const attachKeys = attachSlots[slotName];
        const colorKeys = colorSlots[slotName];
        let region = null;
        if (attachKeys?.length) {
          region = sampleAt(attachKeys, t, 'region');
        }
        if (!region || !regions[region]) continue;
        const alpha = colorKeys
          ? sampleAt(colorKeys, t, 'alpha')
          : attachKeys
            ? 1
            : 0;
        if (alpha < 0.02) continue;
        const additive =
          slotName.includes('light') ||
          region.includes('light') ||
          slotName.includes('glow');
        layers.push({
          region,
          alpha: +Math.min(1, Math.max(0, alpha)).toFixed(3),
          add: additive ? 1 : 0,
        });
      }

      if (!layers.length) continue;
      baked.push({ duration: +duration.toFixed(4), layers });
    }

    if (baked.length) result[animName] = baked;
  }

  return result;
}

function extractSpinePacksFromText(text, sourceUrl) {
  const blobs = extractAllSpineBlobs(text, sourceUrl);
  const packs = [];
  const seen = new Set();

  for (const blob of blobs) {
    const key = `${blob.name}::${blob.atlasMeta.width}x${blob.atlasMeta.height}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const atlas = parseSpineAtlasRegions(blob.atlasRaw);
    const skeletonJson = blob.skeletonJson
      ? normalizeSkeletonJsonForRuntime(blob.skeletonJson)
      : null;
    const sequenceGroups = detectSequenceGroups(atlas.regionNames);
    const animationNames = skeletonJson ? Object.keys(skeletonJson.animations ?? {}) : [];
    const timelines = skeletonJson ? buildAnimationTimelines(skeletonJson) : {};
    const colorTimelines = skeletonJson ? buildColorTimelines(skeletonJson) : {};

    packs.push({
      id: blob.name,
      type: classifySpinePackType(skeletonJson, sequenceGroups, atlas.regionNames.length),
      name: blob.name,
      importUrl: sourceUrl,
      bundle: blob.bundle,
      texturePage: atlas.pageName,
      width: blob.atlasPages[0]?.width ?? atlas.width,
      height: blob.atlasPages[0]?.height ?? atlas.height,
      atlasText: blob.atlasText,
      atlasPages: blob.atlasPages,
      texturePages: {},
      regions: atlas.regions,
      regionCount: atlas.regionNames.length,
      sequenceGroups,
      skeletonJson,
      animationNames,
      defaultAnimation: animationNames[0] ?? null,
      timelines,
      colorTimelines,
      spineVersion: skeletonJson?.skeleton?.spine ?? null,
    });
  }

  for (const pack of packs) {
    mergeSupplementalAtlasPages(pack, blobs);
    if (pack.supplementalAtlasPages?.length) {
      const merged = parseSpineAtlasRegions(pack.atlasText);
      pack.regions = merged.regions;
      pack.regionCount = merged.regionNames.length;
      pack.sequenceGroups = detectSequenceGroups(merged.regionNames);
    }
  }

  return packs;
}

function extractSpriteAtlasPacks(text, sourceUrl) {
  if (!text.includes('"rect"') || !text.includes('"name"')) return [];

  const frameRe =
    /"name":"([^"]+)"[^}]*"rect":\{"x":(\d+),"y":(\d+),"width":(\d+),"height":(\d+)\}/g;
  const frames = [];
  let m;
  while ((m = frameRe.exec(text))) {
    frames.push({
      name: m[1],
      x: parseInt(m[2], 10),
      y: parseInt(m[3], 10),
      width: parseInt(m[4], 10),
      height: parseInt(m[5], 10),
    });
  }
  if (frames.length < 3) return [];

  const sequenceGroups = detectSequenceGroups(frames.map((f) => f.name));
  const id = `atlas-${sourceUrl.split('/').pop()?.replace(/\W/g, '_') ?? 'unknown'}`;

  return [
    {
      id,
      type: sequenceGroups.length ? 'sprite-sequence' : 'sprite-atlas',
      name: sourceUrl.split('/').slice(-2).join('/'),
      importUrl: sourceUrl,
      bundle: bundleFromUrl(sourceUrl),
      frames,
      frameCount: frames.length,
      sequenceGroups,
      animationNames: [],
      defaultAnimation: null,
      timelines: {},
    },
  ];
}

function matchTexture(pack, textures, usedUrls) {
  const pages =
    pack.atlasPages?.length > 0
      ? pack.atlasPages
      : pack.width && pack.height
        ? [{ page: pack.texturePage, width: pack.width, height: pack.height }]
        : [];

  if (pages.length) {
    const { matched, usedUrls: nextUsed } = matchTexturesToAtlasPages(
      pages,
      textures,
      usedUrls,
    );
    pack.texturePages = matched;
    const first = Object.values(matched)[0];
    if (first) {
      pack.textureSrc = first.textureSrc;
      pack.textureUrl = first.textureUrl;
      pack.textureFileName = first.textureFileName;
      return { matched: true, usedUrls: nextUsed };
    }
  }

  const page = (pack.texturePage ?? '').toLowerCase();
  const pageBase = page.replace(/\.(png|jpg|webp)$/i, '');
  const dimKey =
    pack.width && pack.height ? `${pack.width}x${pack.height}` : null;

  for (const tex of textures) {
    if (usedUrls?.has(tex.url)) continue;
    const fileLower = tex.fileName.toLowerCase();
    const pageMatch =
      page &&
      (fileLower === page ||
        fileLower.includes(pageBase) ||
        tex.path.toLowerCase().includes(pageBase));
    const dimMatch =
      dimKey && tex.width && tex.height && `${tex.width}x${tex.height}` === dimKey;
    if (pageMatch || dimMatch) {
      pack.textureSrc = tex.src;
      pack.textureUrl = tex.url;
      pack.textureFileName = tex.fileName;
      return { matched: true, usedUrls: new Set([...(usedUrls ?? []), tex.url]) };
    }
  }

  if (pack.type?.startsWith('sprite') && pack.frames?.length) {
    let maxW = 0;
    let maxH = 0;
    for (const f of pack.frames) {
      maxW = Math.max(maxW, f.x + f.width);
      maxH = Math.max(maxH, f.y + f.height);
    }
    let best = null;
    let bestScore = Infinity;
    for (const tex of textures) {
      if (!tex.width || !tex.height) continue;
      if (maxW > tex.width || maxH > tex.height) continue;
      const score = Math.abs(tex.width - maxW) + Math.abs(tex.height - maxH);
      if (score < bestScore) {
        bestScore = score;
        best = tex;
      }
    }
    if (best) {
      pack.textureSrc = best.src;
      pack.textureUrl = best.url;
      pack.textureFileName = best.fileName;
      return { matched: true, usedUrls: new Set([...(usedUrls ?? []), best.url]) };
    }
  }

  return { matched: false, usedUrls: usedUrls ?? new Set() };
}

export function extractCocosAnimationPacks(entries, textures) {
  const spinePacks = [];
  const spritePacks = [];
  const seenSpine = new Set();

  const spriteSeen = new Set();
  for (const entry of entries) {
    const url = entry.request?.url ?? '';
    if (!/\/import\//i.test(url)) continue;
    const text = bodyText(entry);
    if (!text || text.length < 80) continue;

    for (const pack of extractSpinePacksFromText(text, url)) {
      const key = `${pack.name}::${pack.width}x${pack.height}`;
      if (seenSpine.has(key)) continue;
      seenSpine.add(key);
      spinePacks.push(pack);
    }

    for (const pack of extractSpriteAtlasPacks(text, url)) {
      const sk = `${url}::${pack.frameCount}`;
      if (spriteSeen.has(sk)) continue;
      spriteSeen.add(sk);
      spritePacks.push(pack);
    }
  }

  const all = [...spinePacks, ...spritePacks];
  let usedUrls = new Set();
  for (const pack of all) {
    const result = matchTexture(pack, textures, usedUrls);
    usedUrls = result.usedUrls;
    pack.missingAtlasPages = (pack.atlasPages ?? [])
      .filter((p) => !pack.texturePages?.[p.page])
      .map((p) => ({ page: p.page, width: p.width, height: p.height }));
  }

  shareSupplementalTextures(spinePacks);

  spinePacks.sort((a, b) => b.regionCount - a.regionCount);
  return { spinePacks, spritePacks, all };
}

function shareSupplementalTextures(spinePacks) {
  const byImport = new Map();
  for (const pack of spinePacks) {
    const list = byImport.get(pack.importUrl) ?? [];
    list.push(pack);
    byImport.set(pack.importUrl, list);
  }
  for (const group of byImport.values()) {
    for (const pack of group) {
      if (!pack.supplementalAtlasPages?.length) continue;
      for (const { from, page } of pack.supplementalAtlasPages) {
        if (pack.texturePages?.[page]) continue;
        const donor = group.find((p) => p.name === from);
        const hit = donor?.texturePages?.[page];
        if (hit) pack.texturePages[page] = { ...hit };
      }
      pack.missingAtlasPages = (pack.atlasPages ?? [])
        .filter((p) => !pack.texturePages?.[p.page])
        .map((p) => ({ page: p.page, width: p.width, height: p.height }));
    }
  }
}

export function slimPackForManifest(pack) {
  return {
    id: pack.id,
    type: pack.type,
    name: pack.name,
    importUrl: pack.importUrl,
    bundle: pack.bundle,
    textureSrc: pack.textureSrc ?? null,
    textureFileName: pack.textureFileName ?? null,
    width: pack.width ?? null,
    height: pack.height ?? null,
    regionCount: pack.regionCount ?? pack.frameCount ?? 0,
    sequenceGroups: pack.sequenceGroups ?? [],
    animationNames: pack.animationNames ?? [],
    defaultAnimation: pack.defaultAnimation ?? null,
    spineVersion: pack.spineVersion ?? null,
    previewFile: `animations/${pack._tabId ?? 'tab'}/${pack.id}.json`,
  };
}
