/**
 * Extract Cocos ParticleSystem2D assets from HAR entries:
 * particle .plist + native textures + Prefab/import custom params.
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { decompressCocosUuid } from './cocos-uuid.mjs';

const PARTICLE_PLIST_KEYS = [
  'emissionRate',
  'particleLifespan',
  'maxParticles',
  'spriteFrameUuid',
  'gravityx',
  'startParticleSize',
];

function isParticlePlistText(text) {
  if (!text || typeof text !== 'string') return false;
  if (!text.includes('<plist') && !text.includes('emissionRate')) return false;
  return PARTICLE_PLIST_KEYS.some((k) => text.includes(k));
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

function parsePlistParams(xml) {
  const params = {};
  const re =
    /<key>([^<]+)<\/key>\s*<(integer|real|string|true|false)(?:\s*\/>|>([^<]*)<\/\2>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const key = m[1];
    const typ = m[2];
    if (typ === 'true') params[key] = true;
    else if (typ === 'false') params[key] = false;
    else if (typ === 'integer') params[key] = parseInt(m[3], 10);
    else if (typ === 'real') params[key] = parseFloat(m[3]);
    else params[key] = m[3];
  }
  const normalized = {
    duration: params.duration,
    emissionRate: params.emissionRate,
    life: params.particleLifespan,
    lifeVar: params.particleLifespanVariance,
    totalParticles: params.maxParticles,
    startSize: params.startParticleSize,
    startSizeVar: params.startParticleSizeVariance,
    endSize: params.finishParticleSize,
    endSizeVar: params.finishParticleSizeVariance,
    startSpin: params.rotationStart,
    startSpinVar: params.rotationStartVariance,
    endSpin: params.rotationEnd,
    endSpinVar: params.rotationEndVariance,
    angle: params.angle,
    angleVar: params.angleVariance,
    speed: params.speed,
    speedVar: params.speedVariance,
    posVar: {
      x: params.sourcePositionVariancex,
      y: params.sourcePositionVariancey,
    },
    sourcePos: {
      x: params.sourcePositionx,
      y: params.sourcePositiony,
    },
    gravity: { x: params.gravityx, y: params.gravityy },
    tangentialAccel: params.tangentialAcceleration,
    tangentialAccelVar: params.tangentialAccelVariance,
    radialAccel: params.radialAcceleration,
    radialAccelVar: params.radialAccelVariance,
    emitterMode: params.emitterType,
    positionType: params.positionType,
    startColor: {
      r: Math.round((params.startColorRed ?? 0) * 255),
      g: Math.round((params.startColorGreen ?? 0) * 255),
      b: Math.round((params.startColorBlue ?? 0) * 255),
      a: Math.round((params.startColorAlpha ?? 1) * 255),
    },
    endColor: {
      r: Math.round((params.finishColorRed ?? 0) * 255),
      g: Math.round((params.finishColorGreen ?? 0) * 255),
      b: Math.round((params.finishColorBlue ?? 0) * 255),
      a: Math.round((params.finishColorAlpha ?? 1) * 255),
    },
    spriteFrameUuid: params.spriteFrameUuid,
    blendFuncSource: params.blendFuncSource,
    blendFuncDestination: params.blendFuncDestination,
    rotationIsDir: params.rotationIsDir,
  };
  return { raw: params, normalized };
}

function colorFromUint(n) {
  const u = n >>> 0;
  return {
    a: (u >>> 24) & 0xff,
    b: (u >>> 16) & 0xff,
    g: (u >>> 8) & 0xff,
    r: u & 0xff,
  };
}

function extractParticleFromImport(json, url) {
  const results = [];
  if (!Array.isArray(json) || json.length < 5) return results;

  const sharedUuids = Array.isArray(json[1]) ? json[1] : [];
  const classes = Array.isArray(json[3]) ? json[3] : [];
  const dataRoot = json[5];

  const particleClassIdx = classes.findIndex(
    (c) => Array.isArray(c) && c[0] === 'cc.ParticleSystem2D',
  );
  if (particleClassIdx < 0) return results;

  const classDef = classes[particleClassIdx];
  const keys = Array.isArray(classDef[1]) ? classDef[1] : [];

  const walk = (node, nodeNameHint) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && node[0] === particleClassIdx) {
      const values = node.slice(1);
      const params = {};
      for (let i = 0; i < keys.length && i < values.length; i += 1) {
        const key = keys[i];
        let val = values[i];
        if (
          key === '_startColor' ||
          key === '_endColor' ||
          key === 'startColor' ||
          key === 'endColor'
        ) {
          if (Array.isArray(val) && typeof val[1] === 'number') {
            val = colorFromUint(val[1]);
          }
        } else if (
          (key === 'posVar' || key === 'gravity' || key === 'sourcePos') &&
          Array.isArray(val) &&
          val.length >= 3
        ) {
          val = { x: val[1], y: val[2] };
        } else if (
          key === '_file' ||
          key === '_spriteFrame' ||
          key === 'file' ||
          key === 'spriteFrame'
        ) {
          if (typeof val === 'number' && sharedUuids[val]) {
            val = { ref: sharedUuids[val], index: val };
          } else if (Array.isArray(val) && typeof val[1] === 'string') {
            val = { ref: val[1] };
          }
        } else if (key === 'node' || key === '__prefab') {
          continue;
        }
        const outKey = key.startsWith('_') ? key.slice(1) : key;
        params[outKey] = val;
      }
      if (
        params.file?.ref &&
        params.spriteFrame?.ref &&
        String(params.file.ref).includes('@f9941') &&
        !String(params.spriteFrame.ref).includes('@')
      ) {
        const tmp = params.file;
        params.file = params.spriteFrame;
        params.spriteFrame = tmp;
      }
      results.push({
        source: 'prefab',
        url,
        nodeName: nodeNameHint || null,
        params,
        sharedUuids,
      });
      return;
    }

    let nameHint = nodeNameHint;
    if (typeof node[1] === 'string' && node[1].length < 80) {
      nameHint = node[1];
    }
    for (const child of node) {
      if (Array.isArray(child)) walk(child, nameHint);
    }
  };

  walk(dataRoot, null);

  const assetClassIdx = classes.findIndex(
    (c) => Array.isArray(c) && c[0] === 'cc.ParticleAsset',
  );

  const findAssetNames = (node, out = []) => {
    if (!Array.isArray(node)) return out;
    if (
      node.length >= 3 &&
      (node[0] === 6 || node[0] === assetClassIdx) &&
      typeof node[1] === 'string' &&
      (node[2] === '.plist' || typeof node[2] === 'string')
    ) {
      out.push(node[1]);
    }
    for (const c of node) {
      if (Array.isArray(c)) findAssetNames(c, out);
    }
    return out;
  };
  const assetNames = [...new Set(findAssetNames(dataRoot))];
  for (const r of results) {
    if (assetNames.length) r.particleAssetName = assetNames[0];
  }

  const seen = new Set();
  return results.filter((r) => {
    const k = `${r.url}::${r.nodeName || ''}::${JSON.stringify(r.params)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function uuidFromUrl(url) {
  const s = String(url);
  const dashed = s.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (dashed) return dashed[1].toLowerCase();
  const hex32 = s.match(/\/([0-9a-f]{32})(?:\.[a-z0-9]+)?(?:\?|$)/i);
  if (hex32) {
    const h = hex32[1].toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const compressed = s.match(
    /\/([A-Za-z0-9+/_-]{22,23})(?:\.[a-z0-9]+)?(?:\?|$)/,
  );
  if (compressed) {
    const decoded = decompressCocosUuid(compressed[1]);
    if (decoded) return decoded.toLowerCase();
  }
  return null;
}

function isNativeAssetUrl(url) {
  return (
    /\/native\//.test(url) ||
    /\/raw-assets\//.test(url) ||
    /\/res\/raw-assets\//.test(url)
  );
}

function basenameFromUrl(url) {
  try {
    return basename(new URL(url).pathname);
  } catch {
    return basename(String(url).split('?')[0]);
  }
}

function safeId(name) {
  return String(name || 'particle')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
}

/**
 * Scan HAR entries and write particles/<tabId>/<id>/ + manifest.
 * @returns {Array<object>} slim manifest items for catalog/viewer
 */
