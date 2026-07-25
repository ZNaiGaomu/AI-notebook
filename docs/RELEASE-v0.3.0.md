# AI 记录本 v0.3.0（第三版）

第三版发行：GitHub 多来源安装包切换、本地备份可恢复、语音路由增强、历史与界面打磨。

## 安装

1. 下载下方 **`ai-notebook-v0.3.0.zip`**（或仓库 `release/ai-notebook/`）
2. 解压得到 `manifest.json` / `main.js` / `styles.css`
3. 复制到：`<库>/.obsidian/plugins/ai-notebook/`
4. 启用社区插件「AI 记录本」（**更新时务必保留 `data.json`**）

也可使用 Tag 源码包：解压后**只**进入 `release/ai-notebook/` 再拷三文件。

## 相对 0.2.0 的主要变化

### 插件整体历史 = 可切换安装包

- **多行 GitHub 来源**（交互类似 AI 服务商）：自定义名称 + 仓库链接
- **按需拉取**（不默认同步、不静默改当前运行包）：
  1. GitHub Tags 页面（与网页 zip 按钮一致）
  2. jsDelivr 标签列表
  3. Releases API（有附件 zip 时）
  4. Tags API
  5. Code → Download ZIP（默认分支最新）
- **下载与切换**：写入 `package-archive/by-source/{sourceId}/vX.Y.Z/`；仅「使用此版本」才覆盖 `main.js` / `manifest.json` / `styles.css`
- **同版本号不同来源分开存**，避免互相覆盖

### 本地运行备份

- 「立即备份」后在历史页**列出卡片**，可一键切换回来
- 启动自动备份：若本地已有**当前版本**存档则跳过，避免冗余

### 本内功能历史

- 文案明确挂钩工具栏 **「另存蓝图版本」**
- 恢复仍生成新版本记录，不改笔记正文

### 语音与路由

- 录音格式协商、STT 多模型 fan-out、可选 WAV 转码
- 转写失败可 chat 听音频回退；转写后润色可开关
- 用途级路由（规划 / 助手 / 语音）继续增强

### 界面

- 仅一种视图时隐藏多余的「列表」标签
- 移除「快速捕获」按钮与命令（可用语音 / 助手 / 手机入口创建条目）

## 校验

- `npm test`：65 passed  
- `npm run package`：生成 `release/history/v0.3.0/` 与安装 zip  

## 链接

- 仓库：https://github.com/ZNaiGaomu/AI-notebook  
- 标签：`v0.3.0`  
- 完整说明：见仓库根目录 [README.md](https://github.com/ZNaiGaomu/AI-notebook/blob/main/README.md)
