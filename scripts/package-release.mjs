/**
 * Build plugin and copy runtime files into:
 *   release/ai-notebook/          — current install folder
 *   release/history/vX.Y.Z/       — versioned archive (kept for rollback)
 */
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "release", "ai-notebook");

const build = spawnSync(
	process.platform === "win32" ? "npm.cmd" : "npm",
	["run", "build"],
	{ cwd: root, stdio: "inherit", shell: true },
);
if (build.status !== 0) {
	process.exit(build.status ?? 1);
}

const manifest = JSON.parse(
	await readFile(join(root, "manifest.json"), "utf8"),
);
const version = String(manifest.version || "0.0.0");
const historyDir = join(root, "release", "history", `v${version}`);

await mkdir(outDir, { recursive: true });
await mkdir(historyDir, { recursive: true });

for (const file of ["manifest.json", "main.js", "styles.css"]) {
	await copyFile(join(root, file), join(outDir, file));
	await copyFile(join(root, file), join(historyDir, file));
}

const readme = `AI 记录本 (ai-notebook) — 安装包 v${version}

【安装 / 更新】
把整个 ai-notebook 文件夹复制到：
  <你的库>\\.obsidian\\plugins\\

示例：
  C:\\obsidian-profile\\AI-notebook\\.obsidian\\plugins\\ai-notebook\\

完成后应有：
  manifest.json
  main.js
  styles.css

【启用】
Obsidian → 设置 → 社区插件 → 关闭受限模式 → 启用「AI 记录本」

【版本存档】
开发打包时同时写入：
  release/history/v${version}/

插件运行时也会把当前包自动备份到：
  .obsidian/plugins/ai-notebook/package-archive/v${version}/

在「历史版本 → 插件整体历史」中，若本地有存档，可一键切换（覆盖 main.js 等，不碰 data.json 与笔记）。
切换后请禁用再启用插件，或重启 Obsidian。

【注意】
- 覆盖更新时不要删除库内该目录下的 data.json（API Key 等本机配置）
- 本文件夹仅含运行文件；源码在项目根目录
`;

await writeFile(join(outDir, "README.txt"), readme, "utf8");
await writeFile(
	join(historyDir, "README.txt"),
	`AI 记录本 历史安装包 v${version}\n打包时间: ${new Date().toISOString()}\n\n可整夹覆盖到 plugins/ai-notebook，或复制到 package-archive/v${version}/ 供应用内切换。\n`,
	"utf8",
);

// catalog of history packages
const catalogPath = join(root, "release", "history", "CATALOG.md");
let catalog = "";
try {
	catalog = await readFile(catalogPath, "utf8");
} catch {
	catalog = `# AI 记录本 — release/history 目录\n\n每次 \`npm run package\` 会追加一行。\n\n| 版本 | 路径 |\n|------|------|\n`;
}
const line = `| ${version} | release/history/v${version}/ |`;
if (!catalog.includes(`| ${version} |`)) {
	catalog = catalog.trimEnd() + `\n${line}\n`;
	await writeFile(catalogPath, catalog, "utf8");
}

console.log(`Packaged → ${outDir}`);
console.log(`Archived  → ${historyDir}`);
