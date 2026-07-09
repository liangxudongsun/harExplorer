#!/usr/bin/env node
/** Serve symbol 17/18 Spine 3.7 player + exported packs.
 * Usage: node tools/scripts/serve-spine-player.mjs [--port 8770] [--packs dir]
 */
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const packsIdx = args.indexOf('--packs');
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 8770;
const PLAYER_ROOT = join(process.cwd(), 'packages', 'web', 'spine-player');
const PACKS_ROOT =
  packsIdx >= 0
    ? args[packsIdx + 1]
    : join(process.cwd(), 'dist', 'spine-export');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.atlas': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer((req, res) => {
  const raw = req.url?.split('?')[0] ?? '/';
  let root = PLAYER_ROOT;
  let rel = raw;

  if (raw === '/') rel = '/symbol17-18.html';
  if (raw.startsWith('/packs/')) {
    root = PACKS_ROOT;
    rel = raw.slice('/packs'.length);
  }

  const file = join(root, rel.replace(/^\//, ''));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('Not found: ' + raw);
    return;
  }
  const ext = extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

server.listen(PORT, () => {
  console.log(`Spine 3.7 player: http://127.0.0.1:${PORT}/`);
  console.log(`Player:  ${PLAYER_ROOT}`);
  console.log(`Packs:   ${PACKS_ROOT}`);
});
