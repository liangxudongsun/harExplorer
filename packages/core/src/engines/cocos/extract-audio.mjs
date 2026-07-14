/**
 * Extract Cocos AudioClip assets from HAR entries:
 * import JSON (cc.AudioClip) + native .mp3/.ogg/.wav/.m4a buffers.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac']);
const AUDIO_MIME = /^audio\//i;

function decodeBody(content) {
  if (!content?.text) return null;
  try {
    if (content.encoding === 'base64') return Buffer.from(content.text, 'base64');
    return Buffer.from(content.text, 'utf8');
  } catch {
    return null;
  }
}

function uuidFromUrl(url) {
  const m = String(url).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return m ? m[1].toLowerCase() : null;
}

function safeId(name) {
  return String(name || 'audio')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
}

function fmtSize(size) {
  if (!size || size < 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('?')[0];
    const m = p.match(/\.([a-z0-9]+)$/i);
    return m ? `.${m[1].toLowerCase()}` : '';
  } catch {
    const m = String(url).split('?')[0].match(/\.([a-z0-9]+)$/i);
    return m ? `.${m[1].toLowerCase()}` : '';
  }
}

/**
 * Parse compact Creator import JSON for a single cc.AudioClip.
 * Sample:
 * [1,0,0,[["cc.AudioClip",["_name","_native","_duration"],0]],[[0,0,1,2,4]],
 *  [[0,"btm_w_major_vocal",".mp3",4.179592],-1],0,0,[],[],[]]
 */
function parseAudioClipImport(json, url) {
  if (!Array.isArray(json) || json.length < 6) return null;
  const classes = Array.isArray(json[3]) ? json[3] : [];
  const classIdx = classes.findIndex(
    (c) => Array.isArray(c) && c[0] === 'cc.AudioClip',
  );
  if (classIdx < 0) return null;
  const keys = Array.isArray(classes[classIdx][1]) ? classes[classIdx][1] : [];
  const dataRoot = json[5];

  let found = null;
  const walk = (node) => {
    if (found || !Array.isArray(node)) return;
    if (typeof node[0] === 'number' && node[0] === classIdx) {
      const params = {};
      for (let i = 0; i < keys.length && i + 1 < node.length; i += 1) {
        const key = keys[i].startsWith('_') ? keys[i].slice(1) : keys[i];
        params[key] = node[i + 1];
      }
      found = {
        name: typeof params.name === 'string' ? params.name : null,
        nativeExt:
          typeof params.native === 'string' ? params.native : null,
        duration:
          typeof params.duration === 'number' ? params.duration : null,
        importUrl: url,
        uuid: uuidFromUrl(url),
      };
      return;
    }
    for (const child of node) {
      if (Array.isArray(child)) walk(child);
    }
  };
  walk(dataRoot);
  return found;
}

/**
 * Scan HAR entries and write audio/<tabId>/<id>/ + manifest.
 * @returns {Array<object>} slim manifest items for catalog/viewer
 */
export function writeAudioPacks(outDir, tabId, entries) {
  const root = join(outDir, 'audio', tabId);
  mkdirSync(root, { recursive: true });

  /** @type {Map<string, {url:string, buf:Buffer, mime:string, size:number, ext:string}>} */
  const byUuid = new Map();
  /** @type {Array<object>} */
  const clipMeta = [];

  for (const e of entries) {
    const url = e.request?.url || '';
    const content = e.response?.content;
    const buf = decodeBody(content);
    if (!buf) continue;
    const uuid = uuidFromUrl(url);
    const mime = content?.mimeType || '';
    const ext = extFromUrl(url);

    if (
      uuid &&
      (/\/native\//.test(url) || AUDIO_MIME.test(mime) || AUDIO_EXT.has(ext))
    ) {
      const isAudio =
        AUDIO_MIME.test(mime) ||
        AUDIO_EXT.has(ext) ||
        (/\.mp3(\?|$)/i.test(url) && buf.length > 64);
      if (isAudio) {
        byUuid.set(uuid, {
          url,
          buf,
          mime: mime || 'application/octet-stream',
          size: buf.length,
          ext: AUDIO_EXT.has(ext) ? ext : '.mp3',
        });
      }
    }

    if (
      (/\/import\/.+\.json(\?|$)/i.test(url) ||
        /[0-9a-f]{8}-[0-9a-f-]{27}\.json/i.test(url)) &&
      buf.toString('utf8', 0, Math.min(buf.length, 200)).includes('AudioClip')
    ) {
      try {
        const text = buf.toString('utf8');
        if (!text.includes('cc.AudioClip')) continue;
        const json = JSON.parse(text);
        const meta = parseAudioClipImport(json, url);
        if (meta) clipMeta.push(meta);
      } catch {
        /* ignore */
      }
    }
  }

  const manifest = [];
  const seen = new Set();
  const usedUuids = new Set();

  for (const clip of clipMeta) {
    const native = clip.uuid ? byUuid.get(clip.uuid) : null;
    const name = clip.name || clip.uuid || 'audio';
    let id = safeId(name);
    if (seen.has(id)) id = safeId(`${name}_${(clip.uuid || '').slice(0, 8)}`);
    if (seen.has(id)) continue;
    seen.add(id);
    if (clip.uuid) usedUuids.add(clip.uuid);

    const ext =
      (clip.nativeExt && AUDIO_EXT.has(clip.nativeExt)
        ? clip.nativeExt
        : null) ||
      native?.ext ||
      '.mp3';
    const fileName = `${id}${ext}`;
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    if (native?.buf) writeFileSync(join(dir, fileName), native.buf);

    const relBase = `audio/${tabId}/${id}`;
    const item = {
      id,
      kind: 'audioClip',
      name,
      uuid: clip.uuid,
      duration: clip.duration,
      ext,
      mime: native?.mime || guessMime(ext),
      size: native?.size ?? 0,
      sizeFmt: fmtSize(native?.size ?? 0),
      url: native?.url || null,
      importUrl: clip.importUrl,
      audioUrl: native?.buf ? `${relBase}/${fileName}` : null,
    };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(item, null, 2));
    if (item.audioUrl) manifest.push(item);
  }

  // Orphan native audio without matching AudioClip import
  for (const [uuid, native] of byUuid) {
    if (usedUuids.has(uuid)) continue;
    const id = safeId(uuid.slice(0, 8));
    if (seen.has(id)) continue;
    seen.add(id);
    const fileName = `${id}${native.ext}`;
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), native.buf);
    const relBase = `audio/${tabId}/${id}`;
    const item = {
      id,
      kind: 'audioNative',
      name: basename(native.url.split('?')[0]) || id,
      uuid,
      duration: null,
      ext: native.ext,
      mime: native.mime,
      size: native.size,
      sizeFmt: fmtSize(native.size),
      url: native.url,
      importUrl: null,
      audioUrl: `${relBase}/${fileName}`,
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

function guessMime(ext) {
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
