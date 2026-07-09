#!/usr/bin/env node
/**
 * Headless check that the official spine-player 3.8 widget renders spine packs
 * in the texture viewer. Reads pixels off the player's own canvas.
 * Usage: node verify-official-player.mjs [url] [pack id/name ...]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:8765/';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });

await page.evaluate(() => {
  const btn = [...document.querySelectorAll('#tabs .tab')].find((b) =>
    /golden seth/i.test(b.textContent),
  );
  if (btn) btn.click();
});
await page.waitForTimeout(300);
await page.evaluate(async () => {
  applyViewMode('animations');
  await ensureAnimationManifest();
});

const names = process.argv.slice(3);
const targets = await page.evaluate(
  (names) => {
    let list = animationManifest.filter(
      (a) => String(a.type ?? '').startsWith('spine') && a.skelUrl,
    );
    if (names.length) list = list.filter((a) => names.includes(a.id) || names.includes(a.name));
    return list.slice(0, names.length ? list.length : 6).map((a) => ({ id: a.id, name: a.name }));
  },
  names,
);

const results = [];
for (const t of targets) {
  const r = await page.evaluate(async (id) => {
    const it = animationManifest.find((a) => a.id === id);
    await selectAnimation(it);
    await new Promise((res) => setTimeout(res, 1200));
    const canvas = document.querySelector('#anim-player canvas');
    if (!canvas) {
      return { id, player: currentAnimPack?._player ?? null, error: 'no player canvas' };
    }
    const gl = canvas.getContext('webgl') ?? canvas.getContext('webgl2');
    const w = canvas.width;
    const h = canvas.height;
    let ratio = null;
    if (gl) {
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let nonbg = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (Math.abs(px[i] - 18) > 14 || Math.abs(px[i + 1] - 21) > 14 || Math.abs(px[i + 2] - 28) > 14) nonbg++;
      }
      ratio = +(nonbg / (w * h)).toFixed(4);
    }
    return {
      id,
      name: it.name,
      player: currentAnimPack?._player ?? null,
      w,
      h,
      ratio,
      missingRegions: (currentAnimPack?._runtimeMissingRegions ?? []).length,
      missingPages: (currentAnimPack?._runtimeMissingPages ?? []).length,
    };
  }, t.id);
  results.push(r);
}

mkdirSync('dist', { recursive: true });
await page.screenshot({ path: 'dist/official-player-verify.png' });
await browser.close();

const ok = results.length > 0 && results.every((r) => r.player === 'official' && (r.ratio ?? 0) > 0.005);
console.log(JSON.stringify({ ok, results, errors: errors.slice(0, 10) }, null, 2));
process.exit(ok ? 0 : 2);
