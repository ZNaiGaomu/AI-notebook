# AI 记录本 v0.4.0（第四版）

第四版重点解决两个实际使用问题：别人只安装 `release/ai-notebook` 时的新建记录本稳定性，以及用户在 Obsidian 文件树里手工创建内容后无法被插件识别为条目。同时新增 Tailscale 虚拟局域网手机入口。

## 安装

1. 下载 **`ai-notebook-v0.4.0.zip`**
2. 解压得到 `manifest.json` / `main.js` / `styles.css`
3. 复制到：`<库>/.obsidian/plugins/ai-notebook/`
4. 更新时保留同目录下的 `data.json`
5. 禁用再启用插件，或重启 Obsidian

也可以只复制仓库中的 `release/ai-notebook/` 三个运行文件。

## 新增与改进

### 手工条目自动吸收

- 在 `AI Notebooks/<记录本>/items/` 下手工新建 `.md`，刷新后自动补齐为 AI 记录本条目。
- 保留用户已有正文和 frontmatter，只补缺失的 `ai_notebook`、`notebook_id`、`item_id`、`schema_version`、`entity_type` 等字段。
- 标题优先取已有 `title`、Markdown 一级标题、文件名。
- 只处理 `items/` 直接子文件，不误处理 `blueprints/`、`cabinet/`、`_notebook.md` 或子目录内容。

### 非 Markdown 文件包装条目

- 图片、PDF、Canvas、白板等文件放入 `items/` 后，插件会自动生成一个 Markdown 条目引用原文件。
- 原始文件不被改写。
- 通过 `source_file_path` 去重，重复刷新不会生成多个包装条目。

### 新建记录本稳定性

- 新建记录本名称输入框改为独立原生输入，减少主题/布局影响。
- 默认填入模板名，用户不输入也可直接创建。
- 打开弹窗自动聚焦并选中名称。
- 支持回车创建。

### Tailscale 手机入口

- 手机和电脑登录同一个 Tailscale 后，可通过电脑 `100.x` 地址访问手机网页入口。
- Tailscale 可用时不自动拉 Cloudflare 隧道，减少等待。
- 普通同 Wi-Fi 局域网链接和 Cloudflare/ngrok 公网链接仍保留。

## 测试

本版新增并通过：

- `tests/manualItems.test.ts`
- `tests/createNotebookModal.test.ts`
- `tests/mobileBridge.test.ts` 中的 Tailscale 场景

全量测试：`23` 个测试文件，`74` 个测试通过。

## 链接

- 仓库：https://github.com/ZNaiGaomu/AI-notebook
- 标签：`v0.4.0`
