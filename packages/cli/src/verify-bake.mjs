// Verify in-browser Spine → PNG frame export (bake buttons + zip download).
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

const BASE = 'http://127.0.0.1:8765/';
const OUT = join(process.cwd(), 'temp', 'bake-downloads');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.tab');
await page.evaluate(async () => {
  applyViewMode('animations');
  await ensureAnimationManifest();
});

async function openAnim(id) {
  await page.evaluate(async (id) => {
    const it = animationManifest.find((a) => a.id === id || a.name === id);
    if (!it) throw new Error(`${id} not in manifest`);
    await selectAnimation(it);
  }, id);
  await page.waitForFunction(() => !document.getElementById('anim-bake-one').disabled, null, { timeout: 30000 });
}

async function bake(buttonId, saveAs) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }),
    page.click(`#${buttonId}`),
  ]);
  await download.saveAs(join(OUT, saveAs));
  console.log(`saved: ${saveAs} (suggested: ${download.suggestedFilename()})`);
}

// 1) Spine 3.8 pack — single animation export.
await openAnim('f_times');
await bake('anim-bake-one', 'f_times_one.zip');
console.log('progress:', (await page.textContent('#bake-text'))?.trim());

// 2) Spine 3.7 pack — full export via the 3.7 iframe runtime.
await openAnim('symbol_18');
console.log('symbol_18 status:', (await page.textContent('#anim-status'))?.trim());
await bake('anim-bake-all', 'symbol_18_all.zip');
console.log('progress:', (await page.textContent('#bake-text'))?.trim());

await browser.close();
console.log('OK');
