# baseAutoCocos

Cocos Creator **3.8.8** AI tooling base：只装扩展，不含试玩盘面 / MainUI 业务。

## Extensions

| 扩展 | 路径 | 作用 |
|------|------|------|
| [ViewWeaver](https://github.com/shinjiyu/ViewWeaver) | `extensions/viewweaver` | Prefab → typed View（`assets/scripts/views/`） |
| [CocosMetaMCP](https://github.com/shinjiyu/cocos_meta_mcp) | `extensions/cocos-meta-mcp` | Creator HTTP 桥（exec / refresh / 预览热更） |

Vendor 自 playableAdFramework 同源拷贝（无嵌套 `.git`）。试玩 frame 见 [SlotPlayableAdFrame](https://github.com/shinjiyu/SlotPlayableAdFrame)。

## Setup

1. 用 **Cocos Creator 3.8.8** 打开本工程  
2. 扩展管理器启用 `viewweaver`、`cocos-meta-mcp`  
3. 桥健康检查：`http://127.0.0.1:<port>/health` → `ok: true`（端口以 Creator 实例为准）

## Not included

- BoardStage / symbol-library / 默认盘面  
- MainUI / CTA 玩法 stub  
- mahjong overlay  

这些属于 ADFRAME（PA），不在本仓库。
