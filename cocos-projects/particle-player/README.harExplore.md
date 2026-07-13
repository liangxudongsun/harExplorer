# particle-player（harExplore 对接说明）

本目录已从 [baseAIAutoCocos](https://github.com/shinjiyu/baseAIAutoCocos) 落地（Creator **3.8.8** + ViewWeaver / CocosMetaMCP）。

上游说明见同目录 `README.md`。

## 用途

harExplore Web 查看器的 **粒子预览壳**：加载 HAR 抽出的 `plist` + 贴图（+ Prefab/`custom` 参数），用真实 `cc.ParticleSystem2D` 渲染，iframe 嵌入 `viewer.html`。

## 工程内容（已生成）

| 路径 | 说明 |
|------|------|
| `assets/scripts/ParticlePlayerHost.ts` | iframe `postMessage` 桥：`load` / `play` / `pause` / `restart` / `stop` |
| `assets/scene/ParticlePlayer.scene` | Canvas + `Particle`（`ParticleSystem2D`）+ Host 组件 |

打开 Creator 后应能在资源管理器里看到上述脚本与场景。

## 打开工程

用 **Cocos Creator 3.8.8**，**必须带 `--project`**：

```powershell
& "C:\ProgramData\cocos\editors\Creator\3.8.8\CocosCreator.exe" --project "D:\workspace\harExplore\cocos-projects\particle-player"
```

不要只把路径当位置参数传给 `CocosCreator.exe`，否则会弹出「推荐使用 Cocos Dashboard」对话框。

扩展：启用 `viewweaver`、`cocos-meta-mcp`。桥端口见 `%LOCALAPPDATA%\cocos-meta-mcp\instances.json`（勿写死 3921）。

## 父页约定

```js
// 父 → 子
{ type: 'particle', cmd: 'load', plistUrl, textureUrl, params? }
{ type: 'particle', cmd: 'play' | 'pause' | 'restart' | 'stop' }

// 子 → 父
{ type: 'particle', event: 'ready' | 'loaded' | 'error', message? }
```

## 构建产物

已构建并拷贝到 viewer：

- 工程产物：`cocos-projects/particle-player/build/web-mobile/`
- 查看器嵌入：`packages/web/viewer/particle-player/`

`npm run serve` 后打开「粒子预览」Tab；HAR 构建会写入 `particles/<tabId>/`。

重新改 Host 脚本后需在 Creator 再 Build web-mobile，并重新 robocopy 到 viewer 目录。
