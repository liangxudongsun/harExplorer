/**
 * Parse Cocos Creator import JSON from HAR for Spine / sprite atlas / sequence frames.
 */

import {
  extractAllSpineBlobs,
  spineBlobToScanEntry,
  matchTexturesToAtlasPages,
  classifySpinePackType,
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
  const m = url.match(/\/assets\/([^/]+)\//i);
  return m?.[1] ?? 'unknown';
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

function extractSpriteAtlasFrames(text) {
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

  const textureUuid = text.match(/["']([A-Za-z0-9+/=_-]+@6c48a)["']/)?.[1] ?? null;
  const sequenceGroups = detectSequenceGroups(frames.map((f) => f.name));

  return [
    {
      frameCount: frames.length,
      frames,
      sequenceGroups,
      hasSequenceFrames: sequenceGroups.length > 0,
      textureUuid,
    },
  ];
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

/** Match each sprite atlas to exactly one native texture by frame bounding box. */
function assignSpriteAtlasTextures(textures, atlases, excludeUrls) {
  const assignments = new Map();
  const usedUrls = new Set(excludeUrls);

  for (const atlas of atlases) {
    if (atlas.frameCount < 3 || !atlas.frames.length) continue;

    let maxW = 0;
    let maxH = 0;
    for (const f of atlas.frames) {
      maxW = Math.max(maxW, f.x + f.width);
      maxH = Math.max(maxH, f.y + f.height);
    }

    let best = null;
    let bestScore = Infinity;
    for (const tex of textures) {
      if (!tex.width || !tex.height || usedUrls.has(tex.url)) continue;

      const fits = maxW <= tex.width && maxH <= tex.height;
      if (!fits) continue;

      const score = Math.abs(tex.width - maxW) + Math.abs(tex.height - maxH);
      if (score < bestScore) {
        bestScore = score;
        best = tex;
      }
    }

    if (!best) continue;
    usedUrls.add(best.url);

    const mainSeq = atlas.sequenceGroups[0];
    assignments.set(best.url, {
      resourceType: atlas.hasSequenceFrames ? 'sprite-sequence' : 'sprite-atlas',
      atlasFrameCount: atlas.frameCount,
      sequenceGroups: atlas.sequenceGroups,
      sequencePrefix: mainSeq?.prefix ?? null,
      sequenceFrameCount: mainSeq?.count ?? atlas.frameCount,
      atlasBounds: `${maxW}×${maxH}`,
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
