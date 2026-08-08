# AI 记录本 v0.8.1（第八版.1）

小更新：修好「插件整体历史」里从 GitHub 拉安装包 / 切换版本的体验。  
**产品主线与 0.8.0 相同**，介绍文案见 [`RELEASE-v0.8.0.md`](./RELEASE-v0.8.0.md) 与仓库 README。

## 发布附件

- `ai-notebook-v0.8.1.zip`：Obsidian 插件安装包（`manifest.json` / `main.js` / `styles.css`）
- Android Preview APK：**与 v0.8.0 相同**（hash 一致，未改 App 代码）；请从 [v0.8.0 Release](https://github.com/ZNaiGaomu/AI-notebook/releases/tag/v0.8.0) 下载 `suji-v0.8.0-preview.apk`

> Tag 的 Source code 是完整源码，不是插件安装包。

## 本版改动（插件）

- **Release / Tags 分列表**：每个 GitHub 来源内分开拉取、分开点开；Release 优先换插件三文件，Tags 作源码备选。
- **Release 拉取兜底**：API 403 时仍尝试 Releases 网页解析与 `ai-notebook-*.zip` 附件探测，避免「仓库有包却拉到 0 个」。
- **Tags「打开标签页」**：打开 `…/tree/vX.Y.Z`（标签源码树），不再误进 `…/releases/tag/…` 发布说明页。
- **当前版本说明**：本机正在运行 = 已加载 manifest；远程列表 ≠ 已安装；本页「已应用」单独标记。
- **切换前强制备份**：备份失败则中止覆盖；失败时可回「本地运行备份」。

## 升级

只覆盖：

```text
manifest.json
main.js
styles.css
```

保留 `data.json`。Android 无需重装（与 0.8.0 同包）。

## 验证

```bash
npm test
npm run package
```