export function writeParticlePacks(outDir, tabId, entries) {
  const root = join(outDir, 'particles', tabId);
  mkdirSync(root, { recursive: true });

  /** @type {Map<string, {url:string, buf:Buffer, mime?:string}>} */
  const byUuidNative = new Map();
  const particlePlists = [];
  const prefabParticles = [];
  const configParticlePaths = [];

  for (const e of entries) {
    const url = e.request?.url || '';
    const buf = decodeBody(e.response?.content);
    if (!buf) continue;
    const uuid = uuidFromUrl(url);
    const mime = e.response?.content?.mimeType || '';

    if (uuid && isNativeAssetUrl(url)) {
      byUuidNative.set(uuid, { url, buf, mime });
    }

    if (/\/config\.json(\?|$)/.test(url)) {
      try {
        const cfg = JSON.parse(buf.toString('utf8'));
        const paths = cfg.paths || {};
        const uuids = cfg.uuids || [];
        for (const [k, v] of Object.entries(paths)) {
          const p = Array.isArray(v) ? v[0] : v;
          if (!/particle/i.test(String(p))) continue;
          configParticlePaths.push({
            path: String(p),
            uuid: uuids[Number(k)] ?? uuids[k] ?? null,
            index: Number(k),
          });
        }
      } catch {
        /* ignore */
      }
    }

    if (/\.plist(\?|$)/i.test(url)) {
      const text = buf.toString('utf8');
      if (!isParticlePlistText(text)) continue;
      const name = basenameFromUrl(url);
      particlePlists.push({
        url,
        uuid,
        name,
        buf,
        params: parsePlistParams(text).normalized,
      });
    }

    if (/\/import\/.+\.json(\?|$)/i.test(url) || /0e[0-9a-f]+\.json/i.test(url)) {
      try {
        const text = buf.toString('utf8');
        if (!text.includes('ParticleSystem2D') && !text.includes('ParticleAsset')) {
          continue;
        }
        const json = JSON.parse(text);
        const found = extractParticleFromImport(json, url);
        if (!found.length) continue;
        for (const f of found) {
          prefabParticles.push({ ...f, buf, fileName: basenameFromUrl(url) });
        }
      } catch {
        /* ignore */
      }
    }
  }

  const ensureTexture = (sfUuid, dir) => {
    if (!sfUuid) return null;
    const base = String(sfUuid).split('@')[0].toLowerCase();
    const hit = byUuidNative.get(base);
    if (!hit) return null;
    let ext = '.png';
    try {
      ext = extname(new URL(hit.url).pathname) || '.png';
    } catch {
      /* keep .png */
    }
    const fileName = `texture${ext}`;
    const file = join(dir, fileName);
    if (!existsSync(file)) writeFileSync(file, hit.buf);
    return fileName;
  };

  const manifest = [];
  const seen = new Set();

  for (const p of particlePlists) {
    const cfgHit = configParticlePaths.find((c) => {
      if (!p.uuid || !c.uuid) return false;
      return String(c.uuid).toLowerCase().startsWith(p.uuid.slice(0, 2));
    });
    const name = cfgHit?.path?.split('/').pop() || basename(p.name, '.plist');
    const id = safeId(name);
    if (seen.has(id)) continue;
    seen.add(id);

    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.plist`), p.buf);
    const textureFile = ensureTexture(p.params.spriteFrameUuid, dir);
    const relBase = `particles/${tabId}/${id}`;
    const item = {
      id,
      kind: 'particleAsset',
      name,
      assetPath: cfgHit?.path || null,
      uuid: p.uuid,
      url: p.url,
      plistUrl: `${relBase}/${id}.plist`,
      textureUrl: textureFile ? `${relBase}/${textureFile}` : null,
      params: p.params,
      paramSource: 'plist',
    };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(item, null, 2));
    manifest.push(item);
  }

  // Prefab components: attach as separate items when they have resolvable textures
  // or usable custom params (even without plist).
  let prefabIdx = 0;
  const prefabSeen = new Set();
  for (const pref of prefabParticles) {
    const dk = `${pref.url}::${pref.nodeName}`;
    if (prefabSeen.has(dk)) continue;
    prefabSeen.add(dk);

    const sfRef =
      pref.params?.spriteFrame?.ref ||
      pref.params?.spriteFrameUuid ||
      null;
    const name =
      pref.nodeName || pref.particleAssetName || `Particle_${++prefabIdx}`;
    let id = safeId(name);
    if (seen.has(id)) id = safeId(`${name}_${prefabIdx}`);
    if (seen.has(id)) continue;
    seen.add(id);

    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.prefab.json`), pref.buf);

    // Match plist by particle asset name when available
    const matchedPlist = particlePlists.find((p) => {
      if (!pref.particleAssetName) return false;
      return basename(p.name, '.plist') === pref.particleAssetName;
    });
    let plistUrl = null;
    if (matchedPlist) {
      const matchedId = safeId(
        matchedPlist.name.replace(/\.plist$/i, '') || matchedPlist.name,
      );
      const existing = manifest.find((m) => m.id === matchedId || m.name === pref.particleAssetName);
      if (existing) {
        // Prefer linking to existing particleAsset entry instead of duplicating
        continue;
      }
      writeFileSync(join(dir, `${id}.plist`), matchedPlist.buf);
      plistUrl = `particles/${tabId}/${id}/${id}.plist`;
    }

    const textureFile = ensureTexture(
      sfRef || matchedPlist?.params?.spriteFrameUuid,
      dir,
    );
    const relBase = `particles/${tabId}/${id}`;
    const item = {
      id,
      kind: 'particleComponent',
      name,
      particleAssetName: pref.particleAssetName || null,
      url: pref.url,
      prefabUrl: `${relBase}/${id}.prefab.json`,
      plistUrl,
      textureUrl: textureFile ? `${relBase}/${textureFile}` : null,
      params: pref.params,
      paramSource: 'prefab',
      note:
        pref.params?.custom === true
          ? 'custom=true：以 prefab 参数为准'
          : undefined,
    };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(item, null, 2));
    // Only list if we can at least apply params or have a texture/plist
    if (item.plistUrl || item.textureUrl || item.params) {
      manifest.push(item);
    }
  }

  writeFileSync(
    join(root, 'manifest.json'),
    JSON.stringify({ tabId, items: manifest }, null, 2),
  );
  return manifest;
}
