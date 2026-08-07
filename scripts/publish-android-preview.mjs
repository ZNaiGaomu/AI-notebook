import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apkArtifactName, assertCleanWorktree, validateVersions } from "./android-preview-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: options.capture ? "pipe" : "inherit",
		encoding: options.capture ? "utf8" : undefined,
		shell: process.platform === "win32",
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} 执行失败`);
	}
	return options.capture ? String(result.stdout || "").trim() : "";
}

async function main() {
	const requestedTag = process.argv[2];
	if (!requestedTag || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(requestedTag)) {
		throw new Error("用法：npm run android:publish -- vX.Y.Z");
	}
	const [packageJson, manifest] = await Promise.all([
		readFile(join(root, "package.json"), "utf8").then(JSON.parse),
		readFile(join(root, "manifest.json"), "utf8").then(JSON.parse),
	]);
	const version = validateVersions(packageJson.version, manifest.version, requestedTag.slice(1));
	assertCleanWorktree(run("git", ["status", "--porcelain"], { capture: true }));
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	run(npm, ["run", "android:preview"]);

	const apk = join(root, "release", "app", "dist", apkArtifactName(version));
	const hash = `${apk}.sha256`;
	if ((await stat(apk)).size <= 0 || (await stat(hash)).size <= 0) {
		throw new Error("Android 发布文件缺失或为空");
	}
	const tagCommit = run("git", ["rev-list", "-n", "1", requestedTag], { capture: true });
	const headCommit = run("git", ["rev-parse", "HEAD"], { capture: true });
	if (!tagCommit || tagCommit !== headCommit) {
		throw new Error(`${requestedTag} 未指向当前 HEAD，已拒绝上传`);
	}
	run("gh", ["release", "view", requestedTag]);
	run("gh", ["release", "upload", requestedTag, apk, hash, "--clobber"]);
	console.info(`已上传并替换 ${requestedTag} 的 Android Preview APK 与 SHA-256`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
