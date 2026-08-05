# AI 记录本 v0.6.0（第六版）

本版重点：**独立附件管理**、**按条目标题组织附件目录**、**收件箱跨本整理**，以及 **整理后媒体可预览**。

## 新增 / 重要能力

| 能力 | 说明 |
|------|------|
| 独立附件管理 | 普通上传不再进收藏柜；附件有独立索引与「附件」页签 |
| 标题化附件目录 | `attachments/ai-notebook/{记录本标题}/items/{条目标题}/…` |
| 改名同步 | 条目改标题后，附件文件夹名跟随，并尽量修正正文 `![[旧路径]]` |
| 粘贴/拖入归类 | 条目正文内粘贴、拖入的媒体会吸入该条目附件目录 |
| 删除互不影响 | 默认解除附件登记保留文件与正文；删正文不删附件实体 |
| 收件箱跨本整理 | 可选目标记录本、已有条目或新建条目 |
| 收件箱媒体 | 仅收件箱也会保存原文件；整理后可看图/视频/听音频 |

## 产品边界（本版定型）

| 功能 | 职责 |
|------|------|
| 附件 | 分类保存与管理文件 |
| 正文嵌入 | 直接观看；与附件删除互不影响 |
| 收藏柜 | 可选收藏（链接 / 主动收藏） |
| 收件箱 | 独立暂存与跨本整理入口 |

## 技术改动摘要

- 新增 `AttachmentService`、`notebook attachments/index.json`
- `structuredAttachmentsDir` 改为标题可读路径
- 手机 `/api/file`：普通上传 → 附件 + 正文嵌入；`organize:false` → `dumpBinary`
- `InboxService`：`dumpBinary`、目标条目追加、媒体吸入附件
- 条目改名 / vault 修改监听：附件目录同步与 embed 吸收
- 收藏柜仅保留可选收藏语义

## 验证

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
