/**
 * CDN 资源本地缓存：按「去 query 的 host+pathname」落盘。
 * 对抗 ?sign= 过期；与对方 Workbox 去掉 search 的 cache key 策略对齐。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { dirname, join } from 'path';

/**
 * @param {string} url
 * @returns {{ host: string, pathname: string } | null}
 */
export function parseAssetUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/i.test(u.protocol)) return null;
    return { host: u.hostname.toLowerCase(), pathname: u.pathname };
  } catch {
    return null;
  }
}

/**
 * 稳定缓存相对路径：host/a/b/c.png（不含 sign）
 * @param {string} url
 */
export function stableCacheRel(url) {
  const p = parseAssetUrl(url);
  if (!p) return null;
  const segs = p.pathname.split('/').filter(Boolean).map((s) =>
    s.replace(/[<>:"|?*\\]/g, '_')
  );
  if (!segs.length) return null;
  return [p.host, ...segs].join('/');
}

/**
 * @param {string} cacheRoot
 * @param {string} url
 */
export function cacheAbsPath(cacheRoot, url) {
  const rel = stableCacheRel(url);
  if (!rel) return null;
  return join(cacheRoot, ...rel.split('/'));
}

/**
 * @param {string} cacheRoot
 * @param {string} url
 * @returns {Buffer | null}
 */
export function readCdnCache(cacheRoot, url) {
  const abs = cacheAbsPath(cacheRoot, url);
  if (!abs || !existsSync(abs)) return null;
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size <= 0) return null;
    return readFileSync(abs);
  } catch {
    return null;
  }
}

/**
 * @param {string} cacheRoot
 * @param {string} url
 * @param {Buffer} buf
 * @returns {string | null} 写入的绝对路径
 */
export function writeCdnCache(cacheRoot, url, buf) {
  if (!buf?.length) return null;
  const abs = cacheAbsPath(cacheRoot, url);
  if (!abs) return null;
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
    return abs;
  } catch {
    return null;
  }
}

/**
 * 从带 sign 的 URL 拉取并写入缓存（签名未过期时调用）。
 * @param {string} cacheRoot
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, buf: Buffer, path: string } | { ok: false, error: string }>}
 */
export async function fetchIntoCdnCache(cacheRoot, url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20000;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { Accept: 'image/*,*/*' },
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const mime = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32) {
      return { ok: false, error: `body too small (${buf.length})` };
    }
    const isImg =
      mime.startsWith('image/') ||
      (buf[0] === 0x89 && buf[1] === 0x50) ||
      (buf[0] === 0xff && buf[1] === 0xd8) ||
      buf.toString('ascii', 0, 4) === 'RIFF';
    if (!isImg) {
      return { ok: false, error: `not image mime=${mime}` };
    }
    const path = writeCdnCache(cacheRoot, url, buf);
    if (!path) return { ok: false, error: 'write cache failed' };
    return { ok: true, buf, path };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 对 tab.textures 中仍为 remote 且 URL 带 sign 的项尝试拉取并改为 embedded。
 * @param {object} tab
 * @param {string} outDir viewer 根目录
 * @param {string} tabId
 * @param {{ concurrency?: number, timeoutMs?: number }} [opts]
 */
export async function hydrateTabFromSignedUrls(tab, outDir, tabId, opts = {}) {
  const cacheRoot = join(outDir, 'cdn-cache');
  const assetsDir = join(outDir, 'embedded', tabId);
  mkdirSync(assetsDir, { recursive: true });
  const concurrency = opts.concurrency ?? 6;
  const textures = tab.textures ?? [];
  const pending = textures.filter(
    (t) =>
      t.srcType === 'remote' &&
      typeof t.url === 'string' &&
      /[?&]sign=/i.test(t.url)
  );

  let fetched = 0;
  let failed = 0;
  let i = 0;

  async function worker() {
    while (i < pending.length) {
      const idx = i++;
      const t = pending[idx];
      const result = await fetchIntoCdnCache(cacheRoot, t.url, {
        timeoutMs: opts.timeoutMs,
      });
      if (!result.ok) {
        failed += 1;
        continue;
      }
      const ext = t.ext && t.ext.startsWith('.') ? t.ext : '.png';
      const outFile = `${String(t.id).padStart(3, '0')}_cdn${ext}`;
      const rel = `embedded/${tabId}/${outFile}`;
      try {
        writeFileSync(join(assetsDir, outFile), result.buf);
        t.src = rel;
        t.srcType = 'embedded';
        t.size = result.buf.length;
        t.sizeFmt = undefined;
        fetched += 1;
      } catch {
        failed += 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, () =>
      worker()
    )
  );

  if (tab.meta) {
    tab.meta.embedded = textures.filter((t) => t.srcType === 'embedded').length;
    tab.meta.remote = textures.filter((t) => t.srcType === 'remote').length;
    tab.meta.cdnHydrated = fetched;
    tab.meta.cdnHydrateFailed = failed;
  }
  return { fetched, failed, pending: pending.length };
}
