#!/usr/bin/env node
/**
 * Verify the decoupled viewer: catalog loaded at runtime, existing tabs work,
 * and an empty data dir boots to the upload empty-state.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// 1) Normal boot against the populated data dir.
await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const normal = await page.evaluate(async () => {
  const tabNames = [...document.querySelectorAll('#tabs .tab')].map((b) => b.textContent);
  applyViewMode('animations');
  await ensureAnimationManifest();
  const it = animationManifest.find((a) => a.id === 'f_times');
  if (it) {
    await selectAnimation(it);
    await new Promise((r) => setTimeout(r, 1200));
  }
  return {
    tabNames,
    gridCount: document.querySelectorAll('.grid .card').length,
    player: currentAnimPack?._player ?? null,
    subtitle: document.getElementById('subtitle').textContent,
  };
});

// 2) Empty boot: block catalog.json to simulate a fresh data dir.
const page2 = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors2 = [];
page2.on('pageerror', (e) => errors2.push(String(e)));
await page2.route('**/catalog.json', (r) => r.fulfill({ status: 404, body: 'nope' }));
await page2.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
await page2.waitForTimeout(400);
const empty = await page2.evaluate(() => ({
  tabCount: document.querySelectorAll('#tabs .tab').length,
  subtitle: document.getElementById('subtitle').textContent,
  addBtnVisible: !!document.getElementById('add-har-btn'),
}));

await browser.close();
const ok =
  normal.tabNames.length >= 2 &&
  normal.player === 'official' &&
  empty.tabCount === 0 &&
  !errors.length &&
  !errors2.length;
console.log(JSON.stringify({ ok, normal, empty, errors, errors2 }, null, 2));
process.exit(ok ? 0 : 2);
