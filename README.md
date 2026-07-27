# har-explore

从 HAR 文件提取、预览游戏资源（纹理、Spine、位图字体、粒子、音频）。支持 **Cocos Creator 2.x / 3.x**、**Pragmatic Play**、**Slotmill** 的自动识别。

技术说明（可分享）：[docs/资源提取与预览技术.md](docs/资源提取与预览技术.md)

## 结构

```
harExplore/
├── packages/
│   ├── core/          # 共享分析库（引擎检测、Spine 提取、Tab 构建）
│   ├── cli/           # 命令行工具
│   └── web/           # Web 可视化（viewer + 上传 HAR）
├── cocos-projects/
│   └── particle-player/  # Cocos 粒子预览壳（Creator 工程放这里）
├── samples/           # 放置 .har 样本（不提交大文件）
└── dist/              # 构建输出（viewer、spine 导出等）
```

## 快速开始

```bash
# 1. 把 HAR 放到 samples/
copy D:\path\to\play.godeebxp.com.har samples\

# 2. 编辑 packages/web/catalog-sources.json（或单 HAR 构建）

# 3. 构建 viewer
npm run build:catalog
# 可选：用 HAR SpriteFrame + 透明连通域补全图集帧
npm run enrich:atlas-frames

# 4. 启动 Web（支持拖拽上传新 HAR）
npm run serve
# → http://127.0.0.1:8765/
```

## CLI

```bash
npm run har-lab -- --help

npm run spine -- samples/play.godeebxp.com.har --names symbol_08 --layout bare --out dist/spine-export

npm run font -- samples/play.godeebxp.com.har --name countup_01 --out dist/font-export

npm run particle -- samples/play.godeebxp.com.har --out dist/har-particles

npm run audio -- samples/play.godeebxp.com.har --out dist/har-audio

npm run build -- samples/game.har --out dist/texture-viewer

# Spine 转序列帧（透明 PNG，默认 30fps，自动匹配 3.7/3.8 runtime）
npm run bake -- dist/spine-export/symbol_08 --fps 30 --out dist/frames/symbol_08
npm run bake -- dist/texture-viewer/animations/golden-seth/f_times --anim loop_2 --scale 2
# 不适配：保持缩放，超出画布从中心裁掉
npm run bake -- dist/texture-viewer/animations/gameweb3.rsg-games.com/ultrawin --scale 1 --pipeline crop-canvas
```

## Windows 绿色版（内置 Node，解压即用）

```bash
# 内置 Node + 预置雷神2、赏金猎人（约 230MB zip）
npm run pack

# 含 CLI 烘焙 Playwright 浏览器（体积更大）
npm run pack:full
```
产物：`release/harExplore-portable-win-x64.zip`

解压后双击 **启动查看器.bat** → http://127.0.0.1:8765/ ，打开即可看到 **雷神2**、**赏金猎人** 两个标签页。

## 从 perlab 迁移

| 原路径 (perlab) | 新路径 |
|-----------------|--------|
| `tools/scripts/lib/*` | `packages/core/src/` |
| `tools/scripts/extract-*.mjs` | `packages/cli/src/` |
| `tools/texture-viewer/` | `packages/web/viewer/` |
| `tools/scripts/serve-texture-viewer.mjs` | `packages/web/server.mjs` |
