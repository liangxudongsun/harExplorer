/**
 * Detect packed atlas frames when Cocos SpriteFrame metadata is missing.
 *
 * Strategies:
 * 1) alpha-cc — high-alpha seeds → connected components (transparent sheets)
 * 2) luma-cc  — bright-vs-near-black seeds (opaque packs on black / dark plate)
 */

import fs from "node:fs";
import path from "node:path";

/**
 * @param {Uint8Array|Buffer} rgba
 * @param {number} width
 * @param {number} height
 * @param {{
 *   maskMode?: "alpha" | "luma",
 *   seedThreshold?: number,
 *   fringeThreshold?: number,
 *   expand?: number,
 *   minSize?: number,
 *   minArea?: number,
 *   maxFrameAreaRatio?: number,
 *   maxFrames?: number,
 * }} [opts]
 */
export function detectFramesFromRgba(rgba, width, height, opts = {}) {
  const maskMode = opts.maskMode === "luma" ? "luma" : "alpha";
  const seedThreshold = opts.seedThreshold ?? (maskMode === "luma" ? 32 : 96);
  const fringeThreshold = opts.fringeThreshold ?? (maskMode === "luma" ? 10 : 16);
  const expand = opts.expand ?? 2;
  const minSize = opts.minSize ?? 8;
  const minArea = opts.minArea ?? 128;
  const maxFrameAreaRatio = opts.maxFrameAreaRatio ?? (maskMode === "luma" ? 0.75 : 0.55);
  const maxFrames = opts.maxFrames ?? 400;
  const n = width * height;
  const seed = new Uint8Array(n);
  const fringe = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const v =
      maskMode === "luma"
        ? (rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3
        : rgba[o + 3];
    if (v > seedThreshold) seed[i] = 1;
    if (v > fringeThreshold) fringe[i] = 1;
  }

  const seen = new Uint8Array(n);
  /** @type {{name:string,x:number,y:number,width:number,height:number,rotated:boolean,offsetX:number,offsetY:number,originalWidth:number,originalHeight:number,area:number}[]} */
  const frames = [];
  const stack = new Int32Array(n);
  const imageArea = width * height;

  for (let start = 0; start < n; start++) {
    if (!seed[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = start % width;
    let maxX = minX;
    let minY = (start / width) | 0;
    let maxY = minY;
    let area = 0;
    while (sp) {
      const i = stack[--sp];
      area++;
      const x = i % width;
      const y = (i / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [i - 1, i + 1, i - width, i + width];
      for (const j of neighbors) {
        if (j < 0 || j >= n || seen[j] || !seed[j]) continue;
        if ((j === i - 1 || j === i + 1) && ((j / width) | 0) !== y) continue;
        seen[j] = 1;
        stack[sp++] = j;
      }
    }

    let x0 = Math.max(0, minX - expand);
    let y0 = Math.max(0, minY - expand);
    let x1 = Math.min(width - 1, maxX + expand);
    let y1 = Math.min(height - 1, maxY + expand);

    // One-shot fringe cover inside expanded core neighborhood
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        if (!fringe[i]) continue;
        if (x < minX - expand || x > maxX + expand || y < minY - expand || y > maxY + expand) {
          continue;
        }
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }

    const fw = x1 - x0 + 1;
    const fh = y1 - y0 + 1;
    if (fw < minSize || fh < minSize || area < minArea) continue;
    if (fw * fh > imageArea * maxFrameAreaRatio) continue;

    frames.push({
      name: "",
      x: x0,
      y: y0,
      width: fw,
      height: fh,
      rotated: false,
      offsetX: 0,
      offsetY: 0,
      originalWidth: fw,
      originalHeight: fh,
      area,
    });
    if (frames.length > maxFrames * 2) break;
  }

  frames.sort((a, b) => b.area - a.area);
  const kept = frames.filter((_f, idx) => idx < maxFrames);
  kept.sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i < kept.length; i++) {
    kept[i].name = `sprite_${String(i + 1).padStart(3, "0")}`;
    delete kept[i].area;
  }
  return kept;
}

function alphaUseful(rgba, width, height, fringeThreshold = 16) {
  const n = width * height;
  const sampleStep = Math.max(1, Math.floor(n / 20000));
  let transparentish = 0;
  let samples = 0;
  for (let i = 0; i < n; i += sampleStep) {
    samples++;
    if (rgba[i * 4 + 3] <= fringeThreshold) transparentish++;
  }
  return samples > 0 && transparentish / samples >= 0.02;
}

function scaleFrames(frames, scale, width, height) {
  const inv = scale > 0 ? 1 / scale : 1;
  return frames.map((f, i) => {
    const x = Math.max(0, Math.floor(f.x * inv));
    const y = Math.max(0, Math.floor(f.y * inv));
    let w = Math.max(1, Math.ceil(f.width * inv));
    let h = Math.max(1, Math.ceil(f.height * inv));
    if (x + w > width) w = width - x;
    if (y + h > height) h = height - y;
    return {
      name: f.name || `sprite_${String(i + 1).padStart(3, "0")}`,
      x,
      y,
      width: w,
      height: h,
      rotated: false,
      offsetX: 0,
      offsetY: 0,
      originalWidth: w,
      originalHeight: h,
    };
  });
}

/**
 * @param {string} imageAbs
 * @param {{
 *   sharp?: any,
 *   maxDetectEdge?: number,
 *   minFrames?: number,
 *   forceMaskMode?: "alpha" | "luma",
 * } & Parameters<typeof detectFramesFromRgba>[3]} [opts]
 * @returns {Promise<{frames: ReturnType<typeof detectFramesFromRgba>, matchHow: string|null}>}
 */
export async function detectAtlasFramesFromImage(imageAbs, opts = {}) {
  if (!fs.existsSync(imageAbs)) return { frames: [], matchHow: null };
  const sharpMod = opts.sharp || (await import("sharp")).default;
  const meta = await sharpMod(imageAbs).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width < 64 || height < 64) return { frames: [], matchHow: null };

  const maxEdge = opts.maxDetectEdge ?? 1536;
  const minFrames = opts.minFrames ?? 2;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));

  const { data, info } = await sharpMod(imageAbs)
    .ensureAlpha()
    .resize(dw, dh, { fit: "fill", kernel: "nearest" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const force = opts.forceMaskMode;
  const tryAlpha = force !== "luma";
  const tryLuma = force === "luma" || force === undefined;

  if (tryAlpha && (force === "alpha" || alphaUseful(data, info.width, info.height, opts.fringeThreshold ?? 16))) {
    const frames = detectFramesFromRgba(data, info.width, info.height, {
      ...opts,
      maskMode: "alpha",
    });
    if (frames.length >= minFrames) {
      return { frames: scaleFrames(frames, scale, width, height), matchHow: "alpha-cc" };
    }
  }

  if (tryLuma) {
    const frames = detectFramesFromRgba(data, info.width, info.height, {
      ...opts,
      maskMode: "luma",
      seedThreshold: opts.seedThreshold ?? 32,
      fringeThreshold: opts.fringeThreshold ?? 10,
      maxFrameAreaRatio: opts.maxFrameAreaRatio ?? 0.75,
    });
    if (frames.length >= minFrames) {
      return { frames: scaleFrames(frames, scale, width, height), matchHow: "luma-cc" };
    }
  }

  return { frames: [], matchHow: null };
}

/**
 * @param {{ width?: number, height?: number, frames?: any[], resourceType?: string }} tex
 */
export function shouldDetectStaticAtlas(tex) {
  if (Array.isArray(tex.frames) && tex.frames.length) return false;
  const rt = String(tex.resourceType || "static");
  if (rt !== "static" && rt !== "other") return false;
  const w = tex.width || 0;
  const h = tex.height || 0;
  if (w < 256 || h < 256) return false;
  if (w * h < 256 * 256) return false;
  return true;
}

export function atlasCachePath(dataRoot, tabId, texId) {
  return path.join(dataRoot, "atlases", String(tabId), `${texId}.auto.json`);
}

/** Guessed frame rects (alpha or luma connected components). */
export function isAutoMatchHow(matchHow) {
  const m = String(matchHow || "");
  return m === "alpha-cc" || m === "luma-cc";
}
