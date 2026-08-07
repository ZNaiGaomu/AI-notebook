# AI 记录本 v0.8.0（第八版）

本版把「名字、附件、手机来源」三条身份线收紧：条目在资源管理器里改名时，附件树与对话上传会一起迁走；桌面语音不会再写成悬空路径；Android 最近页按记录本 → 条目下钻，打开文件只认唯一来源。

## 发布附件

- `ai-notebook-v0.8.0.zip`：Obsidian 插件安装包（`manifest.json` / `main.js` / `styles.css`）
- `suji-v0.8.0-preview.apk`：Android 10+ Preview（测试签名，侧载体验）
- `suji-v0.8.0-preview.apk.sha256`：APK 校验

> Tag 的 Source code 是完整源码，不是插件安装包。Android 工程在 `release/app/`。

## 插件改动

- 新增 `itemFolderSync`：条目 `items/*.md` 改名时编排附件索引、收藏柜、`chat-uploads`、未入索引残留目录。
- 同 `item_id` 历史标签（如 `66-66-66` / `666`）收敛到新名，不再为同一条目生成 `666-2`。
- `AttachmentService` / 语音指派 fail-closed：物理文件未确认存在前，不改 `audio_path` 与正文嵌入。
- 聊天历史中的 `vaultPath` 随路径 rewrites 更新；空的旧条目目录尽量清理。

## Android 改动

- 最近页三层导航：记录本一行 → 条目一行 → 该条目写入历史。
- 去掉顶部全局「选择 / 批量删除」；删除改到记录行右侧。
- 统一「打开文件」：优先 App 私有副本，否则校验后再开原始 URI。
- `clientSourceId` 精确匹配本地来源；无弱回退；可选 size / MIME 校验。

## 升级

插件只覆盖：

```text
manifest.json
main.js
styles.css
```

保留 `data.json`。Android 装新 APK 后重新测一次连接链接或二维码。

旧版 `v0.7.0` Release 仍保留，本版为 Latest。

## 验证

```bash
npm test
npm run package
npm run android:preview
```
