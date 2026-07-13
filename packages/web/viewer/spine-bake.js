/**
 * In-browser Spine → PNG sequence baker.
 *
 * spineBakeFrames(opts, onProgress?) →
 *   { pipeline, animations: [...], missingRegions: string[] }
 *
 * opts.pipeline — see BAKE_PIPELINES (default: standard).
 */
const BAKE_PIPELINES = {
  /** Baseline: dual-pass alpha, max 2048px. */
  standard: {
    label: '标准（当前默认）',
    hint: '双通道 Alpha 合成 · 2048 上限',
    scaleMul: 1,
    maxSize: 2048,
    composite: 'dual',
    supersample: 1,
    filter: 'linear',
  },
  /** Higher output resolution (2× scale, 4096 cap). */
  'high-res': {
    label: '高分辨率 2×',
    hint: '针对 skeleton 缩放导致输出偏小的场景',
    scaleMul: 2,
    maxSize: 4096,
    composite: 'dual',
    supersample: 1,
    filter: 'linear',
  },
  /** Raise canvas cap without changing scale. */
  'max-canvas': {
    label: '超大画布 8192',
    hint: '仅提高 maxSize 上限，排查是否被 2048 截断',
    scaleMul: 1,
    maxSize: 8192,
    composite: 'dual',
    supersample: 1,
    filter: 'linear',
  },
  /** Single transparent pass — no dual compositing. */
  'direct-alpha': {
    label: '直通透明（无双通道）',
    hint: '跳过黑/白底合成，对比 Alpha 精度损失；additive 可能有黑块',
    scaleMul: 1,
    maxSize: 2048,
    composite: 'direct',
    supersample: 1,
    filter: 'linear',
  },
  /** Render 2× internally then downscale. */
  'supersample-2x': {
    label: '超采样 2× 降采样',
    hint: '内部 2× 渲染后 Lanczos 式平滑缩小，改善锯齿与线性模糊',
    scaleMul: 1,
    maxSize: 4096,
    composite: 'dual',
    supersample: 2,
    filter: 'linear',
  },
  /** Nearest-neighbor atlas sampling. */
  nearest: {
    label: '最近邻滤镜',
    hint: '关闭 Linear 贴图过滤，对比边缘是否过软',
    scaleMul: 1,
    maxSize: 2048,
    composite: 'dual',
    supersample: 1,
    filter: 'nearest',
  },
  /** Dual-pass with float intermediate math before quantize. */
  'precise-alpha': {
    label: '高精度 Alpha 合成',
    hint: '双通道合成改用 float 运算，对比 8-bit 色带/边缘',
    scaleMul: 1,
    maxSize: 2048,
    composite: 'dual-float',
    supersample: 1,
    filter: 'linear',
  },
};

function resolvePipeline(id, userScale) {
  const key = BAKE_PIPELINES[id] ? id : 'standard';
  const p = BAKE_PIPELINES[key];
  return {
    id: key,
    label: p.label,
    hint: p.hint,
    scale: Math.max(0.1, (userScale || 1) * p.scaleMul),
    maxSize: p.maxSize,
    composite: p.composite,
    supersample: p.supersample,
    filter: p.filter,
  };
}

function applyAtlasFilter(atlas, filter) {
  if (filter !== 'nearest') return;
  const nearest = spine.TextureFilter?.Nearest ?? 9728;
  for (const page of atlas.pages) {
    page.texture?.setFilters?.(nearest, nearest);
  }
}

