/**
 * Detect packed atlas frames from image alpha when Cocos SpriteFrame metadata is missing.
 *
 * Strategy: high-alpha seeds (avoids soft-glow bridges) → connected components →
 * expand each bbox to include nearby low-alpha fringe.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * @param {Uint8Array|Buffer} rgba
 * @param {number} width
 * @param {number} height
 * @param {{
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
  const seedThreshold = opts.seedThreshold ?? 96;
  const fringeThreshold = opts.fringeThreshold ?? 16;
  const expand = opts.expand ?? 2;
  const minSize = opts.minSize ?? 8;
  const minArea = opts.minArea ?? 128;
  const maxFrameAreaRatio = opts.maxFrameAreaRatio ?? 0.55;
  const maxFrames = opts.maxFrames ?? 400;
  const n = width * height;
  const seed = new Uint8Array(n);
  const fringe = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    if (a > seedThreshold) seed[i] = 1;
    if (a > fringeThreshold) fringe[i] = 1;
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

/**
 * @param {string} imageAbs
 * @param {{ sharp?: any, maxDetectEdge?: number } & Parameters<typeof detectFramesFromRgba>[3]} [opts]
 */
export async function detectAtlasFramesFromImage(imageAbs, opts = {}) {
  if (!fs.existsSync(imageAbs)) return [];
  const sharpMod = opts.sharp || (await import("sharp")).default;
  const meta = await sharpMod(imageAbs).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width < 64 || height < 64) return [];

  const maxEdge = opts.maxDetectEdge ?? 1536;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));

  const { data, info } = await sharpMod(imageAbs)
    .ensureAlpha()
    .resize(dw, dh, { fit: "fill", kernel: "nearest" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const frames = detectFramesFromRgba(data, info.width, info.height, opts);
  if (frames.length < 3) return [];

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
