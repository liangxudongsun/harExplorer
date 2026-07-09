# har-explore

从 HAR 文件提取、预览游戏资源（纹理、Spine、位图字体）。支持 **Cocos Creator**、**Pragmatic Play**、**Slotmill** 三种引擎的自动识别。

## 结构

```
harExplore/
├── packages/
│   ├── core/          # 共享分析库（引擎检测、Spine 提取、Tab 构建）
│   ├── cli/           # 命令行工具
│   └── web/           # Web 可视化（viewer + 上传 HAR）
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

# 4. 启动 Web（支持拖拽上传新 HAR）
npm run serve
# → http://127.0.0.1:8765/
```

## CLI

```bash
npm run har-lab -- --help

npm run spine -- samples/play.godeebxp.com.har --names symbol_08 --layout bare --out dist/spine-export

npm run font -- samples/play.godeebxp.com.har --name countup_01 --out dist/font-export

npm run build -- samples/game.har --out dist/texture-viewer

# Spine 转序列帧（透明 PNG，默认 30fps，自动匹配 3.7/3.8 runtime）
npm run bake -- dist/spine-export/symbol_08 --fps 30 --out dist/frames/symbol_08
npm run bake -- dist/texture-viewer/animations/golden-seth/f_times --anim loop_2 --scale 2
```

## 从 perlab 迁移

| 原路径 (perlab) | 新路径 |
|-----------------|--------|
| `tools/scripts/lib/*` | `packages/core/src/` |
| `tools/scripts/extract-*.mjs` | `packages/cli/src/` |
| `tools/texture-viewer/` | `packages/web/viewer/` |
| `tools/scripts/serve-texture-viewer.mjs` | `packages/web/server.mjs` |
