// Verify tab-level batch bake + spine resource pack downloads.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

const OUT = join(process.cwd(), 'temp', 'bake-downloads');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });
await page.waitForSelector('.tab');
await page.evaluate(async () => {
  applyViewMode('animations');
  await ensureAnimationManifest();
  // Shrink to a 3.8 + a 3.7 pack so the batch test stays fast; the 3.7 one is
  // NOT selected, forcing the hidden bake host path.
  animationManifest = animationManifest.filter((a) => ['f_times', 'symbol_18'].includes(a.id));
  renderAnimList();
  await selectAnimation(animationManifest.find((a) => a.id === 'f_times'));
});
await page.waitForFunction(() => !document.getElementById('anim-bake-tab').disabled);

async function clickAndSave(id, saveAs) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 300000 }),
    page.click(`#${id}`),
  ]);
  await download.saveAs(join(OUT, saveAs));
  await page.waitForFunction(() => !document.getElementById('anim-bake-tab').disabled, null, { timeout: 300000 });
  console.log(`${id}: ${download.suggestedFilename()} -> ${saveAs}`);
  console.log('  progress:', (await page.textContent('#bake-text'))?.trim());
}

await clickAndSave('anim-bake-tab', 'tab_all_frames.zip');
await clickAndSave('anim-dl-one', 'f_times_spine.zip');
await clickAndSave('anim-dl-all', 'tab_spine_packs.zip');

await browser.close();
console.log('OK');
