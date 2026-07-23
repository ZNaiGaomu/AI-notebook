# AI 记录本（ai-notebook）

AI 记录本是一个面向 Obsidian 的本地优先插件，用「可版本化能力蓝图（Blueprint）」来定义记录本能力：同一个插件可以创建多个不同类型的 AI 记录本，条目以 Markdown 文件独立存储，功能版本回滚不会改写用户数据。

> 当前版本：`0.1.1`  
> 插件 ID：`ai-notebook`  
> 规格文档：[`docs/V1-蓝图定稿.md`](docs/V1-蓝图定稿.md)

## 主要特性

- **多实例记录本**：每本记录本有独立目录、蓝图版本、条目和收藏柜。
- **模板快速开始**：内置文献、灵感、会议、收藏向、空白模板。
- **Markdown 数据存储**：条目写入 `items/*.md`，可被 Obsidian 原生搜索、同步、备份。
- **可版本化蓝图**：记录本功能由 `blueprints/vNNNN.json` 驱动，可提交、恢复、Diff 确认。
- **AI 改功能**：用自然语言生成新蓝图，校验通过并确认 Diff 后才生效。
- **AI 结构化整理**：把杂乱文本、收件箱内容或语音转写整理为字段 + 分层正文。
- **收藏柜**：支持链接与文件归档，条目可关联收藏柜资源。
- **语音录入**：支持 OpenAI-compatible `/audio/transcriptions` 转写接口。
- **手机入口**：支持同步收件箱、同 Wi‑Fi 网页入口、Cloudflare/ngrok 公网隧道入口。
- **本地密钥**：API Key 仅保存在 Obsidian 插件 `data.json`，不写入 vault 笔记。

## 当前进度

| 阶段 | 状态 |
|------|------|
| P0 多实例、模板、条目 CRUD、List + 详情、Provider 设置 | ✅ |
| P1 蓝图校验、版本提交/恢复、未映射字段、Diff 确认 | ✅ |
| 蓝图运行时 onCreate 钩子、列表排序筛选、table/board 视图 | ✅ |
| P2 语言改功能（AI 产蓝图 + 每次 Diff 确认） | ✅ |
| P3 收藏柜 links/files | ✅ |
| P4 语音转写录入（可启停 + transcriptions API） | ✅ |
| 跨端收件箱：手机 → AI Inbox/pending → AI 整理 → 记录本 | ✅ |
| AI 结构化：杂乱信息 → 字段 + 分层正文 | ✅ |
| 手机网页入口：电脑生成链接，写字/语音回传 | ✅ |
| 任意网络链接：Cloudflare/ngrok 公网隧道 | ✅ |

## 快速安装

### 方式一：使用本仓库 release 目录

项目内已提供可复制的插件运行目录：

```text
release/ai-notebook/
  manifest.json
  main.js
  styles.css
  README.txt
```

将整个 `release/ai-notebook` 文件夹复制到目标库的插件目录：

```text
<你的 Obsidian 库>/.obsidian/plugins/ai-notebook/
```

Windows 示例：

```text
C:\obsidian-profile\AI-notebook\.obsidian\plugins\ai-notebook\
```

然后在 Obsidian 中：

1. 设置 → 社区插件 → 关闭受限模式。
2. 启用「AI 记录本」。
3. 如需 AI 功能，到插件设置里配置 Provider。

> 更新插件时可以覆盖 `manifest.json`、`main.js`、`styles.css`。不要删除目标目录里的 `data.json`，其中可能包含本机 API Key 和设置。

### 方式二：从源码构建

```bash
npm install
npm run build
npm run package
```

打包产物会生成到：

```text
release/ai-notebook/
release/history/v<version>/
```

## 使用速览

1. 点击左侧 Ribbon「AI 记录本」，或使用命令面板。
2. 执行 `AI 记录本: 新建记录本`，选择模板。
3. 在记录本中快速捕获、编辑字段、查看列表和详情。
4. 如需调整功能，使用 `AI 记录本: 用语言改功能`，确认 Diff 后生效。
5. 手机内容可通过 `AI Inbox/pending/`、局域网网页入口或公网隧道写回电脑端库。

常用命令：

