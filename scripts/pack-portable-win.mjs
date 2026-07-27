#!/usr/bin/env node
/**
 * Build a Windows portable ("green") package with bundled Node.js runtime.
 *
 * Output: release/harExplore-portable-win-x64.zip
 *   harExplore/
 *     node/          Node.js win-x64 (node.exe, npm)
 *     app/           project source (no .git / HAR / large dist)
 *     启动查看器.bat
 *     README-绿色版.txt
 *
 * Usage:
 *   node scripts/pack-portable-win.mjs [--with-bake] [--node 22.16.0]
 *
 * --with-bake  Also install Playwright Chromium for CLI bake (adds ~300MB).
 */
import {
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  createWriteStream,
  readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const args = process.argv.slice(2);
const WITH_BAKE = args.includes('--with-bake');
const nodeVer = args.includes('--node') ? args[args.indexOf('--node') + 1] : '22.16.0';

const OUT_NAME = 'harExplore-portable-win-x64';
const STAGING = join(ROOT, 'release', '_staging', OUT_NAME);
const ZIP_PATH = join(ROOT, 'release', `${OUT_NAME}.zip`);
const CACHE = join(ROOT, 'release', '_cache');
const NODE_ZIP = join(CACHE, `node-v${nodeVer}-win-x64.zip`);
const NODE_DIR = join(CACHE, `node-v${nodeVer}-win-x64`);

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'release',
  'temp',
  'uploads',
  'dist',
]);
const SKIP_FILES = /\.(har|zip)$/i;

/** Pre-bundled demo tabs (雷神2 + 赏金猎人). */
const PRESET_TABS = [
  {
    id: 'power-of-thor2',
    label: '雷神2',
    type: 'cocos',
    har: 'samples/gameweb3.rsg-games.com.har',
    src: join(ROOT, 'samples', 'gameweb3.rsg-games.com.har'),
    name: 'gameweb3.rsg-games.com.har',
  },
  {
    id: 'bounty-hunter',
    label: '赏金猎人',
    type: 'cocos',
    har: 'samples/gameweb3.rsg-games.com2.har',
    src: join(ROOT, 'samples', 'gameweb3.rsg-games.com2.har'),
    name: 'gameweb3.rsg-games.com2.har',
  },
];

function stagePresetSamples(dest) {
  mkdirSync(dest, { recursive: true });
  for (const preset of PRESET_TABS) {
    if (!existsSync(preset.src)) {
      throw new Error(`Preset HAR missing (${preset.label}): ${preset.src}`);
    }
    cpSync(preset.src, join(dest, preset.name));
  }
  writeFileSync(
    join(dest, 'README.txt'),
    [
      '绿色版已预置：雷神2、赏金猎人',
      '',
      '可继续放入更多 .har，运行「构建目录.bat」或在网页里拖拽上传。',
    ].join('\n'),
    'utf8',
  );
}

/** Portable catalog only lists preset tabs (avoid missing HAR like 塞特2). */
function writePresetCatalogSources(appDir) {
  const sources = PRESET_TABS.map(({ id, label, type, har }) => ({
    id,
    label,
    type,
    har,
  }));
  writeFileSync(
    join(appDir, 'packages', 'web', 'catalog-sources.json'),
    `${JSON.stringify(sources, null, 2)}\n`,
    'utf8',
  );
}

function copyApp(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(name.name)) continue;
    if (name.name === 'samples') continue;
    const s = join(src, name.name);
    const d = join(dest, name.name);
    if (name.isDirectory()) {
      copyApp(s, d);
    } else if (!SKIP_FILES.test(name.name)) {
      cpSync(s, d);
    }
  }
}

async function downloadNode() {
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(NODE_DIR)) {
    if (!existsSync(NODE_ZIP)) {
      const url = `https://nodejs.org/dist/v${nodeVer}/node-v${nodeVer}-win-x64.zip`;
      console.log(`Downloading Node ${nodeVer} …`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Node download failed: ${res.status} ${url}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(NODE_ZIP));
    }
    console.log('Extracting Node …');
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${NODE_ZIP.replace(/'/g, "''")}' -DestinationPath '${CACHE.replace(/'/g, "''")}' -Force"`,
      { stdio: 'inherit' },
    );
  }
}

function writeBat(name, lines) {
  writeFileSync(join(STAGING, name), lines.join('\r\n') + '\r\n', 'utf8');
}

