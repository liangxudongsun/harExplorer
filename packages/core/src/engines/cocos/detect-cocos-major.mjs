/**
 * 在已判定为 Cocos 家族后，细分 Creator 主版本：2 | 3 | null。
 *
 * 优先级（高→低）：
 * 1. import JSON 序列化字段（最可靠：2.x Node 有 _trs/_contentSize；3.x 有 _lpos/UITransform）
 * 2. 脚本里的 ENGINE_VERSION / Creator 版本字符串
 * 3. URL 布局（仅参考：部分 CDN 可能把 2.x 资源放进 assets/.../import|native）
 */

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

function mimeOf(entry) {
  return (entry.response?.content?.mimeType ?? '').toLowerCase();
}

/**
 * 从单段 import/文本里统计 2.x / 3.x 序列化指纹。
 * @returns {{ s2: number, s3: number, tags: string[] }}
 */
function scoreImportText(text) {
  let s2 = 0;
  let s3 = 0;
  /** @type {string[]} */
  const tags = [];
  if (!text || text.length < 20) return { s2, s3, tags };

  // --- Creator 2.x Node / 组件字段 ---
  if (/_trs/.test(text)) {
    s2 += 6;
    tags.push('import:_trs');
  }
  if (/cc\.Node/.test(text) && /_contentSize/.test(text)) {
    s2 += 5;
    tags.push('import:Node._contentSize');
  }
  if (/cc\.Node/.test(text) && /_opacity/.test(text)) {
    s2 += 3;
    tags.push('import:Node._opacity');
  }
  if (/"__type__"\s*:\s*"cc\./.test(text)) {
    s2 += 2;
    tags.push('import:__type__');
  }

  // --- Creator 3.x ---
  if (/_lpos|_lrot|_lscale/.test(text)) {
    s3 += 6;
    tags.push('import:_lpos');
  }
  if (/cc\.UITransform|UITransform/.test(text)) {
    s3 += 5;
    tags.push('import:UITransform');
  }
  if (/cc\.UIOpacity|UIOpacity/.test(text)) {
    s3 += 3;
    tags.push('import:UIOpacity');
  }

  return { s2, s3, tags };
}

/**
 * @param {any[]} entries
 * @returns {{ major: 2 | 3 | null, score2: number, score3: number, signals: string[] }}
 */
export function detectCocosMajor(entries = []) {
  let score2 = 0;
  let score3 = 0;
  /** @type {string[]} */
  const signals = [];
  let bodySniffs = 0;
  let importScanned = 0;
  const maxImports = 40;
  /** URL 弱信号每种只计一次，避免 assets/* 数量淹没序列化指纹 */
  const urlHit = new Set();

  for (const entry of entries) {
    const url = String(entry.request?.url ?? '');
    const low = url.toLowerCase();
    if (!low) continue;

    // --- URL（弱信号：CDN 可能伪装；每种只加一次）---
    if (/\/res\/raw-assets\//.test(low) && !urlHit.has('raw-assets')) {
      urlHit.add('raw-assets');
      score2 += 3;
      signals.push('url:res/raw-assets');
    }
    if (/\/res\/import\//.test(low) && !urlHit.has('res-import')) {
      urlHit.add('res-import');
      score2 += 2;
      signals.push('url:res/import');
    }
    if (/cocos2d-js|cocos2d-jsb|cocos2d\.js/.test(low) && !urlHit.has('cocos2d')) {
      urlHit.add('cocos2d');
      score2 += 5;
      signals.push('url:cocos2d-js');
    }
    // assets/*/native|import 不再强判 3.x（PG Soft 2.4 也会用这套路径）
    if (/\/assets\/[^/]+\/native\//.test(low) && !urlHit.has('assets-native')) {
      urlHit.add('assets-native');
      score3 += 1;
      signals.push('url:assets/*/native');
    }
    if (/\/assets\/[^/]+\/import\//.test(low) && !urlHit.has('assets-import')) {
      urlHit.add('assets-import');
      score3 += 1;
      signals.push('url:assets/*/import');
    }

    const mime = mimeOf(entry);
    const isScript = /javascript|ecmascript/.test(mime) || /\.js(\?|$)/.test(low);
    const isJson = /json/.test(mime) || /\.json(\?|$)/.test(low);
    const isImportJson = /\/import\/.+\.json/i.test(low);

    // --- import JSON：强信号 ---
    if (isImportJson && importScanned < maxImports) {
      const text = bodyText(entry);
      if (text && text.length >= 20) {
        importScanned += 1;
        const { s2, s3, tags } = scoreImportText(text.slice(0, 120000));
        if (s2 || s3) {
          score2 += s2;
          score3 += s3;
          for (const t of tags) signals.push(t);
        }
      }
      continue;
    }

    if (bodySniffs >= 50 || (!isScript && !isJson)) continue;

    const text = bodyText(entry);
    if (!text) continue;
    bodySniffs += 1;
    const head = text.slice(0, 40000);

    if (/cc\.ENGINE_VERSION\s*=\s*["']2\./i.test(head) || /ENGINE_VERSION["'\s:=]+2\.\d/i.test(head)) {
      score2 += 12;
      signals.push('body:ENGINE_VERSION-2');
    }
    if (/cc\.ENGINE_VERSION\s*=\s*["']3\./i.test(head) || /ENGINE_VERSION["'\s:=]+3\.\d/i.test(head)) {
      score3 += 12;
      signals.push('body:ENGINE_VERSION-3');
    }
    if (/cc\.AssetLibrary|CCDebugger|\brawAssets\b/.test(head)) {
      score2 += 4;
      signals.push('body:AssetLibrary/rawAssets');
    }
    if (/\b2\.4\.\d+\b/.test(head) || /Cocos Creator v?2\./i.test(head)) {
      score2 += 5;
      signals.push('body:version-2.x');
    }
    if (/assetManager|cc\.AssetManager|builtinAssets/.test(head)) {
      score3 += 3;
      signals.push('body:assetManager');
    }
    if (/\b3\.[0-9]+\.[0-9]+\b/.test(head) && /cocos|creator/i.test(head)) {
      score3 += 3;
      signals.push('body:version-3.x');
    }
    if (/"projectBundles"|"bundleVers"/.test(head) && /settings/.test(low)) {
      score3 += 2;
    }
  }

  const uniq = [...new Set(signals)].slice(0, 20);
  if (score2 === 0 && score3 === 0) {
    return { major: null, score2, score3, signals: uniq };
  }

  const strong2 = uniq.some(
    (s) =>
      s === 'import:_trs' ||
      s.startsWith('import:Node.') ||
      s.includes('ENGINE_VERSION-2') ||
      s.includes('version-2')
  );
  const strong3 = uniq.some(
    (s) =>
      s === 'import:_lpos' ||
      s === 'import:UITransform' ||
      s.includes('ENGINE_VERSION-3') ||
      s.includes('version-3')
  );
  // 序列化指纹优先于 URL 弱信号累计
  if (strong2 && !strong3) {
    return { major: 2, score2, score3, signals: uniq };
  }
  if (strong3 && !strong2) {
    return { major: 3, score2, score3, signals: uniq };
  }

  if (score2 > score3) return { major: 2, score2, score3, signals: uniq };
  if (score3 > score2) return { major: 3, score2, score3, signals: uniq };
  const prefer2 = uniq.some(
    (s) =>
      s.includes('raw-assets') ||
      s.includes('cocos2d') ||
      s.startsWith('import:')
  );
  return { major: prefer2 ? 2 : 3, score2, score3, signals: uniq };
}
