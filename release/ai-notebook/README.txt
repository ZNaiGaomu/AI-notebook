AI 记录本 (ai-notebook) — 安装包 v0.3.0

【安装 / 更新】
把整个 ai-notebook 文件夹复制到：
  <你的库>\.obsidian\plugins\

示例：
  C:\obsidian-profile\AI-notebook\.obsidian\plugins\ai-notebook\

完成后应有：
  manifest.json
  main.js
  styles.css

【启用】
Obsidian → 设置 → 社区插件 → 关闭受限模式 → 启用「AI 记录本」

【版本存档】
开发打包时同时写入：
  release/history/v0.3.0/

插件运行时也会把当前包自动备份到：
  .obsidian/plugins/ai-notebook/package-archive/v0.3.0/

在「历史版本 → 插件整体历史」中，若本地有存档，可一键切换（覆盖 main.js 等，不碰 data.json 与笔记）。
切换后请禁用再启用插件，或重启 Obsidian。

【注意】
- 覆盖更新时不要删除库内该目录下的 data.json（API Key 等本机配置）
- 本文件夹仅含运行文件；源码在项目根目录
