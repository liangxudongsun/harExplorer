import { chromium } from 'playwright';

const b = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const p = await b.newPage();
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e)));

await p.goto('http://127.0.0.1:8765/', { waitUntil: 'networkidle' });

// Re-upload the already-saved HAR through the page's own uploadHar(), exactly
// like the user dropping a file: fetch the saved blob → File → uploadHar.
const uploadInfo = await p.evaluate(async () => {
  const res = await fetch('/uploads/play.godeebxp.com.har');
  const blob = await res.blob();
  const file = new File([blob], 'play.godeebxp.com.har', { type: 'application/json' });
  const before = tabs.length;
  await uploadHar(file);
  const tab = activeTab;
  return {
    before,
    after: tabs.length,
    activeId: tab.id,
    animManifestLen: (tab.animationManifest ?? []).length,
    previewCount: tab.meta?.previewCount ?? null,
    spineCount: tab.meta?.spineCount ?? null,
    hint: document.getElementById('upload-hint').textContent,
  };
});

// Switch to animation view and try to render the first spine pack.
const render = await p.evaluate(async () => {
  applyViewMode('animations');
  await ensureAnimationManifest();
  const it = animationManifest.find((a) => String(a.type ?? '').startsWith('spine') && a.skelUrl);
  if (!it) return { picked: null, animCount: animationManifest.length };
  await selectAnimation(it);
  await new Promise((r) => setTimeout(r, 800));
  drawSpineFrame();
  const c = document.getElementById('anim-canvas-spine');
  const gl = c.getContext('webgl');
  const px = new Uint8Array(c.width * c.height * 4);
  gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let nonbg = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (Math.abs(px[i] - 18) > 14 || Math.abs(px[i + 1] - 20) > 14 || Math.abs(px[i + 2] - 28) > 14) nonbg++;
  }
  return { picked: it.id, animCount: animationManifest.length, ratio: +(nonbg / (c.width * c.height)).toFixed(4) };
});

await b.close();
console.log(JSON.stringify({ uploadInfo, render, errors }, null, 2));
