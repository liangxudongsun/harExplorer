/**
 * Content-based game-engine detection for a HAR's entries.
 * Returns one of: 'cocos' | 'pragmatic' | 'slotmill'.
 *
 * Detection is heuristic and scored: every entry contributes hits to the
 * engines it matches (by URL, then by a light body sniff for a few scripts).
 * The highest score wins; 'slotmill' is the generic texture-dump fallback.
 *
 * When engine is 'cocos', also returns cocosMajor: 2 | 3 | null.
 */

import { detectCocosMajor } from './engines/cocos/detect-cocos-major.mjs';

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

export function detectEngine(entries, pageTitle = '') {
  const score = { cocos: 0, pragmatic: 0, slotmill: 0 };
  const title = String(pageTitle ?? '').toLowerCase();

  if (/pragmatic/.test(title)) score.pragmatic += 5;
  if (/slotmill/.test(title)) score.slotmill += 5;
  if (/cocos|creator/.test(title)) score.cocos += 5;

  let bodySniffs = 0;
  for (const entry of entries) {
    const url = String(entry.request?.url ?? '').toLowerCase();
    if (!url) continue;

    // --- host / URL signals (cheap) ---
    if (/pragmaticplay|\.pragmatic/.test(url)) score.pragmatic += 5;
    if (/slotmill/.test(url)) score.slotmill += 5;

    if (/\/import\/[0-9a-f]{2}\//.test(url)) score.cocos += 3;
    if (/\/assets\/[^/]+\/native\//.test(url)) score.cocos += 3;
    // Creator 2.x web 构建常见布局
    if (/\/res\/raw-assets\//.test(url)) score.cocos += 4;
    if (/\/res\/import\//.test(url)) score.cocos += 3;
    if (/cocos2d-js|cocos2d-jsb/.test(url)) score.cocos += 4;
    if (/cocos|creator|\bccc\b/.test(url)) score.cocos += 2;
    if (/\/spine\//.test(url)) score.cocos += 1;

    if (/game_resources|main_resources|\/uht|\/gui\//.test(url)) score.pragmatic += 2;
    if (/\/desktop\/|\/mobile\//.test(url)) score.pragmatic += 1;

    // --- body sniff (bounded: only a handful of scripts / small json) ---
    const mime = mimeOf(entry);
    const isScript = /javascript|ecmascript/.test(mime) || /\.js(\?|$)/.test(url);
    const isJson = /json/.test(mime) || /\.json(\?|$)/.test(url);
    if (bodySniffs < 40 && (isScript || isJson)) {
      const text = bodyText(entry);
      if (text) {
        bodySniffs++;
        const head = text.slice(0, 20000);
        if (
          /cc\._RF\.push|window\.CCClass|cc\.Class|"__type__"|cc\.game|cocos2d|cc\.AssetLibrary/.test(
            head
          )
        ) {
          score.cocos += 3;
        }
        if (/UHTEventBroker|PIXI\.|pragmatic|gameService/.test(head)) {
          score.pragmatic += 3;
        }
        if (/slotmill/i.test(head)) score.slotmill += 3;
      }
    }
  }

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [engine, top] = ranked[0];
  // No meaningful signal → generic dump builder.
  if (top === 0) {
    return {
      engine: 'slotmill',
      score,
      confident: false,
      cocosMajor: null,
      cocosMajorDetail: null,
    };
  }

  let cocosMajor = null;
  let cocosMajorDetail = null;
  if (engine === 'cocos') {
    cocosMajorDetail = detectCocosMajor(entries);
    cocosMajor = cocosMajorDetail.major;
  }

  return {
    engine,
    score,
    confident: top >= 5,
    cocosMajor,
    cocosMajorDetail,
  };
}
