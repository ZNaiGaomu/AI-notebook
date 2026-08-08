import { describe, expect, it } from "vitest";
import { normalizeSettings } from "../src/domain/settingsDefaults";
import { recordRollbackIntent } from "../src/services/pluginHistoryStore";
import {
	githubTagBrowseUrl,
	githubTagsListUrl,
	parseGithubRepoUrl,
} from "../src/services/githubReleaseService";
import { pickPluginRuntimeFiles, type ZipEntry } from "../src/infra/zipUtil";

describe("plugin package history — split Release/Tags + safety", () => {
	it("parseGithubRepoUrl accepts common forms", () => {
		const a = parseGithubRepoUrl("https://github.com/ZNaiGaomu/AI-notebook");
		expect("error" in a).toBe(false);
		if (!("error" in a)) {
			expect(a.owner).toBe("ZNaiGaomu");
			expect(a.repo).toBe("AI-notebook");
		}
		const b = parseGithubRepoUrl("ZNaiGaomu/AI-notebook");
		expect("error" in b).toBe(false);
	});

	it("Tags browse URL points at tree/tag, not releases/tag", () => {
		const url = githubTagBrowseUrl("ZNaiGaomu", "AI-notebook", "v0.8.0");
		expect(url).toBe("https://github.com/ZNaiGaomu/AI-notebook/tree/v0.8.0");
		expect(url).not.toContain("/releases/tag/");
		expect(githubTagsListUrl("ZNaiGaomu", "AI-notebook")).toBe(
			"https://github.com/ZNaiGaomu/AI-notebook/tags",
		);
	});

	it("migrates legacy mixed cachedReleases into separate Release / Tags caches", () => {
		const raw = {
			schemaVersion: 1,
			pluginHistory: {
				lastSeenCapabilityId: null,
				preferredPluginVersion: null,
				userNotes: [],
				appliedPackage: null,
				sources: [
					{
						id: "src-1",
						name: "高木",
						repoUrl: "https://github.com/ZNaiGaomu/AI-notebook",
						owner: "ZNaiGaomu",
						repo: "AI-notebook",
						lastFetchedAt: "2026-08-07T12:00:00.000Z",
						cachedReleases: [
							{
								version: "0.8.0",
								tagName: "v0.8.0",
								name: "v0.8.0",
								publishedAt: "",
								body: "Tags 页面 zip",
								downloadUrl:
									"https://github.com/ZNaiGaomu/AI-notebook/archive/refs/tags/v0.8.0.zip",
								htmlUrl:
									"https://github.com/ZNaiGaomu/AI-notebook/releases/tag/v0.8.0",
								fetchChannel: "tags",
								fetchChannelLabel: "Tags 源码包",
							},
							{
								version: "0.7.0",
								tagName: "v0.7.0",
								name: "v0.7.0",
								publishedAt: "",
								body: "Tags",
								downloadUrl:
									"https://github.com/ZNaiGaomu/AI-notebook/archive/refs/tags/v0.7.0.zip",
								htmlUrl:
									"https://github.com/ZNaiGaomu/AI-notebook/releases/tag/v0.7.0",
								fetchChannel: "tags",
								fetchChannelLabel: "Tags 源码包",
							},
						],
					},
				],
			},
		};
		const settings = normalizeSettings(raw);
		const src = settings.pluginHistory.sources[0]!;
		expect(src.cachedTags.length).toBe(2);
		expect(src.cachedReleases.length).toBe(0);
		expect(src.cachedTags.every((r) => r.fetchChannel === "tags")).toBe(true);
	});

	it("keeps explicit Release and Tags lists separate when both present", () => {
		const raw = {
			pluginHistory: {
				sources: [
					{
						id: "src-2",
						name: "官方",
						repoUrl: "https://github.com/ZNaiGaomu/AI-notebook",
						owner: "ZNaiGaomu",
						repo: "AI-notebook",
						lastFetchedAt: null,
						lastFetchedReleaseAt: "2026-08-07T12:00:00.000Z",
						lastFetchedTagsAt: "2026-08-07T12:01:00.000Z",
						cachedReleases: [
							{
								version: "0.8.0",
								tagName: "v0.8.0",
								name: "v0.8.0",
								publishedAt: "2026-08-07T10:00:00.000Z",
								body: "release notes",
								downloadUrl:
									"https://github.com/ZNaiGaomu/AI-notebook/releases/download/v0.8.0/ai-notebook-v0.8.0.zip",
								htmlUrl:
									"https://github.com/ZNaiGaomu/AI-notebook/releases/tag/v0.8.0",
								fetchChannel: "release",
								fetchChannelLabel: "Release 附件",
							},
						],
						cachedTags: [
							{
								version: "0.6.0",
								tagName: "v0.6.0",
								name: "v0.6.0",
								publishedAt: "",
								body: "tag",
								downloadUrl:
									"https://github.com/ZNaiGaomu/AI-notebook/archive/refs/tags/v0.6.0.zip",
								htmlUrl: "https://github.com/ZNaiGaomu/AI-notebook/tree/v0.6.0",
								fetchChannel: "tags",
								fetchChannelLabel: "Tags 源码包",
							},
						],
					},
				],
			},
		};
		const settings = normalizeSettings(raw);
		const src = settings.pluginHistory.sources[0]!;
		expect(src.cachedReleases.map((r) => r.version)).toEqual(["0.8.0"]);
		expect(src.cachedTags.map((r) => r.version)).toEqual(["0.6.0"]);
		expect(src.lastFetchedReleaseAt).toBe("2026-08-07T12:00:00.000Z");
		expect(src.lastFetchedTagsAt).toBe("2026-08-07T12:01:00.000Z");
	});

	it("recordRollbackIntent text mentions reload and local backup, not manual folder replace", () => {
		const base = normalizeSettings({});
		const next = recordRollbackIntent(base, "0.8.0");
		const note = next.pluginHistory.userNotes.find(
			(n) => n.kind === "rollback-intent",
		);
		expect(note?.text).toContain("0.8.0");
		expect(note?.text).toMatch(/禁用再启用|重启/);
		expect(note?.text).toContain("本地运行备份");
		expect(note?.text).not.toContain("需手动替换 release 文件夹");
	});

	it("pickPluginRuntimeFiles prefers release/ai-notebook over history copies", () => {
		const enc = (s: string) => new TextEncoder().encode(s);
		const entries: ZipEntry[] = [
			{
				name: "AI-notebook-0.8.0/release/history/v0.1.1/main.js",
				data: enc("OLD_MAIN"),
			},
			{
				name: "AI-notebook-0.8.0/release/history/v0.1.1/manifest.json",
				data: enc('{"id":"ai-notebook","version":"0.1.1"}'),
			},
			{
				name: "AI-notebook-0.8.0/release/ai-notebook/main.js",
				data: enc("NEW_MAIN"),
			},
			{
				name: "AI-notebook-0.8.0/release/ai-notebook/manifest.json",
				data: enc('{"id":"ai-notebook","version":"0.8.0"}'),
			},
			{
				name: "AI-notebook-0.8.0/release/ai-notebook/styles.css",
				data: enc("NEW_CSS"),
			},
		];
		const picked = pickPluginRuntimeFiles(entries);
		expect(new TextDecoder().decode(picked.mainJs)).toBe("NEW_MAIN");
		expect(new TextDecoder().decode(picked.manifest!)).toContain("0.8.0");
		expect(new TextDecoder().decode(picked.styles!)).toBe("NEW_CSS");
	});
});