async function main() {
  console.log(`Packing ${OUT_NAME} (bake=${WITH_BAKE}) …`);
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  await downloadNode();
  cpSync(NODE_DIR, join(STAGING, 'node'), { recursive: true });

  const appDir = join(STAGING, 'app');
  copyApp(ROOT, appDir);
  stagePresetSamples(join(appDir, 'samples'));
  writePresetCatalogSources(appDir);

  const nodeExe = join(STAGING, 'node', 'node.exe');
  console.log('Building preset catalog (雷神2 + 赏金猎人) …');
  execSync(`"${nodeExe}" packages/cli/src/build-texture-viewer-catalog.mjs`, {
    cwd: appDir,
    stdio: 'inherit',
  });

  writeBat('启动查看器.bat', [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0app"',
    'set "PATH=%~dp0node;%PATH%"',
    'echo.',
    'echo  HAR Explorer 查看器',
    'echo  http://127.0.0.1:8765/',
    'echo  关闭本窗口即停止服务',
    'echo.',
    'start "" "http://127.0.0.1:8765/"',
    '"%~dp0node\\node.exe" packages\\web\\server.mjs',
    'pause',
  ]);

  writeBat('构建目录.bat', [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0app"',
    'set "PATH=%~dp0node;%PATH%"',
    'echo 从 samples\\ 里的 HAR 构建 catalog …',
    '"%~dp0node\\node.exe" packages\\cli\\src\\build-texture-viewer-catalog.mjs',
    'echo 完成。请重新打开或刷新查看器。',
    'pause',
  ]);

  if (WITH_BAKE) {
    console.log('Installing Playwright Chromium (this may take a few minutes) …');
    const env = {
      ...process.env,
      PATH: `${join(STAGING, 'node')};${process.env.PATH}`,
      PLAYWRIGHT_BROWSERS_PATH: join(STAGING, 'app', 'ms-playwright'),
    };
    execSync('npm install playwright@1.49.1 --no-save', {
      cwd: join(STAGING, 'app'),
      env,
      stdio: 'inherit',
    });
    execSync('npx playwright install chromium', {
      cwd: join(STAGING, 'app'),
      env,
      stdio: 'inherit',
    });

    writeBat('烘焙序列帧.bat', [
      '@echo off',
      'chcp 65001 >nul',
      'cd /d "%~dp0app"',
      'set "PATH=%~dp0node;%PATH%"',
      'set "PLAYWRIGHT_BROWSERS_PATH=%~dp0app\\ms-playwright"',
      'echo 用法: 把 Spine 导出目录拖到本窗口，或在下方输入路径',
      'set /p PACK="Spine 目录: "',
      'if "%PACK%"=="" ( echo 未输入目录 & pause & exit /b 1 )',
      '"%~dp0node\\node.exe" packages\\cli\\src\\spine-to-frames.mjs "%PACK%" --fps 30',
      'pause',
    ]);
  }

  writeFileSync(
    join(STAGING, 'README-绿色版.txt'),
    [
      'HAR Explorer 绿色版 (Windows x64)',
      '================================',
      '',
      '无需安装 Node.js，解压即用。',
      '',
      '启动查看器.bat',
      '  打开 http://127.0.0.1:8765/ ，已预置雷神2、赏金猎人',
      '',
      '构建目录.bat',
      '  从 app\\samples\\ 里的 HAR 重新生成 catalog（可选）',
      '',
      WITH_BAKE
        ? '烘焙序列帧.bat\n  CLI 将 Spine 包转为 30fps 透明 PNG 序列\n'
        : '（未包含烘焙：打包时加 --with-bake 可内置 Playwright 浏览器）\n',
      '',
      `Node.js ${nodeVer} | 构建于 ${new Date().toLocaleString('zh-CN')}`,
    ].join('\r\n'),
    'utf8',
  );

  mkdirSync(join(ROOT, 'release'), { recursive: true });
  rmSync(ZIP_PATH, { force: true });
  console.log('Creating zip …');
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${STAGING.replace(/'/g, "''")}' -DestinationPath '${ZIP_PATH.replace(/'/g, "''")}' -Force"`,
    { stdio: 'inherit' },
  );

  const sizeMb = (readFileSync(ZIP_PATH).length / 1048576).toFixed(1);
  console.log(`Done → ${ZIP_PATH} (${sizeMb} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
