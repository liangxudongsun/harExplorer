#!/usr/bin/env node
/**
 * Server for the HAR texture viewer.
 *
 * Static file serving + a POST /upload endpoint that accepts a raw .har body,
 * auto-detects the engine (cocos / pragmatic / slotmill), builds a tab into the
 * served directory, appends it to catalog.json, and returns the tab JSON so the
 * page can add it live.
 *
 * Usage: node serve-texture-viewer.mjs [--dir path] [--port 8765]
 */
import { createServer } from 'http';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildSlotmillTab, buildPragmaticTab, buildCocosTab, detectEngine } from '../core/src/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const portIdx = args.indexOf('--port');
const ROOT = dirIdx >= 0 ? args[dirIdx + 1] : join(process.cwd(), 'dist', 'texture-viewer');
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 8765;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.atlas': 'text/plain; charset=utf-8',
  '.plist': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const BUILDERS = {
  cocos: buildCocosTab,
  pragmatic: buildPragmaticTab,
  slotmill: buildSlotmillTab,
};

function safeId(name) {
  return (
    String(name)
      .replace(/\.har$/i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `har-${Date.now()}`
  );
}

function loadCatalog() {
  const file = join(ROOT, 'catalog.json');
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      /* fall through */
    }
  }
  return { builtAt: new Date().toISOString(), tabs: [] };
}

function readBody(req, maxBytes = 800 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('HAR too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleUpload(req, res) {
  try {
    const buf = await readBody(req);
    const rawName = decodeURIComponent(req.headers['x-file-name'] ?? 'upload.har');
    let har;
    try {
      har = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new Error('无法解析为 HAR JSON');
    }
    const entries = har.log?.entries ?? [];
    if (!entries.length) throw new Error('HAR 中没有网络请求 (log.entries 为空)');

    const pageTitle = har.log?.pages?.[0]?.title ?? '';
    const detection = detectEngine(entries, pageTitle);

    const uploadsDir = join(ROOT, 'uploads');
    mkdirSync(uploadsDir, { recursive: true });
    let id = safeId(rawName);
    const catalog = loadCatalog();
    if (catalog.tabs.some((t) => t.id === id)) id = `${id}-${Date.now().toString(36)}`;

    const harPath = join(uploadsDir, `${id}.har`);
    writeFileSync(harPath, buf);

    const build = BUILDERS[detection.engine] ?? buildSlotmillTab;
    const src = {
      id,
      label: pageTitle?.split('?')[0]?.slice(0, 48) || rawName.replace(/\.har$/i, ''),
      type: detection.engine,
      har: harPath,
    };
    const tab = build(harPath, ROOT, src);
    tab.engineDetection = detection;

    catalog.tabs.push(tab);
    catalog.builtAt = new Date().toISOString();
    writeFileSync(join(ROOT, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tab, detection }));
    console.log(
      `Upload: ${rawName} → ${detection.engine}` +
        (detection.cocosMajor != null ? `/${detection.cocosMajor}.x` : '') +
        ` (tab ${id}, ${tab.meta?.total ?? 0} textures)`
    );
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(err.message ?? err) }));
    console.error('Upload failed:', err.message ?? err);
  }
}

// The viewer app (html / vendor runtimes / 3.7 sub-player) is served from the
// package source; ROOT is purely a data directory (catalog.json, embedded/,
// animations/, uploads/) that can be deleted and rebuilt at any time.
const VIEWER_DIR = join(__dirname, 'viewer');

function resolveFile(urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\//, '');
  if (urlPath === '/' || urlPath === '/index.html') {
    return join(VIEWER_DIR, 'viewer.html');
  }
  // Cocos web-mobile shell (and its nested assets)
  if (rel === 'particle-player' || rel === 'particle-player/') {
    rel = 'particle-player/index.html';
  }
  const appFile = join(VIEWER_DIR, rel);
  const isAppAsset =
    rel === 'spine37-player.html' ||
    rel === 'spine-bake.js' ||
    rel.startsWith('vendor/') ||
    rel.startsWith('particle-player/');
  if (
    isAppAsset &&
    appFile.startsWith(VIEWER_DIR) &&
    existsSync(appFile) &&
    !statSync(appFile).isDirectory()
  ) {
    return appFile;
  }
  const dataFile = join(ROOT, rel);
  if (dataFile.startsWith(ROOT) && existsSync(dataFile) && !statSync(dataFile).isDirectory()) {
    return dataFile;
  }
  return null;
}

function serveStatic(req, res) {
  const file = resolveFile(req.url.split('?')[0]);
  if (!file) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url.split('?')[0] === '/upload') {
    handleUpload(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Texture viewer: http://127.0.0.1:${PORT}/`);
  console.log(`Serving: ${ROOT}`);
  console.log('Upload a HAR: POST /upload (raw body, header x-file-name)');
});
