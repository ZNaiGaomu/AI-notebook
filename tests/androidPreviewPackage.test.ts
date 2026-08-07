import { describe, expect, it } from "vitest";
import {
	apkArtifactName,
	assertCleanWorktree,
	parseAndroidVersion,
	parseLocalProperties,
	parseSignerSha256,
	validateVersions,
} from "../scripts/android-preview-core.mjs";

describe("Android preview packaging", () => {
	it("builds the canonical versioned APK name", () => {
		expect(apkArtifactName("0.7.0")).toBe("suji-v0.7.0-preview.apk");
		expect(() => apkArtifactName("0.7 beta")).toThrow(/版本号/);
	});

	it("reads Android version metadata from Gradle", () => {
		const source = `
			defaultConfig {
				versionCode = 7
				versionName = "0.7.0"
			}
		`;
		expect(parseAndroidVersion(source)).toEqual({
			versionCode: 7,
			versionName: "0.7.0",
		});
	});

	it("rejects version drift before building", () => {
		expect(() => validateVersions("0.7.0", "0.7.0", "0.6.0")).toThrow(
			/版本不一致/,
		);
		expect(validateVersions("0.7.0", "0.7.0", "0.7.0")).toBe("0.7.0");
	});

	it("decodes the Android SDK path from local.properties", () => {
		expect(
			parseLocalProperties("sdk.dir=C\\:\\Users\\zn217\\AppData\\Local\\Android\\Sdk\n"),
		).toEqual({ sdkDir: "C:\\Users\\zn217\\AppData\\Local\\Android\\Sdk" });
	});

	it("reads and normalizes the signer certificate digest", () => {
		expect(
			parseSignerSha256("Signer #1 certificate SHA-256 digest: AA:BB:0C"),
		).toBe("aabb0c");
	});

	it("rejects publishing from a dirty worktree", () => {
		expect(() => assertCleanWorktree(" M src/main.ts\n")).toThrow(/未提交改动/);
		expect(() => assertCleanWorktree("\n")).not.toThrow();
	});
});
