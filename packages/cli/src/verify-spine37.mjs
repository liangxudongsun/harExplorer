#!/usr/bin/env node
/**
 * Headless check that Spine 3.7 packs route to the dedicated 3.7 iframe player
 * and actually render. Usage: node verify-spine37.mjs [url] [pack id ...]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:8765/';
const ids = process.argv.slice(3);
if (!ids.length) ids.push('symbol_17', 'symbol_18');

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
await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('#tabs .tab')].find((b) =>
    /golden seth/i.test(b.textContent),
  );
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 300));
  applyViewMode('animations');
  await ensureAnimationManifest();
});

const results = [];
for (const id of ids) {
  const meta = await page.evaluate(async (id) => {
    const it = animationManifest.find((a) => a.id === id || a.name === id);
    if (!it) return { id, error: 'pack not found' };
    await selectAnimation(it);
    await new Promise((r) => setTimeout(r, 1000));
    return {
      id,
      player: currentAnimPack?._player ?? null,
      spineVersion: currentAnimPack?.spineVersion ?? null,
      status: document.getElementById('anim-status')?.textContent ?? '',
      missingRegions: (currentAnimPack?._runtimeMissingRegions ?? []).length,
    };
  }, id);

  // Read pixels inside the iframe's own WebGL canvas.
  const frame = page.frames().find((f) => f.url().includes('spine37-player.html'));
  let ratio = null;
  if (frame) {
    ratio = await frame.evaluate(() => {
      const c = document.getElementById('canvas');
      const gl = c.getContext('webgl');
      const w = c.width;
      const h = c.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let nonbg = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (Math.abs(px[i] - 18) > 14 || Math.abs(px[i + 1] - 20) > 14 || Math.abs(px[i + 2] - 28) > 14) nonbg++;
      }
      return +(nonbg / (w * h)).toFixed(4);
    });
  }
  results.push({ ...meta, ratio });
}

mkdirSync('dist', { recursive: true });
await page.screenshot({ path: 'dist/spine37-verify.png' });
await browser.close();

const ok = results.length > 0 && results.every((r) => r.player === 'spine37' && (r.ratio ?? 0) > 0.005);
console.log(JSON.stringify({ ok, results, errors: errors.slice(0, 10) }, null, 2));
process.exit(ok ? 0 : 2);
