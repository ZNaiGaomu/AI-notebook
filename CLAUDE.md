# AI 记录本（本仓库）

## Obsidian 安装目录（必须同步）

用户从本路径把插件导入 / 覆盖到 Obsidian：

```
C:\Users\zn217\Desktop\obsidian插件开发\release\ai-notebook
```

该目录必须始终包含最新的 `main.js`、`styles.css`、`manifest.json`。

### 规则（每次改功能后都要遵守）

1. **任何功能更新（大/小）完成后**：确保 `release/ai-notebook` 已与项目根同步。
2. 优先跑 `npm run build`（esbuild 结束后会自动 `sync-release`）。
3. 若只改了 `styles.css` / `manifest.json` 而未跑完整 build：执行 `npm run sync:release`。
4. 不要只更新根目录 `main.js` 就结束会话——**release 未同步 = 用户 Obsidian 看不到更新**。
5. 发版/存档仍用 `npm run package`（会 build + 写入 release + history）。

### 命令

| 命令 | 作用 |
|------|------|
| `npm run build` | 类型检查 + 打包 + **自动同步** release |
| `npm run dev` | watch；每次 rebuild **自动同步** release |
| `npm run sync:release` | 仅复制 main.js / styles.css / manifest.json → release/ai-notebook |
| `npm run package` | 正式打包（含 history 版本存档） |