async function spineBakeFrames(opts, onProgress) {
  const {
    skeletonJson,
    atlasText,
    images = {},
    fps = 30,
    scale = 1,
    maxSize: maxSizeOverride,
    animations = [],
    pipeline: pipelineId = 'standard',
  } = opts;
  const pipe = resolvePipeline(pipelineId, scale);
  if (maxSizeOverride != null) pipe.maxSize = maxSizeOverride;
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL 不可用');
  const renderer = new spine.webgl.SceneRenderer(canvas, gl, false);
  const outCanvas = document.createElement('canvas');
  const outCtx = outCanvas.getContext('2d');
  const workCanvas = document.createElement('canvas');
  const workCtx = workCanvas.getContext('2d');

  const placeholder = () => {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    return c;
  };
  const atlas = new spine.TextureAtlas(atlasText, (path) =>
    new spine.webgl.GLTexture(renderer.context, images[path] ?? placeholder()),
  );
  applyAtlasFilter(atlas, pipe.filter);

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

  function readGlPixels(cw, ch) {
    const px = new Uint8Array(cw * ch * 4);
    gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  function flipGlToImageData(px, cw, ch, ctx) {
    const img = ctx.createImageData(cw, ch);
    const out = img.data;
    for (let y = 0; y < ch; y++) {
      const src = (ch - 1 - y) * cw * 4;
      const dst = y * cw * 4;
      out.set(px.subarray(src, src + cw * 4), dst);
    }
    return img;
  }

  function compositeDual(ctx, cw, ch, drawPose, useFloat) {
    const readPass = (bg) => {
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(bg, bg, bg, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawPose();
      return readGlPixels(cw, ch);
    };
    const black = readPass(0);
    const white = readPass(1);
    const img = ctx.createImageData(cw, ch);
    const out = img.data;
    for (let y = 0; y < ch; y++) {
      const src = (ch - 1 - y) * cw * 4;
      const dst = y * cw * 4;
      for (let x = 0; x < cw * 4; x += 4) {
        const s = src + x;
        const br = black[s], bg = black[s + 1], bb = black[s + 2];
        const wr = white[s], wg = white[s + 1], wb = white[s + 2];
        let a;
        if (useFloat) {
          const a255 = 765 - (wr - br) - (wg - bg) - (wb - bb);
          a = Math.max(0, Math.min(255, a255 / 3));
        } else {
          a = Math.max(0, Math.min(255, Math.round((765 - (wr - br) - (wg - bg) - (wb - bb)) / 3)));
        }
        const d = dst + x;
        if (a <= 0.5) {
          out[d] = out[d + 1] = out[d + 2] = out[d + 3] = 0;
        } else {
          out[d] = Math.min(255, Math.round((br * 255) / a));
          out[d + 1] = Math.min(255, Math.round((bg * 255) / a));
          out[d + 2] = Math.min(255, Math.round((bb * 255) / a));
          out[d + 3] = Math.round(a);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function compositeDirect(ctx, cw, ch, drawPose) {
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawPose();
    ctx.putImageData(flipGlToImageData(readGlPixels(cw, ch), cw, ch, ctx), 0, 0);
  }

  function renderFrame(cw, ch, zoom, b, targetCtx) {
    renderer.camera.setViewport(cw, ch);
    renderer.camera.position.set(b.x + b.w / 2, b.y + b.h / 2, 0);
    renderer.camera.zoom = 1 / zoom;
    renderer.camera.update();
    const drawPose = () => {
      renderer.begin();
      renderer.drawSkeleton(skeleton, false);
      renderer.end();
    };
    if (pipe.composite === 'direct') compositeDirect(targetCtx, cw, ch, drawPose);
    else compositeDual(targetCtx, cw, ch, drawPose, pipe.composite === 'dual-float');
  }

  function downscaleToOutput(renderW, renderH, outW, outH) {
    outCanvas.width = outW;
    outCanvas.height = outH;
    outCtx.clearRect(0, 0, outW, outH);
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(workCanvas, 0, 0, renderW, renderH, 0, 0, outW, outH);
  }

  const captureBlob = () =>
    new Promise((resolve, reject) => {
      outCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
    });

  function layoutForBounds(b) {
    let s = pipe.scale;
    if (Math.max(b.w, b.h) * s > pipe.maxSize) s = pipe.maxSize / Math.max(b.w, b.h);
    const outW = Math.max(2, Math.round(b.w * s));
    const outH = Math.max(2, Math.round(b.h * s));
    const ss = pipe.supersample;
    const renderW = Math.max(2, Math.round(outW * ss));
    const renderH = Math.max(2, Math.round(outH * ss));
    const renderZoom = s * ss;
    return { s, outW, outH, renderW, renderH, renderZoom, ss };
  }

  const out = [];
  for (const name of targets) {
    const b = animBounds(name);
    if (!b) {
      out.push({ name, error: 'empty bounds', frames: [] });
      continue;
    }
    const { s, outW, outH, renderW, renderH, renderZoom, ss } = layoutForBounds(b);
    canvas.width = renderW;
    canvas.height = renderH;
    workCanvas.width = renderW;
    workCanvas.height = renderH;
    outCanvas.width = outW;
    outCanvas.height = outH;

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

      if (ss > 1) {
        canvas.width = renderW;
        canvas.height = renderH;
        workCanvas.width = renderW;
        workCanvas.height = renderH;
        renderFrame(renderW, renderH, renderZoom, b, workCtx);
        downscaleToOutput(renderW, renderH, outW, outH);
      } else {
        canvas.width = outW;
        canvas.height = outH;
        outCanvas.width = outW;
        outCanvas.height = outH;
        renderFrame(outW, outH, s, b, outCtx);
      }

      frames.push(await captureBlob());
      doneFrames++;
      progress(doneFrames, totalFrames, `烘焙 ${name}`);
    }
    out.push({
      name,
      duration: +dur.toFixed(4),
      frameCount,
      width: outW,
      height: outH,
      scale: +s.toFixed(4),
      renderWidth: renderW,
      renderHeight: renderH,
      supersample: ss,
      origin: { x: +b.x.toFixed(2), y: +b.y.toFixed(2) },
      frames,
    });
  }

  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return {
    pipeline: {
      id: pipe.id,
      label: pipe.label,
      hint: pipe.hint,
      composite: pipe.composite,
      filter: pipe.filter,
      maxSize: pipe.maxSize,
    },
    animations: out,
    missingRegions: [...missing],
  };
}

window.BAKE_PIPELINES = BAKE_PIPELINES;
window.spineBakeFrames = spineBakeFrames;
