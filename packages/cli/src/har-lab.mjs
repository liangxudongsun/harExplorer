#!/usr/bin/env node
/**
 * har-explore unified CLI
 *
 * Usage:
 *   node packages/cli/src/har-lab.mjs <command> [args...]
 *
 * Commands:
 *   build [har]           Build viewer from HAR or catalog-sources.json
 *   catalog [--out dir]   Build multi-tab viewer from catalog-sources.json
 *   serve [--port N]      Start web viewer (delegates to packages/web/server.mjs)
 *   spine <har> [opts]    Export Cocos Spine packs
 *   font <har> [opts]     Export BitmapFont
 *   analyze <har>         Quick texture stats
 *   diff <a.har> <b.har>  Diff two HARs
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..');

const SCRIPTS = {
  catalog: join(__dirname, 'build-texture-viewer-catalog.mjs'),
  build: join(__dirname, 'build-texture-viewer.mjs'),
  spine: join(__dirname, 'extract-cocos-spine-packs.mjs'),
  font: join(__dirname, 'extract-bitmap-font.mjs'),
  'analyze-cocos': join(__dirname, 'analyze-cocos-har.mjs'),
  'analyze-pp': join(__dirname, 'analyze-pp-har-textures.mjs'),
  analyze: join(__dirname, 'analyze-har-textures.mjs'),
  diff: join(__dirname, 'diff-har.mjs'),
  probe: join(__dirname, 'probe-har.mjs'),
  'spine-player': join(__dirname, 'serve-spine-player.mjs'),
};

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`har-explore CLI

Commands:
  catalog [--out dir]       Build viewer from packages/web/catalog-sources.json
  build <file.har>          Build single-HAR viewer
  spine <file.har> [opts]   Export Cocos Spine packs
  font <file.har> [opts]    Export BitmapFont (.png + .fnt)
  analyze <file.har>        Texture summary
  analyze-cocos <file.har>  Cocos-specific report
  analyze-pp <file.har>     Pragmatic-specific report
  diff <a.har> <b.har>      Compare two HARs
  probe <file.har>          URL/MIME probe
  spine-player [--port N]   Spine 3.7 dedicated player
  serve [--port N]          Web viewer + HAR upload

Run from repo root: npm run serve | npm run build:catalog
`);
  process.exit(cmd ? 0 : 1);
}

if (cmd === 'serve') {
  const child = spawn(process.execPath, [join(root, 'packages', 'web', 'server.mjs'), ...rest], {
    stdio: 'inherit',
    cwd: root,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const script = SCRIPTS[cmd];
  if (!script) {
    console.error(`Unknown command: ${cmd}\nRun: har-lab --help`);
    process.exit(1);
  }
  const child = spawn(process.execPath, [script, ...rest], { stdio: 'inherit', cwd: root });
  child.on('exit', (code) => process.exit(code ?? 0));
}
