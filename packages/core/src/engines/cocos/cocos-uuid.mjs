/**
 * Cocos compressUuid 解码：兼容 22 位（常见）与 23 位变体。
 * 去掉 `@f9941` 等类型后缀后再解。
 */

const BASE64_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = (() => {
  /** @type {Record<string, number>} */
  const map = {};
  for (let i = 0; i < 64; i++) map[BASE64_KEYS[i]] = i;
  return map;
})();

function dashUuid(hex32) {
  if (!hex32 || hex32.length !== 32) return null;
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-${hex32.slice(16, 20)}-${hex32.slice(20)}`;
}

/** 23-char Cocos compressUuid（parse-import 历史实现） */
function decompress23(s) {
  if (s.length !== 23) return null;
  let hex = s.slice(0, 5);
  for (let i = 5; i < 23; i += 2) {
    const hi = BASE64_VALUES[s[i]];
    const lo = BASE64_VALUES[s[i + 1]];
    if (hi == null || lo == null) return null;
    const value = (hi << 6) | lo;
    hex += ((value >> 8) & 0xf).toString(16);
    hex += ((value >> 4) & 0xf).toString(16);
    hex += (value & 0xf).toString(16);
  }
  return dashUuid(hex);
}

/** 22-char Cocos compressUuid（Spine / BMFont 历史实现） */
function decompress22(s) {
  if (s.length !== 22) return null;
  const hex = [s[0], s[1]];
  for (let i = 2, j = 2; i < 22; i += 2) {
    const l = BASE64_VALUES[s[i]];
    const r = BASE64_VALUES[s[i + 1]];
    if (l == null || r == null) return null;
    hex[j++] = (l >> 2).toString(16);
    hex[j++] = (((l & 3) << 2) | (r >> 4)).toString(16);
    hex[j++] = (r & 0xf).toString(16);
  }
  return dashUuid(hex.join(''));
}

/**
 * @param {string} compressed
 * @returns {string|null} 标准带连字符 UUID；已是标准 UUID 则原样（小写）返回
 */
export function decompressCocosUuid(compressed) {
  const raw = String(compressed || '').trim();
  if (!raw) return null;
  const s = raw.replace(/@.*$/, '').replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(s)) {
    return dashUuid(s.toLowerCase());
  }
  return decompress23(s) ?? decompress22(s);
}

/** 兼容旧名：解不了时回退原串（去掉 @后缀） */
export function decodeCocosUuid(base64) {
  const raw = String(base64 || '').split('@')[0];
  return decompressCocosUuid(raw) ?? raw;
}
