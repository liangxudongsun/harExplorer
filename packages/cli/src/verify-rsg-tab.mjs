#!/usr/bin/env node
/** Verify the gameweb3 (PowerOfThor2) tab renders spine packs in the viewer. */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:8765/';
const ids = process.argv.slice(3);
if (!ids.length) ids.push('Thor', 'legendwin', 'symbolB1', 'win_board');

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  const btn = [...document.querySelectorAll('#tabs .tab')].find((b) =>
    /gameweb3|thor/i.test(b.textContent),
  );
  if (!btn) throw new Error('gameweb3 tab not found');
  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  applyViewMode('animations');
  await ensureAnimationManifest();
});

mkdirSync('dist/rsg-shots', { recursive: true });
const results = [];
for (const id of ids) {
  const meta = await page.evaluate(async (id) => {
    const it = animationManifest.find((a) => a.id === id);
    if (!it) return { id, error: 'not in manifest' };
    await selectAnimation(it);
    await new Promise((r) => setTimeout(r, 1500));
    return {
      id,
      player: currentAnimPack?._player ?? null,
      spineVersion: currentAnimPack?.spineVersion ?? null,
      missingPages: (currentAnimPack?._runtimeMissingPages ?? []).length,
      missingRegions: (currentAnimPack?._runtimeMissingRegions ?? []).length,
      status: document.getElementById('anim-status')?.textContent ?? '',
    };
  }, id);
  const wrap = await page.$('#anim-canvas-wrap');
  await wrap.screenshot({ path: `dist/rsg-shots/${id}.png` });
  results.push(meta);
}

await browser.close();
console.log(JSON.stringify({ results, errors: errors.slice(0, 5) }, null, 2));
