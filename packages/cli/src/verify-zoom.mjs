#!/usr/bin/env node
/**
 * Capture element screenshots of the anim player at fit / 1:1 / 2x zoom for
 * visual verification (WebGL readPixels is unreliable without
 * preserveDrawingBuffer, so we screenshot the composited page instead).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:8765/';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  applyViewMode('animations');
  await ensureAnimationManifest();
});

mkdirSync('dist/zoom-shots', { recursive: true });

async function setZoom(mode) {
  await page.evaluate((mode) => {
    const sel = document.getElementById('anim-zoom');
    sel.value = mode;
    sel.dispatchEvent(new Event('change'));
  }, mode);
  await page.waitForTimeout(500);
}

async function shoot(packId, modes) {
  await page.evaluate(async (packId) => {
    await selectAnimation(animationManifest.find((a) => a.id === packId));
    await new Promise((r) => setTimeout(r, 1200));
  }, packId);
  const wrap = await page.$('#anim-canvas-wrap');
  for (const mode of modes) {
    await setZoom(mode);
    await wrap.screenshot({
      path: `dist/zoom-shots/${packId}_${mode.replace(':', '')}.png`,
    });
  }
}

await shoot('f_times', ['fit', '1', '0.5']);   // official 3.8 player
await setZoom('fit');
await shoot('symbol_18', ['fit', '1', '2']);   // 3.7 iframe player

await browser.close();
console.log(JSON.stringify({ ok: true, dir: 'dist/zoom-shots', errors: errors.slice(0, 5) }, null, 2));
