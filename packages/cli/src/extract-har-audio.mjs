#!/usr/bin/env node
/**
 * Extract Cocos audio from a HAR into audio/ layout.
 *
 *   npm run audio -- <file.har> [--out DIR]
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { writeAudioPacks } from '../../core/src/engines/cocos/extract-audio.mjs';

const argv = process.argv.slice(2);
const harPath = argv.find((a) => !a.startsWith('--'));
const outIdx = argv.indexOf('--out');
if (!harPath) {
  console.error('用法: npm run audio -- <file.har> [--out DIR]');
  process.exit(1);
}
const outDir = resolve(
  outIdx >= 0 && argv[outIdx + 1]
    ? argv[outIdx + 1]
    : join(dirname(resolve(harPath)), 'tmp', 'har-audio'),
);
const tabId = 'cli';
mkdirSync(outDir, { recursive: true });
const har = JSON.parse(readFileSync(resolve(harPath), 'utf8'));
const entries = har.log?.entries ?? [];
const items = writeAudioPacks(outDir, tabId, entries);
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({ har: resolve(harPath), items, count: items.length }, null, 2),
);
console.log(JSON.stringify({ ok: true, outDir, count: items.length }, null, 2));
