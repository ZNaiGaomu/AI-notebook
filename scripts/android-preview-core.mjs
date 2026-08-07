import { basename } from "node:path";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function apkArtifactName(version) {
	if (!VERSION_PATTERN.test(String(version))) {
		throw new Error(`Android 版本号格式无效：${version}`);
	}
	return `suji-v${version}-preview.apk`;
}

export function parseAndroidVersion(source) {
	const versionName = source.match(/versionName\s*=\s*"([^"]+)"/)?.[1];
	const versionCodeRaw = source.match(/versionCode\s*=\s*(\d+)/)?.[1];
	if (!versionName || !versionCodeRaw) {
		throw new Error("无法从 app/build.gradle.kts 读取 Android 版本");
	}
	return { versionName, versionCode: Number(versionCodeRaw) };
}

export function validateVersions(packageVersion, manifestVersion, androidVersion) {
	const versions = [packageVersion, manifestVersion, androidVersion].map(String);
	if (new Set(versions).size !== 1) {
		throw new Error(
			`版本不一致：package=${versions[0]} manifest=${versions[1]} android=${versions[2]}`,
		);
	}
	apkArtifactName(versions[0]);
	return versions[0];
}

export function parseLocalProperties(source) {
	const raw = source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.startsWith("sdk.dir="))
		?.slice("sdk.dir=".length);
	if (!raw) throw new Error("local.properties 未配置 sdk.dir");
	return { sdkDir: raw.replace(/\\:/g, ":").replace(/\\\\/g, "\\") };
}

export function parseBadging(output) {
	const packageLine = output.match(
		/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/,
	);
	if (!packageLine) throw new Error("无法读取 APK 包名和版本信息");
	return {
		applicationId: packageLine[1],
		versionCode: Number(packageLine[2]),
		versionName: packageLine[3],
	};
}

export function parseSignerSha256(output) {
	const digest = output.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)/i)?.[1];
	if (!digest) throw new Error("无法读取 APK 签名证书 SHA-256");
	return digest.replace(/:/g, "").toLowerCase();
}

export function assertCleanWorktree(status) {
	if (String(status).trim()) {
		throw new Error("Git 工作区存在未提交改动，已拒绝上传与 Tag 不一致的 APK");
	}
}

export function sha256Line(hash, apkPath) {
	return `${hash.toLowerCase()}  ${basename(apkPath)}\n`;
}
