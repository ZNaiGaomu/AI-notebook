import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	apkArtifactName,
	parseAndroidVersion,
	parseBadging,
	parseLocalProperties,
	parseSignerSha256,
	sha256Line,
	validateVersions,
} from "./android-preview-core.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = join(root, "release", "app");
const appGradle = join(androidRoot, "app", "build.gradle.kts");
const distDir = join(androidRoot, "dist");
const candidateDir = join(androidRoot, "app", "build", "preview-candidate");
const expectedApplicationId = "com.gaomu.suji.workshop";

function run(command, args, options = {}) {
	const needsShell = process.platform === "win32" && /\.(?:bat|cmd)$/i.test(command);
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? root,
		stdio: options.capture ? "pipe" : "inherit",
		encoding: options.capture ? "utf8" : undefined,
		shell: needsShell,
		env: { ...process.env, ...options.env },
	});
	if (result.status !== 0) {
		const detail = options.capture ? `\n${result.stderr || result.stdout || ""}` : "";
		throw new Error(`${command} ${args.join(" ")} 执行失败${detail}`);
	}
	return options.capture ? String(result.stdout || "") : "";
}

async function findBuildTool(sdkDir, executable) {
	const versions = await readdir(join(sdkDir, "build-tools"), { withFileTypes: true });
	const sorted = versions.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	const suffixes = process.platform === "win32" ? [".exe", ".bat", ""] : [""];
	for (const version of sorted) {
		for (const suffix of suffixes) {
			const path = join(sdkDir, "build-tools", version, `${executable}${suffix}`);
			if (await stat(path).then(() => true).catch(() => false)) return path;
		}
	}
	throw new Error(`Android SDK 中找不到 ${executable}`);
}

async function sha256(path) {
	const bytes = await readFile(path);
	return createHash("sha256").update(bytes).digest("hex");
}

async function cleanLegacyApks(keepName) {
	const entries = await readdir(distDir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (entry.name === keepName || entry.name === `${keepName}.sha256`) continue;
		if (entry.name.toLowerCase().endsWith(".apk") || entry.name.toLowerCase().endsWith(".apk.sha256")) {
			await rm(join(distDir, entry.name), { force: true });
		}
	}
}

async function replaceVerifiedArtifact(stagedApk, stagedHash, finalApk) {
	const finalHash = `${finalApk}.sha256`;
	const backupApk = `${finalApk}.previous`;
	const backupHash = `${finalHash}.previous`;
	const hadApk = await stat(finalApk).then(() => true).catch(() => false);
	const hadHash = await stat(finalHash).then(() => true).catch(() => false);
	await rm(backupApk, { force: true });
	await rm(backupHash, { force: true });
	try {
		if (hadApk) await rename(finalApk, backupApk);
		if (hadHash) await rename(finalHash, backupHash);
		await copyFile(stagedApk, finalApk);
		await copyFile(stagedHash, finalHash);
		await rm(backupApk, { force: true });
		await rm(backupHash, { force: true });
	} catch (error) {
		await rm(finalApk, { force: true });
		await rm(finalHash, { force: true });
		if (hadApk) await rename(backupApk, finalApk);
		if (hadHash) await rename(backupHash, finalHash);
		throw error;
	}
}

async function main() {
	const [packageJson, manifest, gradleSource, localProperties] = await Promise.all([
		readFile(join(root, "package.json"), "utf8").then(JSON.parse),
		readFile(join(root, "manifest.json"), "utf8").then(JSON.parse),
		readFile(appGradle, "utf8"),
		readFile(join(androidRoot, "local.properties"), "utf8"),
	]);
	const androidVersion = parseAndroidVersion(gradleSource);
	const version = validateVersions(packageJson.version, manifest.version, androidVersion.versionName);
	const artifactName = apkArtifactName(version);
	const finalApk = join(distDir, artifactName);
	const stagedApk = join(candidateDir, artifactName);
	const gradle = join(androidRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew");
	const javaHome = process.env.JAVA_HOME || "C:\\Program Files\\Microsoft\\jdk-17.0.20.8-hotspot";

	await rm(candidateDir, { recursive: true, force: true });
	await mkdir(distDir, { recursive: true });

	run(gradle, ["clean", "compilePreviewUnitTestKotlin", "lintPreview", "assemblePreview"], {
		cwd: androidRoot,
		env: { JAVA_HOME: javaHome },
	});

	await mkdir(candidateDir, { recursive: true });
	const gradleApk = join(androidRoot, "app", "build", "outputs", "apk", "preview", "app-preview.apk");
	await copyFile(gradleApk, stagedApk);
	if ((await stat(stagedApk)).size <= 0) throw new Error("候选 APK 为空");

	const { sdkDir } = parseLocalProperties(localProperties);
	const aapt = await findBuildTool(sdkDir, "aapt");
	const apksigner = await findBuildTool(sdkDir, "apksigner");
	const verificationDir = await mkdtemp(join(tmpdir(), "suji-apk-"));
	const verificationApk = join(verificationDir, artifactName);
	let badging;
	try {
		await copyFile(stagedApk, verificationApk);
		badging = parseBadging(run(aapt, ["dump", "badging", verificationApk], { capture: true, env: { JAVA_HOME: javaHome } }));
		if (badging.applicationId !== expectedApplicationId || badging.versionName !== version || badging.versionCode !== androidVersion.versionCode) {
			throw new Error(`APK 元数据不匹配：${JSON.stringify(badging)}`);
		}
		const signatureOutput = run(apksigner, ["verify", "--verbose", "--print-certs", verificationApk], { capture: true, env: { JAVA_HOME: javaHome } });
		const keytool = join(javaHome, "bin", process.platform === "win32" ? "keytool.exe" : "keytool");
		const debugKeystore = process.env.ANDROID_DEBUG_KEYSTORE || join(process.env.USERPROFILE || process.env.HOME || "", ".android", "debug.keystore");
		const keyOutput = run(keytool, ["-list", "-v", "-keystore", debugKeystore, "-alias", "androiddebugkey", "-storepass", "android"], { capture: true, env: { JAVA_HOME: javaHome } });
		const expectedDigest = keyOutput.match(/SHA256:\s*([0-9A-F:]+)/i)?.[1]?.replace(/:/g, "").toLowerCase();
		if (!expectedDigest || parseSignerSha256(signatureOutput) !== expectedDigest) {
			throw new Error("APK 签名证书不是当前 Preview 测试证书");
		}
	} finally {
		await rm(verificationDir, { recursive: true, force: true });
	}

	const hash = await sha256(stagedApk);
	const stagedHash = `${stagedApk}.sha256`;
	await writeFile(stagedHash, sha256Line(hash, stagedApk), "utf8");

	await replaceVerifiedArtifact(stagedApk, stagedHash, finalApk);
	await cleanLegacyApks(artifactName);
	await rm(candidateDir, { recursive: true, force: true });
	await rm(join(androidRoot, "app", "build", "outputs", "apk"), { recursive: true, force: true });

	console.info(`Android Preview 已生成：${finalApk}`);
	console.info(`SHA-256：${hash}`);
	console.info(`包名：${badging.applicationId}，版本：${badging.versionName} (${badging.versionCode})`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
