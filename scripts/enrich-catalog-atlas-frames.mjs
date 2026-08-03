#!/usr/bin/env node
/**
 * Patch existing texture-viewer catalog.json with per-frame rects:
 * 1) Cocos SpriteFrame metadata from HAR (grouped by Texture2D)
 * 2) Alpha connected-components for remaining packed sheets (no import rects)
 *
 * Usage:
 *   node scripts/enrich-catalog-atlas-frames.mjs [--out dist/texture-viewer]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanCocosHar, tagCocosTextures } from "../packages/core/src/engines/cocos/parse-import.mjs";
import {
  detectAtlasFramesFromImage,
  isAutoMatchHow,
  shouldDetectStaticAtlas,
} from "../packages/core/src/engines/cocos/detect-atlas-from-image.mjs";

const MIN_AUTO_FRAMES = 2;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const tabIdx = args.indexOf("--tab");
const outDir = path.resolve(root, outIdx >= 0 ? args[outIdx + 1] : "dist/texture-viewer");
const onlyTab = tabIdx >= 0 ? String(args[tabIdx + 1] || "").trim() : "";
const catalogPath = path.join(outDir, "catalog.json");
const sourcesPath = path.join(root, "packages/web/catalog-sources.json");

function bodyEntriesFromHar(harPath) {
  const har = JSON.parse(fs.readFileSync(harPath, "utf8"));
  return Array.isArray(har?.log?.entries) ? har.log.entries : [];
}

function writeSidecar(tabId, tex) {
  if (!tex.frames?.length) return;
  const atlasDir = path.join(outDir, "atlases", tabId);
  fs.mkdirSync(atlasDir, { recursive: true });
  const id = String(tex.id);
  const file = path.join(atlasDir, isAutoMatchHow(tex.matchHow) ? `${id}.auto.json` : `${id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        tabId,
        textureId: tex.id,
        src: tex.src || null,
        width: tex.width,
        height: tex.height,
        resourceType: tex.resourceType,
        matchHow: tex.matchHow || null,
        frames: tex.frames,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function detectStaticAtlases(tab) {
  let detected = 0;
  let frames = 0;
  for (let i = 0; i < (tab.textures || []).length; i++) {
    const tex = tab.textures[i];
    if (!shouldDetectStaticAtlas(tex)) continue;
    const srcRel = tex.src ? String(tex.src).replace(/\\/g, "/").replace(/^\//, "") : null;
    if (!srcRel) continue;
    const abs = path.join(outDir, srcRel);
    if (!fs.existsSync(abs)) continue;

    const cachePath = path.join(outDir, "atlases", tab.id, `${tex.id}.auto.json`);
    let found = null;
    let matchHow = "alpha-cc";
    if (fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        const srcStat = fs.statSync(abs);
        if (
          Array.isArray(cached.frames) &&
          cached.frames.length >= MIN_AUTO_FRAMES &&
          cached.src === srcRel &&
          cached.sourceMtimeMs === srcStat.mtimeMs
        ) {
          found = cached.frames;
          matchHow = isAutoMatchHow(cached.matchHow) ? cached.matchHow : "alpha-cc";
        }
      } catch {
        /* ignore */
      }
    }
    if (!found) {
      process.stdout.write(`  auto-detect ${tab.id}/${tex.id} (${tex.width}x${tex.height})… `);
      const detected = await detectAtlasFramesFromImage(abs, {
        expand: 2,
        minSize: 8,
        minArea: 128,
        minFrames: MIN_AUTO_FRAMES,
      });
      found = detected.frames;
      matchHow = detected.matchHow || "alpha-cc";
      console.log(found.length ? `${found.length} frames (${matchHow})` : "none");
      if (found.length >= MIN_AUTO_FRAMES) {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(
          cachePath,
          JSON.stringify(
            {
              tabId: tab.id,
              textureId: tex.id,
              src: srcRel,
              sourceMtimeMs: fs.statSync(abs).mtimeMs,
              width: tex.width,
              height: tex.height,
              matchHow,
              frames: found,
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );
      }
    }
    if (!found || found.length < MIN_AUTO_FRAMES) continue;

    let maxW = 0;
    let maxH = 0;
    for (const f of found) {
      maxW = Math.max(maxW, f.x + f.width);
      maxH = Math.max(maxH, f.y + f.height);
    }
    tab.textures[i] = {
      ...tex,
      resourceType: "sprite-atlas",
      category: "sprite-atlas",
      atlasFrameCount: found.length,
      atlasBounds: `${maxW}×${maxH}`,
      frames: found,
      matchHow,
      sequenceGroups: [],
      sequencePrefix: null,
      sequenceFrameCount: found.length,
    };
    detected += 1;
    frames += found.length;
  }
  return { detected, frames };
}

