/**
 * In-browser Spine → PNG sequence baker.
 *
 * Version-agnostic: works against whatever `spine` global is loaded on the
 * page (the 3.8 player bundle in viewer.html, the 3.7 webgl build inside
 * spine37-player.html) — both expose the same webgl API surface.
 *
 * spineBakeFrames(opts, onProgress?) →
 *   { animations: [{ name, duration, frameCount, width, height, scale,
 *                    origin, frames: Blob[] }], missingRegions: string[] }
 *
 * opts.skeletonJson must already be in the shape the current runtime expects
 * (skins array for 3.8, skins map for 3.7).
 */
async function spineBakeFrames(opts, onProgress) {
  const {
    skeletonJson,
    atlasText,
    images = {},
    fps = 30,
    scale = 1,
    maxSize = 2048,
    animations = [],
  } = opts;
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const gl = canvas.getContext('webgl', { alpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL 不可用');
  const renderer = new spine.webgl.SceneRenderer(canvas, gl, false);
  const outCanvas = document.createElement('canvas');
  const outCtx = outCanvas.getContext('2d');

  const placeholder = () => {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    return c;
  };
  const atlas = new spine.TextureAtlas(atlasText, (path) =>
    new spine.webgl.GLTexture(renderer.context, images[path] ?? placeholder()),
  );

  // Skip attachments whose regions live in atlases the HAR didn't capture.
  const base = new spine.AtlasAttachmentLoader(atlas);
  const missing = new Set();
  const wrap = (fn) => (...args) => {
    const path = args[2] ?? args[1];
    if (path && !atlas.findRegion(path)) {
      missing.add(path);
      return null;
    }
    return fn.apply(base, args);
  };
  const loader = {
    newRegionAttachment: wrap(base.newRegionAttachment.bind(base)),
    newMeshAttachment: wrap(base.newMeshAttachment.bind(base)),
    newBoundingBoxAttachment: base.newBoundingBoxAttachment.bind(base),
    newPathAttachment: base.newPathAttachment.bind(base),
    newPointAttachment: base.newPointAttachment.bind(base),
    newClippingAttachment: base.newClippingAttachment.bind(base),
  };

  const data = new spine.SkeletonJson(loader).readSkeletonData(skeletonJson);
  const skeleton = new spine.Skeleton(data);
  if (data.defaultSkin) skeleton.setSkin(data.defaultSkin);
  else if (data.skins?.length) skeleton.setSkin(data.skins[0]);
  const state = new spine.AnimationState(new spine.AnimationStateData(data));

  const allAnims = data.animations.map((a) => a.name);
  const targets = animations.length ? allAnims.filter((n) => animations.includes(n)) : allAnims;
  if (!targets.length) throw new Error('没有匹配的动画');

  const frameCountOf = (name) => {
    const dur = data.findAnimation(name).duration;
    return Math.max(1, Math.round((dur > 0 ? dur : 1 / fps) * fps));
  };
  const totalFrames = targets.reduce((s, n) => s + frameCountOf(n), 0);
  let doneFrames = 0;
  progress(0, totalFrames, '准备中');

  // Sample the whole animation so the canvas fits every frame and all frames
  // of one animation share the same size / alignment.
  function animBounds(name) {
    state.clearTracks();
    skeleton.setToSetupPose();
    state.setAnimation(0, name, false);
    const dur = data.findAnimation(name).duration;
    const steps = Math.max(1, Math.ceil((dur > 0 ? dur : 0.001) * fps));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const off = new spine.Vector2();
    const size = new spine.Vector2();
    for (let i = 0; i <= steps; i++) {
      state.update(i === 0 ? 0 : dur / steps);
      state.apply(skeleton);
      skeleton.updateWorldTransform();
      skeleton.getBounds(off, size, []);
      if (isFinite(off.x) && isFinite(size.x) && size.x > 0 && size.y > 0) {
        minX = Math.min(minX, off.x);
        minY = Math.min(minY, off.y);
        maxX = Math.max(maxX, off.x + size.x);
        maxY = Math.max(maxY, off.y + size.y);
      }
    }
    if (!isFinite(minX)) return null;
    const pad = 2;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }

  const captureBlob = () =>
    new Promise((resolve, reject) => {
      outCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });

  /**
   * Bake one frame to straight-alpha RGBA.
   *
   * Additive / multiply slots (flames, glows, shadows) are background-
   * dependent, so a single transparent-background render leaves their
   * texture's black/white base baked in. Instead render the same pose over
   * black and over white: any GL blend mode is affine in the background
   * (result = premultColor + background * k), so per pixel
   *   k = 1 - (white - black)   and   alpha = 1 - mean(k)
   * recovers premultiplied color (the black render) and an alpha that is
   * exact for normal and pure-additive pixels.
   */
  function compositeFrame(cw, ch, drawPose) {
    const n = cw * ch * 4;
    const readPass = (bg) => {
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(bg, bg, bg, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawPose();
      const px = new Uint8Array(n);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const black = readPass(0);
    const white = readPass(1);
    const img = outCtx.createImageData(cw, ch);
    const out = img.data;
    for (let y = 0; y < ch; y++) {
      // GL rows are bottom-up; ImageData is top-down.
      const src = (ch - 1 - y) * cw * 4;
      const dst = y * cw * 4;
      for (let x = 0; x < cw * 4; x += 4) {
        const s = src + x;
        const r = black[s], g = black[s + 1], b = black[s + 2];
        const a255 =
          765 - (white[s] - r) - (white[s + 1] - g) - (white[s + 2] - b);
        const a = Math.max(0, Math.min(255, Math.round(a255 / 3)));
        const d = dst + x;
        if (a === 0) {
          out[d] = out[d + 1] = out[d + 2] = out[d + 3] = 0;
        } else {
          // Un-premultiply against the recovered alpha.
          out[d] = Math.min(255, Math.round((r * 255) / a));
          out[d + 1] = Math.min(255, Math.round((g * 255) / a));
          out[d + 2] = Math.min(255, Math.round((b * 255) / a));
          out[d + 3] = a;
        }
      }
    }
    outCtx.putImageData(img, 0, 0);
  }

  const out = [];
  for (const name of targets) {
    const b = animBounds(name);
    if (!b) {
      out.push({ name, error: 'empty bounds', frames: [] });
      continue;
    }
    let s = scale;
    if (Math.max(b.w, b.h) * s > maxSize) s = maxSize / Math.max(b.w, b.h);
    const cw = Math.max(2, Math.round(b.w * s));
    const ch = Math.max(2, Math.round(b.h * s));
    canvas.width = cw;
    canvas.height = ch;
    outCanvas.width = cw;
    outCanvas.height = ch;

    const dur = data.findAnimation(name).duration;
    const frameCount = frameCountOf(name);

    state.clearTracks();
    skeleton.setToSetupPose();
    state.setAnimation(0, name, false);

    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      state.update(i === 0 ? 0 : 1 / fps);
      state.apply(skeleton);
      skeleton.updateWorldTransform();

      renderer.camera.setViewport(cw, ch);
      renderer.camera.position.set(b.x + b.w / 2, b.y + b.h / 2, 0);
      renderer.camera.zoom = 1 / s;
      renderer.camera.update();
      compositeFrame(cw, ch, () => {
        renderer.begin();
        renderer.drawSkeleton(skeleton, false);
        renderer.end();
      });

      frames.push(await captureBlob());
      doneFrames++;
      progress(doneFrames, totalFrames, `烘焙 ${name}`);
    }
    out.push({
      name,
      duration: +dur.toFixed(4),
      frameCount,
      width: cw,
      height: ch,
      scale: +s.toFixed(4),
      origin: { x: +b.x.toFixed(2), y: +b.y.toFixed(2) },
      frames,
    });
  }

  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { animations: out, missingRegions: [...missing] };
}

window.spineBakeFrames = spineBakeFrames;
