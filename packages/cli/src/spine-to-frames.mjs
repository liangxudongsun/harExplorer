#!/usr/bin/env node
/**
 * Bake a Spine export into transparent PNG sequence frames.
 *
 * Input: a directory containing a skeleton .json, a .atlas and its page
 * images — exactly what the viewer/CLI export produces
 * (e.g. dist/texture-viewer/animations/<tab>/<id>/ or spine-export bare dirs).
 *
 * The skeleton's Spine version picks the runtime (3.7 or 3.8), frames are
 * rendered deterministically off-screen (Playwright + SwiftShader WebGL) and
 * written as <out>/<animation>/frame_0000.png ... plus a meta.json.
 *
 * Usage:
 *   node spine-to-frames.mjs <packDir> [--out dir] [--fps 30] [--scale 1]
 *                            [--anim name[,name...]] [--max-size 2048]
 *                            [--pipeline standard|high-res|max-canvas|crop-canvas|direct-alpha|supersample-2x|nearest|precise-alpha]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(__dirname, '..', '..', 'web', 'viewer', 'vendor');

const args = process.argv.slice(2);
const packDir = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const FPS = parseFloat(opt('fps', '30'));
const SCALE = parseFloat(opt('scale', '1'));
const maxSizeIdx = args.indexOf('--max-size');
const MAX_SIZE = maxSizeIdx >= 0 ? parseInt(args[maxSizeIdx + 1], 10) : undefined;
const PIPELINE = opt('pipeline', 'standard');
const ANIMS = opt('anim', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!packDir || !existsSync(packDir)) {
  console.error('Usage: node spine-to-frames.mjs <packDir> [--out dir] [--fps 30] [--scale 1] [--anim a,b]');
  process.exit(1);
}

// --- locate skeleton / atlas / pages in the pack dir ---
const files = readdirSync(packDir);
const atlasFile = files.find((f) => f.endsWith('.atlas'));
const jsonFile =
  files.find((f) => {
    if (!f.endsWith('.json') || f === 'meta.json') return false;
    try {
      const j = JSON.parse(readFileSync(join(packDir, f), 'utf8'));
      return !!j.skeleton && !!j.bones;
    } catch {
      return false;
    }
  }) ?? null;
if (!atlasFile || !jsonFile) {
  console.error(`No skeleton .json / .atlas pair found in ${packDir}`);
  process.exit(1);
}

const skeletonJson = JSON.parse(readFileSync(join(packDir, jsonFile), 'utf8'));
const atlasText = readFileSync(join(packDir, atlasFile), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/size:\s*(\d+)\s*,\s*(\d+)\n+\n+(format:)/gi, 'size: $1,$2\n$3');

const version = String(skeletonJson.skeleton?.spine ?? '3.8');
const is37 = version.startsWith('3.7');
const runtimeFile = is37 ? 'spine-webgl-3.7.js' : 'spine-player-3.8.js';

// Page images referenced by the atlas → data URIs.
const pageImages = {};
for (const line of atlasText.split('\n')) {
  const name = line.trim();
  if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) continue;
  const p = join(packDir, name);
  if (!existsSync(p)) {
    console.warn(`  ! atlas page missing on disk: ${name} (transparent placeholder)`);
    continue;
  }
  const ext = name.split('.').pop().toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  pageImages[name] = `data:${mime};base64,${readFileSync(p).toString('base64')}`;
}

const OUT = resolve(opt('out', join(packDir, 'frames')));
mkdirSync(OUT, { recursive: true });

console.log(`Pack: ${packDir}`);
console.log(`Spine ${version} → runtime ${is37 ? '3.7' : '3.8'} · fps ${FPS} · scale ${SCALE} · pipeline ${PIPELINE}${MAX_SIZE != null ? ` · maxSize ${MAX_SIZE}` : ''}`);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e));
await page.setContent('<canvas id="c"></canvas>');
await page.addScriptTag({ path: join(VENDOR, runtimeFile) });
// Shared baker (same file the web viewer uses) — keeps CLI and web output identical.
await page.addScriptTag({ path: join(VENDOR, '..', 'spine-bake.js') });

const result = await page.evaluate(
  async ({ skeletonJson, atlasText, pageImages, fps, scale, maxSize, pipeline, is37, anims }) => {
    // -- skeleton JSON shape per runtime generation --
    function skinsAsArray(json) {
      if (!json.skins || Array.isArray(json.skins)) return json;
      return {
        ...json,
        skins: Object.entries(json.skins).map(([name, data]) =>
          data?.attachments ? { name, ...data } : { name, attachments: data ?? {} },
        ),
      };
    }
    function skinsAsMap(json) {
      if (!json.skins || !Array.isArray(json.skins)) return json;
      const skins = {};
      for (const s of json.skins) skins[s.name ?? 'default'] = s.attachments ?? s;
      return { ...json, skins };
    }
    const skelData = is37 ? skinsAsMap(skeletonJson) : skinsAsArray(skeletonJson);

    const loadImage = (src) =>
      new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
      });
    const images = {};
    for (const [name, uri] of Object.entries(pageImages)) images[name] = await loadImage(uri);

    // Shared baker (spine-bake.js) does bounds sampling, deterministic
    // stepping and dual-background compositing for additive/multiply slots.
    const result = await window.spineBakeFrames(
      { skeletonJson: skelData, atlasText, images, fps, scale, maxSize, pipeline, animations: anims },
      null,
    );

    // Blobs can't cross page.evaluate — hand back data URLs instead.
    const blobToDataUrl = (blob) =>
      new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
    for (const a of result.animations) {
      a.frames = await Promise.all((a.frames ?? []).map(blobToDataUrl));
    }
    return result;
  },
  { skeletonJson, atlasText, pageImages, fps: FPS, scale: SCALE, maxSize: MAX_SIZE, pipeline: PIPELINE, is37, anims: ANIMS },
);

await browser.close();

const meta = { pack: basename(resolve(packDir)), spineVersion: version, fps: FPS, pipeline: result.pipeline ?? { id: PIPELINE }, animations: [] };
for (const anim of result.animations) {
  if (anim.error) {
    console.warn(`  ! ${anim.name}: ${anim.error}`);
    continue;
  }
  const dir = join(OUT, anim.name.replace(/[^\w.-]+/g, '_'));
  mkdirSync(dir, { recursive: true });
  anim.frames.forEach((uri, i) => {
    writeFileSync(join(dir, `frame_${String(i).padStart(4, '0')}.png`), Buffer.from(uri.split(',')[1], 'base64'));
  });
  const { frames, ...info } = anim;
  meta.animations.push({ ...info, dir: basename(dir) });
  console.log(`  ${anim.name}: ${anim.frameCount} 帧 · ${anim.width}x${anim.height} · ${anim.duration}s`);
}
if (result.missingRegions.length) {
  meta.missingRegions = result.missingRegions;
  console.warn(`  ! 缺 ${result.missingRegions.length} 个 region（对应部件不会出现在帧里）`);
}
writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
console.log(`Done → ${OUT}`);
