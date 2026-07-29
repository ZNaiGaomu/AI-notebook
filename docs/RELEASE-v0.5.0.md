# AI 记录本 v0.5.0（第五版）

本版重点：**手机端定向写入**。手机网页现在可以选择记录本下的已有条目，把文字、语音转写、文件直接追加到该条目正文末尾；也可以在手机端新建记录本和命名条目。

## 新增能力

| 能力 | 说明 |
|------|------|
| 手机端选择已有条目 | 选择记录本后加载该本条目列表，选择已有条目后发送内容会追加到正文末尾 |
| 手机端新建记录本 | 在手机网页输入名称并选择模板，创建后电脑端 Obsidian 同步可见 |
| 手机端新建命名条目 | 在所选记录本下创建有标题的条目，创建后自动选中 |
| 保留原有新建条目行为 | 只选记录本、不选已有条目时，发送内容仍会创建新条目 |
| 待发送队列保留目标 | 离线缓存会保存当时的记录本与条目目标，稍后发送不会因当前选择变化而写错位置 |

## 手机端行为

- **选择记录本 + 新建条目**：发送文字 / 语音 / 文件会在该记录本下创建新条目。
- **选择记录本 + 已有条目**：发送文字 / 语音转写 / 文件会追加到该条目的 Markdown 正文末尾。
- **新建记录本**：支持空白、文献、灵感、会议、收藏向模板。
- **新建条目**：可输入条目标题和可选初始正文。

## 技术改动

- `MobileBridgeServer` 新增：
  - `GET /api/items`
  - `POST /api/items`
  - `POST /api/notebooks`
- `/api/text`、`/api/voice`、`/api/file` 支持 `item_id` 追加写入。
- `ItemService` 新增按 `item_id` 查找与追加正文能力。
- 手机端 HTML/JS 增加记录本创建、条目选择、条目创建、队列目标保存。

## 验证

已验证：

```bash
npm test -- --run tests/mobileBridge.test.ts tests/mobileBridge.live.test.ts
npm run build
```

发布时请运行：

```bash
npm test
npm run package
```

## 安装

仍然只需要安装 / 覆盖：

```text
release/ai-notebook/manifest.json
release/ai-notebook/main.js
release/ai-notebook/styles.css
```

覆盖更新时不要删除 Obsidian 插件目录里的 `data.json`。