async function main() {
  if (!fs.existsSync(catalogPath)) throw new Error(`missing ${catalogPath}`);
  const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const srcById = new Map(sources.map((s) => [s.id, s]));

  let patchedTextures = 0;
  let patchedFrames = 0;
  let alphaTextures = 0;
  let alphaFrames = 0;

  for (const tab of catalog.tabs || []) {
    if (onlyTab && tab.id !== onlyTab) continue;
    const src = srcById.get(tab.id);
    if (!src || src.type !== "cocos") continue;
    const harPath = path.join(root, src.har);
    if (!fs.existsSync(harPath)) {
      console.warn(`[skip] HAR missing for ${tab.id}: ${harPath}`);
      continue;
    }
    const scan = scanCocosHar(bodyEntriesFromHar(harPath));
    const tagged = tagCocosTextures(tab.textures || [], scan, []);
    const byUrl = new Map(tagged.textures.map((t) => [t.url, t]));
    tab.textures = (tab.textures || []).map((tex) => {
      const hit = byUrl.get(tex.url);
      const base = { ...tex };
      delete base.frames;
      delete base.atlasFrameCount;
      delete base.atlasBounds;
      delete base.textureUuid;
      delete base.textureUuidDecoded;
      delete base.matchHow;
      if (!hit?.frames?.length) {
        if (
          base.resourceType === "sprite-atlas" ||
          base.resourceType === "sprite-sequence"
        ) {
          // Keep prior alpha-cc results until alpha pass re-validates
          if (isAutoMatchHow(tex.matchHow) && Array.isArray(tex.frames) && tex.frames.length >= MIN_AUTO_FRAMES) {
            return tex;
          }
          base.resourceType = "static";
          if (
            base.category === "sprite-atlas" ||
            String(base.category || "").startsWith("sequence/")
          ) {
            base.category = "other";
          }
        }
        return base;
      }
      patchedTextures += 1;
      patchedFrames += hit.frames.length;
      return {
        ...base,
        resourceType: hit.resourceType || base.resourceType,
        category: hit.category || base.category,
        atlasFrameCount: hit.atlasFrameCount || hit.frames.length,
        sequenceGroups: hit.sequenceGroups || [],
        sequencePrefix: hit.sequencePrefix ?? null,
        sequenceFrameCount: hit.sequenceFrameCount ?? null,
        atlasBounds: hit.atlasBounds || null,
        frames: hit.frames,
        textureUuid: hit.textureUuid || null,
        textureUuidDecoded: hit.textureUuidDecoded || null,
        matchHow: hit.matchHow || null,
      };
    });

    const alpha = await detectStaticAtlases(tab);
    alphaTextures += alpha.detected;
    alphaFrames += alpha.frames;

    for (const tex of tab.textures) writeSidecar(tab.id, tex);

    console.log(
      `[${tab.id}] metaAtlases=${(tab.textures || []).filter((t) => t.frames?.length && t.matchHow !== "alpha-cc").length} alphaAtlases=${alpha.detected} scanGroups=${scan.summary.spriteAtlasCount}`,
    );
  }

  catalog.builtAt = new Date().toISOString();
  catalog.atlasFramesEnrichedAt = catalog.builtAt;
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        ok: true,
        catalogPath,
        patchedTextures,
        patchedFrames,
        alphaTextures,
        alphaFrames,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
