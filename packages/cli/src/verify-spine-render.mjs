#!/usr/bin/env node
/** Headless render check for the texture-viewer spine player. */
import { chromium } from 'playwright';

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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle' });

// Switch to the Golden Seth (cocos) tab, which has spine animations.
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
    return list.slice(0, names.length ? list.length : 5).map((a) => ({ id: a.id, name: a.name }));
  },
  names,
);

const results = [];
for (const t of targets) {
  const r = await page.evaluate(async (id) => {
    const it = animationManifest.find((a) => a.id === id);
    await selectAnimation(it);
    await new Promise((res) => setTimeout(res, 700));
    drawSpineFrame();
    const c = document.getElementById('anim-canvas-spine');
    const gl = c.getContext('webgl');
    const w = c.width;
    const h = c.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let nonbg = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - 18) > 14 || Math.abs(px[i + 1] - 20) > 14 || Math.abs(px[i + 2] - 28) > 14) nonbg++;
    }
    const sk = spineInstance?.skeleton;
    let slotsWithAtt = 0;
    if (sk) for (const s of sk.slots) if (s.getAttachment && s.getAttachment()) slotsWithAtt++;
    return {
      id,
      w,
      h,
      ratio: +(nonbg / (w * h)).toFixed(4),
      bounds: spineInstance ? { cx: spineInstance.cx, cy: spineInstance.cy, skW: spineInstance.skW, skH: spineInstance.skH } : null,
      slots: sk?.slots?.length ?? 0,
      slotsWithAtt,
      missingRegions: (currentAnimPack?._runtimeMissingRegions ?? []).length,
      missingPages: (currentAnimPack?._runtimeMissingPages ?? []).length,
    };
  }, t.id);
  results.push(r);
}

await page.screenshot({ path: 'temp/spine-verify.png' });
await browser.close();

const ok = results.some((r) => r.ratio > 0.01);
console.log(JSON.stringify({ ok, results, errors }, null, 2));
process.exit(ok ? 0 : 2);
