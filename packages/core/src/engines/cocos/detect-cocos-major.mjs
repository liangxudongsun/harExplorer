/**
 * 在已判定为 Cocos 家族后，细分 Creator 主版本：2 | 3 | null。
 * 依据 URL 布局与脚本指纹打分，不依赖完整反序列化。
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
 * @param {any[]} entries
 * @returns {{ major: 2 | 3 | null, score2: number, score3: number, signals: string[] }}
 */
export function detectCocosMajor(entries = []) {
  let score2 = 0;
  let score3 = 0;
  /** @type {string[]} */
  const signals = [];
  let bodySniffs = 0;

  for (const entry of entries) {
    const url = String(entry.request?.url ?? '');
    const low = url.toLowerCase();
    if (!low) continue;

    if (/\/res\/raw-assets\//.test(low)) {
      score2 += 4;
      signals.push('url:res/raw-assets');
    }
    if (/\/res\/import\//.test(low)) {
      score2 += 3;
      signals.push('url:res/import');
    }
    if (/cocos2d-js|cocos2d-jsb|cocos2d\.js/.test(low)) {
      score2 += 5;
      signals.push('url:cocos2d-js');
    }
    if (/\/assets\/[^/]+\/native\//.test(low)) {
      score3 += 4;
      signals.push('url:assets/*/native');
    }
    if (/\/assets\/[^/]+\/import\//.test(low)) {
      score3 += 3;
      signals.push('url:assets/*/import');
    }
    if (/\/application\.js(\?|$)/.test(low) && /\/assets\//.test(low)) {
      score3 += 1;
    }

    const mime = mimeOf(entry);
    const isScript = /javascript|ecmascript/.test(mime) || /\.js(\?|$)/.test(low);
    const isJson = /json/.test(mime) || /\.json(\?|$)/.test(low);
    if (bodySniffs >= 50 || (!isScript && !isJson)) continue;

    const text = bodyText(entry);
    if (!text) continue;
    bodySniffs += 1;
    const head = text.slice(0, 40000);

    if (/cc\.AssetLibrary|CCDebugger|\brawAssets\b/.test(head)) {
      score2 += 4;
      signals.push('body:AssetLibrary/rawAssets');
    }
    if (/\b2\.4\.\d+\b/.test(head) || /Cocos Creator v?2\./i.test(head)) {
      score2 += 5;
      signals.push('body:version-2.x');
    }
    if (/assetManager|cc\.AssetManager|builtinAssets/.test(head)) {
      score3 += 4;
      signals.push('body:assetManager');
    }
    if (/\b3\.[0-9]+\.[0-9]+\b/.test(head) && /cocos|creator/i.test(head)) {
      score3 += 3;
      signals.push('body:version-3.x');
    }
    // 3.x settings 常见 projectBundles / server
    if (/"projectBundles"|"bundleVers"|"server"\s*:/.test(head) && /settings/.test(low)) {
      score3 += 2;
    }
  }

  const uniq = [...new Set(signals)].slice(0, 12);
  if (score2 === 0 && score3 === 0) {
    return { major: null, score2, score3, signals: uniq };
  }
  if (score2 > score3) return { major: 2, score2, score3, signals: uniq };
  if (score3 > score2) return { major: 3, score2, score3, signals: uniq };
  // 平局：有 raw-assets 优先 2，否则 3
  const prefer2 = uniq.some((s) => s.includes('raw-assets') || s.includes('cocos2d'));
  return { major: prefer2 ? 2 : 3, score2, score3, signals: uniq };
}