| 命令 | 说明 |
|------|------|
| `AI 记录本: 打开 AI 记录本` | 打开上次使用的记录本或选择记录本 |
| `AI 记录本: 新建记录本` | 从模板创建新记录本 |
| `AI 记录本: 选择并打开记录本` | 在已有记录本中切换 |
| `AI 记录本: 快速捕获（当前记录本）` | 向当前记录本新增条目 |
| `AI 记录本: 用语言改功能` | 使用 AI 生成并提交新蓝图版本 |
| `AI 记录本: 手机速记（写入收件箱）` | 手机/移动端快速写入收件箱 |
| `AI 记录本: 处理收件箱（AI 整理）` | 将收件箱内容整理进记录本 |
| `AI 记录本: 初始化手机收件箱文件夹` | 创建移动端收件箱目录 |
| `AI 记录本: AI 整理当前条目` | 对当前条目做结构化整理 |
| `AI 记录本: 语音录入到记录本` | 录音、转写并写入记录本 |
| `AI 记录本: 诊断语音转写能力` | 检查 Provider 是否支持转写 |
| `AI 记录本: 显示手机网页入口链接` | 生成同 Wi‑Fi 手机网页入口 |
| `AI 记录本: 启动手机网页入口` | 启动本地网页写入服务 |
| `AI 记录本: 停止手机网页入口` | 停止本地网页写入服务 |
| `AI 记录本: 生成任意网络可打开的手机链接` | 通过 Cloudflare/ngrok 生成公网入口 |

## 配置 AI Provider

插件支持 OpenAI-compatible 接口。每个 Provider Profile 通常包含：

- 名称
- Base URL，例如 `https://api.openai.com/v1` 或其他兼容服务地址
- API Key
- 可用模型列表
- 默认模型

用途路由：

| purpose | 用途 |
|---------|------|
| `planner` | 用语言改功能、生成蓝图 |
| `worker` | 字段抽取、整理、助手 |
| `voice` | 语音转写 |

隐私原则：默认只发送完成任务所需的最小上下文；本内 top-k、当前笔记全文等上下文需要显式开启。

## Vault 目录约定

默认目录如下，可在插件设置中调整：

```text
AI Notebooks/{记录本名称}/
  _notebook.md
  blueprints/
    index.json
    v0001.json
    v0002.json
  items/
    2026-07-19-a1b2c3.md
  cabinet/
    links.json
    files.json
  .trash/

attachments/ai-notebook/{notebook_id}/

AI Inbox/
  pending/
  processed/
  voice-raw/
```

说明：

- `_notebook.md` 保存记录本元数据和当前蓝图版本。
- `blueprints/` 保存历史功能版本。
- `items/` 保存条目 Markdown。
- `.trash/` 用于软删除。
- `attachments/ai-notebook/` 保存导入文件。
- `AI Inbox/` 用于手机跨端投递和语音原文备份。

## 手机与跨端入口

- 手机同步收件箱：见 [`docs/手机跨端与AI整理.md`](docs/手机跨端与AI整理.md)
- 同 Wi‑Fi 网页入口：见 [`docs/手机网页入口.md`](docs/手机网页入口.md)
- 任意网络公网入口：见 [`docs/任意网络网页入口.md`](docs/任意网络网页入口.md)

安全提醒：公网入口链接带 token，但泄漏后别人可能向你的 vault 写入内容。不使用时请停止手机网页入口，不要把本地端口裸露映射到公网。

## 开发

建议始终使用独立测试 vault，不要在主力 vault 中直接开发。

```bash
npm install
npm run dev       # 开发构建，监听变化
npm run build     # TypeScript 检查 + 生产构建
npm test          # Vitest 自动化测试
npm run package   # 构建并生成 release/ai-notebook
```

项目结构：

```text
src/
  bridge/       # 手机网页入口与本地服务
  domain/       # 类型、蓝图 schema、模板、设置默认值
  infra/        # Vault IO、frontmatter、HTTP、音频等基础设施
  runtime/      # 蓝图运行时、列表查询
  services/     # 记录本、条目、版本、AI、收藏柜、语音等业务服务
  ui/           # Obsidian UI、Modal、SettingTab、View
tests/          # Vitest 测试
scripts/        # 打包脚本
docs/           # 产品规格与使用说明
release/        # 可安装产物与历史包
```

更多工程约定见 [`docs/开发与发布.md`](docs/开发与发布.md)。

## 测试

```bash
npm test
```

测试覆盖内容包括 frontmatter、蓝图 schema、schema migrator、AI 整理、收件箱、Provider 导入、HookRunner、列表查询、收藏柜、插件历史、移动网页桥等。测试使用 memory vault 冒烟，不依赖 Obsidian GUI。

## 安全原则

- API Key 只存在本机插件 `data.json`。
- 脱敏导出不会带出 API Key。
- 蓝图必须通过严格校验，失败不应用。
- action、hook step、field type 均使用白名单。
- 删除默认软删除到 `.trash`。
- AI 改功能必须先展示 Diff，并由用户确认。
- 不默认上传全库内容。
- 禁止 AI 生成或热替换插件 JS 代码。

## 许可证

MIT。详见 [`LICENSE`](LICENSE)。
