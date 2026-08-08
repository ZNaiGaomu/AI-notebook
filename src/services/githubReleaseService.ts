/**
 * Fetch installable plugin packages from a GitHub repo (on-demand only).
 * Never mutates the running package — callers download / switch explicitly.
 *
 * UI keeps two independent channels (do not mix in one list):
 * - fetchGithubReleaseChannel / channel "release": GitHub Release zip assets only
 * - fetchGithubTagsChannel / channel "tags": Tags HTML → jsDelivr → Tags API → branch zip
 */

import { requestUrl } from "obsidian";
import type { PluginReleaseCacheEntry } from "../domain/types";

export type ParsedGithubRepo = {
	owner: string;
	repo: string;
	/** Normalized https://github.com/owner/repo */
	canonicalUrl: string;
};

export type FetchPackagesResult =
	| {
			ok: true;
			releases: PluginReleaseCacheEntry[];
			/** Human steps tried, for Notice / debug */
			trace: string[];
	  }
	| { ok: false; error: string; trace: string[] };

/**
 * Accepts:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - github.com/owner/repo
 * - owner/repo
 */
export function parseGithubRepoUrl(
	input: string,
): ParsedGithubRepo | { error: string } {
	const raw = (input || "").trim();
	if (!raw) return { error: "请填写 GitHub 仓库地址" };

	let s = raw.replace(/\.git$/i, "").replace(/\/+$/, "");
	if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
		const [owner, repo] = s.split("/");
		return {
			owner: owner!,
			repo: repo!,
			canonicalUrl: `https://github.com/${owner}/${repo}`,
		};
	}

	if (s.startsWith("github.com/")) s = `https://${s}`;
	if (s.startsWith("www.github.com/")) s = `https://${s.slice(4)}`;

	try {
		const u = new URL(s.includes("://") ? s : `https://${s}`);
		if (!/github\.com$/i.test(u.hostname.replace(/^www\./i, ""))) {
			return { error: "仅支持 github.com 仓库链接" };
		}
		const parts = u.pathname.split("/").filter(Boolean);
		if (parts.length < 2) return { error: "无法解析 owner/repo，请检查链接" };
		const owner = parts[0]!;
		const repo = parts[1]!.replace(/\.git$/i, "");
		return {
			owner,
			repo,
			canonicalUrl: `https://github.com/${owner}/${repo}`,
		};
	} catch {
		return { error: "链接格式无效" };
	}
}

type GhAsset = {
	name?: string;
	browser_download_url?: string;
	content_type?: string;
};

type GhRelease = {
	tag_name?: string;
	name?: string;
	body?: string | null;
	published_at?: string;
	html_url?: string;
	assets?: GhAsset[];
	draft?: boolean;
	prerelease?: boolean;
};

type GhTag = {
	name?: string;
	commit?: { sha?: string };
	zipball_url?: string;
	tarball_url?: string;
};

function stripV(tag: string): string {
	return tag.replace(/^v/i, "").trim();
}


/** Browser page for a git tag (Tags tab / tree) — NOT the Release notes page. */
export function githubTagBrowseUrl(
	owner: string,
	repo: string,
	tag: string,
): string {
	const t = (tag || "").trim() || "main";
	// tree/<tag> shows the source at that tag; /tags is the Tags list tab.
	return `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(t)}`;
}

export function githubTagsListUrl(owner: string, repo: string): string {
	return `https://github.com/${owner}/${repo}/tags`;
}


function pickZipAsset(assets: GhAsset[] | undefined): GhAsset | null {
	if (!assets?.length) return null;
	const zips = assets.filter(
		(a) =>
			typeof a.name === "string" &&
			typeof a.browser_download_url === "string" &&
			/\.zip$/i.test(a.name),
	);
	if (!zips.length) return null;
	return (
		zips.find((a) => /ai-notebook/i.test(a.name || "")) ??
		zips.find((a) => /plugin/i.test(a.name || "")) ??
		zips[0]!
	);
}

/** Primary tag source zip — same as Tags page "zip" button. */
export function githubTagZipUrl(
	owner: string,
	repo: string,
	ref: string,
): string {
	return `https://github.com/${owner}/${repo}/archive/refs/tags/${encodeURIComponent(ref)}.zip`;
}

/** codeload zip for a ref (tag name). Alternate host. */
export function codeloadZipUrl(
	owner: string,
	repo: string,
	ref: string,
): string {
	const encoded = encodeURIComponent(ref);
	return `https://codeload.github.com/${owner}/${repo}/zip/refs/tags/${encoded}`;
}

export function codeloadBranchZipUrl(
	owner: string,
	repo: string,
	branch: string,
): string {
	const encoded = encodeURIComponent(branch);
	return `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encoded}`;
}

/** Alternate archive URL (sometimes works when codeload is blocked). */
export function githubArchiveZipUrl(
	owner: string,
	repo: string,
	ref: string,
): string {
	return `https://github.com/${owner}/${repo}/archive/refs/tags/${encodeURIComponent(ref)}.zip`;
}

export function githubBranchArchiveZipUrl(
	owner: string,
	repo: string,
	branch: string,
): string {
	return `https://github.com/${owner}/${repo}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
}

async function httpGet(
	url: string,
	headers?: Record<string, string>,
): Promise<
	| { ok: true; status: number; text: string; arrayBuffer?: ArrayBuffer }
	| { ok: false; status: number; error: string; text?: string }
> {
	try {
		const res = await requestUrl({
			url,
			method: "GET",
			headers: {
				"User-Agent": "ai-notebook-obsidian-plugin",
				...(headers || {}),
			},
			throw: false,
		});
		const text = res.text ?? "";
		if (res.status < 200 || res.status >= 300) {
			return {
				ok: false,
				status: res.status,
				error: `HTTP ${res.status}`,
				text: text.slice(0, 200),
			};
		}
		return {
			ok: true,
			status: res.status,
			text,
			arrayBuffer: res.arrayBuffer,
		};
	} catch (e) {
		try {
			const res = await fetch(url, {
				headers: {
					"User-Agent": "ai-notebook-obsidian-plugin",
					...(headers || {}),
				},
			});
			const text = await res.text();
			if (!res.ok) {
				return {
					ok: false,
					status: res.status,
					error: `HTTP ${res.status}`,
					text: text.slice(0, 200),
				};
			}
			// no arrayBuffer easily after text — callers that need binary use requestUrl path
			return { ok: true, status: res.status, text };
		} catch (e2) {
			return {
				ok: false,
				status: 0,
				error: e2 instanceof Error ? e2.message : String(e2 ?? e),
			};
		}
	}
}

async function httpGetJson(
	url: string,
	headers?: Record<string, string>,
): Promise<
	| { ok: true; data: unknown }
	| { ok: false; status: number; error: string }
> {
	const res = await httpGet(url, {
		Accept: "application/json",
		...(headers || {}),
	});
	if (!res.ok) {
		return { ok: false, status: res.status, error: res.error };
	}
	try {
		return { ok: true, data: JSON.parse(res.text || "null") };
	} catch {
		return { ok: false, status: res.status, error: "响应不是 JSON" };
	}
}

/** Dedupe by stripped version so v0.2.0 and 0.2.0 collapse. */
function entryKey(it: PluginReleaseCacheEntry): string {
	const tag = (it.tagName || it.version || "").trim();
	const ver = stripV(tag || it.version);
	return (ver || tag).toLowerCase();
}

function mergeEntries(
	into: Map<string, PluginReleaseCacheEntry>,
	items: PluginReleaseCacheEntry[],
): void {
	for (const it of items) {
		if (!it.downloadUrl) continue;
		const key = entryKey(it);
		if (!key) continue;
		const prev = into.get(key);
		if (!prev) {
			into.set(key, it);
			continue;
		}
		const prevHasV = /^v/i.test(prev.tagName || "");
		const nextHasV = /^v/i.test(it.tagName || "");
		if (!prevHasV && nextHasV) into.set(key, it);
	}
}

async function fromReleasesApi(
	owner: string,
	repo: string,
	trace: string[],
): Promise<PluginReleaseCacheEntry[]> {
	const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=50`;
	const res = await httpGetJson(url, {
		Accept: "application/vnd.github+json",
	});
	if (!res.ok) {
		trace.push(`Releases API 失败: ${res.error} (${res.status})`);
		return [];
	}
	if (!Array.isArray(res.data)) {
		trace.push("Releases API 返回格式异常");
		return [];
	}
	const out: PluginReleaseCacheEntry[] = [];
	for (const raw of res.data as GhRelease[]) {
		if (raw.draft) continue;
		const tag = raw.tag_name || "";
		const version = stripV(tag);
		if (!version) continue;
		// Only real Release zip attachments count for priority-1 channel
		const asset = pickZipAsset(raw.assets);
		if (!asset?.browser_download_url) continue;
		out.push({
			version,
			tagName: tag || `v${version}`,
			name: (raw.name || tag || version).trim(),
			publishedAt: raw.published_at || "",
			body:
				(typeof raw.body === "string" ? raw.body : "") ||
				"GitHub Release 安装包附件",
			downloadUrl: asset.browser_download_url,
			htmlUrl:
				raw.html_url ||
				`https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag || version)}`,
			fetchChannel: "release",
			fetchChannelLabel: "Release 附件",
		});
	}
	trace.push(`Release 安装包：${out.length} 条`);
	return out;
}

async function fromTagsApi(
	owner: string,
	repo: string,
	trace: string[],
): Promise<PluginReleaseCacheEntry[]> {
	const url = `https://api.github.com/repos/${owner}/${repo}/tags?per_page=50`;
	const res = await httpGetJson(url, {
		Accept: "application/vnd.github+json",
	});
	if (!res.ok) {
		trace.push(`Tags API 失败: ${res.error} (${res.status})`);
		return [];
	}
	if (!Array.isArray(res.data)) {
		trace.push("Tags API 返回格式异常");
		return [];
	}
	const out: PluginReleaseCacheEntry[] = [];
	for (const raw of res.data as GhTag[]) {
		const tag = raw.name || "";
		const version = stripV(tag);
		if (!version) continue;
		out.push({
			version,
			tagName: tag,
			name: tag,
			publishedAt: "",
			body: "来源：GitHub Tags API（源码 zip；安装时提取 release/ai-notebook 或根目录三文件）",
			downloadUrl: githubTagZipUrl(owner, repo, tag),
			htmlUrl: githubTagBrowseUrl(owner, repo, tag),
			fetchChannel: "tags",
			fetchChannelLabel: "Tags 源码包",
		});
	}
	trace.push(`Tags API：${out.length} 条`);
	return out;
}

/** jsDelivr lists git tags without burning GitHub API quota. */
async function fromJsDelivr(
	owner: string,
	repo: string,
	trace: string[],
): Promise<PluginReleaseCacheEntry[]> {
	const url = `https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}`;
	const res = await httpGetJson(url);
	if (!res.ok) {
		trace.push(`jsDelivr 失败: ${res.error} (${res.status})`);
		return [];
	}
	const raw = res.data as { versions?: unknown };
	let versions: string[] = [];
	if (Array.isArray(raw.versions)) {
		// jsDelivr returns either string[] or { version: string, links }[]
		for (const v of raw.versions) {
			if (typeof v === "string") {
				versions.push(v);
			} else if (v && typeof v === "object") {
				const ver = (v as { version?: unknown }).version;
				if (typeof ver === "string" && ver.trim()) versions.push(ver.trim());
			}
		}
	} else if (raw.versions && typeof raw.versions === "object") {
		versions = Object.keys(raw.versions as Record<string, unknown>);
	}
	versions = versions.filter((v) => {
		const s = String(v).trim();
		if (!s || s === "latest" || s === "[object Object]") return false;
		if (/^[0-9a-f]{7,40}$/i.test(s)) return false;
		return true;
	});
	if (!versions.length) {
		trace.push("jsDelivr：无 versions");
		return [];
	}
	const out: PluginReleaseCacheEntry[] = [];
	for (const ver of versions.slice(0, 50)) {
		const tag = String(ver).trim();
		const version = stripV(tag);
		if (!version) continue;
		const tagName =
			tag.startsWith("v") || tag.startsWith("V") ? tag : `v${version}`;
		out.push({
			version,
			tagName,
			name: tagName,
			publishedAt: "",
			body: "来源：jsDelivr 标签列表 · 下载 = GitHub Tags 源码 zip（内含 release/ai-notebook）",
			downloadUrl: githubTagZipUrl(owner, repo, tagName),
			htmlUrl: githubTagBrowseUrl(owner, repo, tagName),
			fetchChannel: "tags",
			fetchChannelLabel: "Tags 源码包",
		});
	}
	trace.push(
		`jsDelivr：${out.length} 条（${out.map((x) => x.tagName).join(", ")}）`,
	);
	return out;
}

/** Parse public tags page HTML for tag names (no API). Primary when API 403. */
async function fromTagsHtml(
	owner: string,
	repo: string,
	trace: string[],
): Promise<PluginReleaseCacheEntry[]> {
	const url = `https://github.com/${owner}/${repo}/tags`;
	const res = await httpGet(url, { Accept: "text/html" });
	if (!res.ok) {
		trace.push(`Tags HTML 失败: ${res.error}`);
		return [];
	}
	const html = res.text;
	const names = new Set<string>();

	const patterns = [
		new RegExp(`/${owner}/${repo}/releases/tag/([^"'\s?#]+)`, "gi"),
		new RegExp(`/${owner}/${repo}/tree/([^"'\s?#]+)`, "gi"),
		new RegExp(
			`/${owner}/${repo}/archive/refs/tags/([^"'\s]+?)(?:\\.zip|\\.tar\\.gz)`,
			"gi",
		),
		new RegExp(
			`codeload\\.github\\.com/${owner}/${repo}/zip/refs/tags/([^"'\s]+)`,
			"gi",
		),
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(html))) {
			const name = decodeURIComponent(m[1] || "")
				.replace(/\/$/, "")
				.trim();
			if (!name || name.includes("..")) continue;
			if (/^[0-9a-f]{40}$/i.test(name)) continue;
			if (name === "main" || name === "master") continue;
			names.add(name);
		}
	}

	const out: PluginReleaseCacheEntry[] = [];
	for (const tag of names) {
		const version = stripV(tag);
		if (!version) continue;
		out.push({
			version,
			tagName: tag,
			name: tag,
			publishedAt: "",
			body: "Tags 页面 zip（与网页按钮相同）",
			downloadUrl: githubTagZipUrl(owner, repo, tag),
			htmlUrl: githubTagBrowseUrl(owner, repo, tag),
			fetchChannel: "tags",
			fetchChannelLabel: "Tags 源码包",
		});
	}
	out.sort((a, b) =>
		b.version.localeCompare(a.version, undefined, { numeric: true }),
	);
	trace.push(
		`Tags HTML：${out.length} 条（${out.map((x) => x.tagName).join(", ") || "无"}）`,
	);
	return out;
}

async function fromDefaultBranch(
	owner: string,
	repo: string,
	trace: string[],
): Promise<PluginReleaseCacheEntry[]> {
	// Probe main then master via raw package.json / manifest
	for (const branch of ["main", "master"]) {
		const candidates = [
			`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/release/ai-notebook/manifest.json`,
			`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/manifest.json`,
			`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/release/ai-notebook/manifest.json`,
			`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/manifest.json`,
		];
		for (const url of candidates) {
			const res = await httpGet(url, { Accept: "application/json" });
			if (!res.ok) continue;
			try {
				const man = JSON.parse(res.text) as { version?: string; name?: string };
				const version = stripV(String(man.version || branch));
				trace.push(`默认分支 ${branch}：读到 manifest v${version}`);
				return [
					{
						version: version || branch,
						tagName: branch,
						name: `${man.name || repo} @ ${branch}`,
						publishedAt: "",
						body: `来源：Code → Download ZIP（分支 ${branch} 最新快照；提取 release/ai-notebook 或根目录三文件）`,
						downloadUrl: codeloadBranchZipUrl(owner, repo, branch),
						htmlUrl: `https://github.com/${owner}/${repo}/tree/${branch}`,
						fetchChannel: "code",
						fetchChannelLabel: "Code Download ZIP",
					},
				];
			} catch {
				// try next
			}
		}
	}
	// still offer main zip blindly
	trace.push("默认分支：未能读 manifest，仍提供 main 源码包候选");
	return [
		{
			version: "main",
			tagName: "main",
			name: `${repo} @ main`,
			publishedAt: "",
			body: "来源：Code → Download ZIP（main 最新；版本号未知）",
			downloadUrl: codeloadBranchZipUrl(owner, repo, "main"),
			htmlUrl: `https://github.com/${owner}/${repo}/tree/main`,
		},
	];
}

export type FetchChannel = "release" | "tags";

/**
 * Parse public Releases HTML for installable zip attachments (no API).
 * Looks for /releases/download/.../*.zip — prefers ai-notebook / plugin names.
 */
async function fromReleasesHtml(
	owner: string,
	repo: string,
	trace: string[],
): Promise<PluginReleaseCacheEntry[]> {
	const url = `https://github.com/${owner}/${repo}/releases`;
	const res = await httpGet(url, {
		Accept: "text/html",
		"User-Agent":
			"Mozilla/5.0 (compatible; ai-notebook-obsidian-plugin; +https://github.com/ZNaiGaomu/AI-notebook)",
	});
	if (!res.ok) {
		trace.push(`Releases HTML 失败: ${res.error}`);
		return [];
	}
	const html = res.text || "";
	if (html.length < 200) {
		trace.push("Releases HTML：内容过短或被拦截");
		return [];
	}

	// href=".../releases/download/v0.8.0/ai-notebook-v0.8.0.zip"
	const re =
		/\/([^\/"'+\s]+)\/([^\/"'+\s]+)\/releases\/download\/([^\/"'?\s]+)\/([^"'?\s]+\.zip)/gi;
	type Cand = { tag: string; file: string; url: string; score: number };
	const byVer = new Map<string, Cand>();
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		const o = m[1]!;
		const r = m[2]!;
		if (o.toLowerCase() !== owner.toLowerCase()) continue;
		if (r.toLowerCase() !== repo.toLowerCase()) continue;
		const tag = decodeURIComponent(m[3]!).replace(/\/$/, "").trim();
		const file = decodeURIComponent(m[4]!).trim();
		if (!tag || !file) continue;
		const version = stripV(tag);
		if (!version) continue;
		let score = 0;
		if (/ai-notebook/i.test(file)) score += 50;
		if (/plugin/i.test(file)) score += 20;
		if (/\.sha256$/i.test(file) || /\.apk$/i.test(file)) continue;
		const full = `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`;
		const prev = byVer.get(version);
		if (!prev || score > prev.score) {
			byVer.set(version, { tag, file, url: full, score });
		}
	}

	// Also catch expanded asset URLs without full owner path sometimes
	const re2 =
		/href="(https:\/\/github\.com\/[^"]+\/releases\/download\/[^"]+\.zip)"/gi;
	while ((m = re2.exec(html))) {
		const full = m[1]!;
		const mm = full.match(
			/github\.com\/([^\/]+)\/([^\/]+)\/releases\/download\/([^\/]+)\/([^\/?\s]+\.zip)/i,
		);
		if (!mm) continue;
		if (mm[1]!.toLowerCase() !== owner.toLowerCase()) continue;
		if (mm[2]!.toLowerCase() !== repo.toLowerCase()) continue;
		const tag = decodeURIComponent(mm[3]!);
		const file = decodeURIComponent(mm[4]!);
		const version = stripV(tag);
		if (!version) continue;
		if (/\.sha256$/i.test(file) || /\.apk$/i.test(file)) continue;
		let score = 0;
		if (/ai-notebook/i.test(file)) score += 50;
		if (/plugin/i.test(file)) score += 20;
		const prev = byVer.get(version);
		if (!prev || score > prev.score) {
			byVer.set(version, { tag, file, url: full, score });
		}
	}

	const out: PluginReleaseCacheEntry[] = [];
	for (const [version, c] of byVer) {
		out.push({
			version,
			tagName: c.tag.startsWith("v") ? c.tag : `v${version}`,
			name: c.file.replace(/\.zip$/i, ""),
			publishedAt: "",
			body: `Releases 网页解析的安装包附件：${c.file}`,
			downloadUrl: c.url,
			htmlUrl: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(c.tag)}`,
			fetchChannel: "release",
			fetchChannelLabel: "Release 附件",
		});
	}
	out.sort((a, b) =>
		b.version.localeCompare(a.version, undefined, { numeric: true }),
	);
	trace.push(
		`Releases HTML：${out.length} 条（${out.map((x) => x.tagName).join(", ") || "无"}）`,
	);
	return out;
}

/**
 * When API/HTML fail: discover tags, then HEAD/probe known plugin zip asset names.
 * Does not mix Tags 源码包 — only real release asset URLs that respond OK.
 */
async function fromReleaseAssetProbe(
	owner: string,
	repo: string,
	trace: string[],
): Promise<PluginReleaseCacheEntry[]> {
	// Reuse tag names from light sources (jsDelivr / tags HTML) as version candidates
	const tagMap = new Map<string, PluginReleaseCacheEntry>();
	mergeEntries(tagMap, await fromJsDelivr(owner, repo, trace));
	if (tagMap.size === 0) {
		mergeEntries(tagMap, await fromTagsHtml(owner, repo, trace));
	}
	const tags = [...tagMap.values()]
		.map((e) => e.tagName || `v${e.version}`)
		.filter(Boolean)
		// newest-first already from sortReleases-ish map order is insertion; re-sort
		.sort((a, b) =>
			stripV(b).localeCompare(stripV(a), undefined, { numeric: true }),
		)
		.slice(0, 12);
	if (!tags.length) {
		trace.push("Release 附件探测：无可用 tag 候选");
		return [];
	}

	const out: PluginReleaseCacheEntry[] = [];
	for (const tag of tags) {
		const version = stripV(tag);
		if (!version) continue;
		// Prefer the exact packaging name used by this project first.
		const names = [
			`ai-notebook-v${version}.zip`,
			`ai-notebook-${version}.zip`,
		];
		const altTag = tag.startsWith("v") || tag.startsWith("V") ? tag : `v${version}`;
		let found: string | null = null;
		let foundName = "";
		for (const name of names) {
			for (const t of [...new Set([altTag, tag])]) {
				const assetUrl = `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(t)}/${encodeURIComponent(name)}`;
				if (await probeReleaseAssetExists(assetUrl)) {
					found = assetUrl;
					foundName = name;
					break;
				}
			}
			if (found) break;
		}
		if (!found) continue;
		out.push({
			version,
			tagName: altTag,
			name: foundName.replace(/\.zip$/i, ""),
			publishedAt: "",
			body: `探测到 Release 安装包附件：${foundName}（API/网页列表不可用时的兜底）`,
			downloadUrl: found,
			htmlUrl: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(altTag)}`,
			fetchChannel: "release",
			fetchChannelLabel: "Release 附件",
		});
	}
	trace.push(
		`Release 附件探测：${out.length} 条（${out.map((x) => x.tagName).join(", ") || "无"}）`,
	);
	return out;
}

/** True if a release asset URL looks reachable (not 404). */
async function probeReleaseAssetExists(url: string): Promise<boolean> {
	const attempts: Array<Record<string, string>> = [
		{
			"User-Agent": "ai-notebook-obsidian-plugin",
			Range: "bytes=0-0",
		},
		{
			"User-Agent": "ai-notebook-obsidian-plugin",
		},
	];
	for (const headers of attempts) {
		try {
			const res = await requestUrl({
				url,
				method: "GET",
				headers,
				throw: false,
			});
			// 200/206 = ok; 301/302 rarely returned after follow; 403 may be API-ish but asset CDN often 200
			if (res.status === 200 || res.status === 206) return true;
			if (res.status === 404 || res.status === 410) return false;
		} catch {
			// try next header set
		}
	}
	return false;
}

/**
 * Fetch only GitHub Release 附件安装包列表（不混 Tags）。
 * Order: Releases API → Releases HTML → 按 tag 探测 ai-notebook-*.zip。
 * Empty list is ok:true with releases=[] so UI can show「暂无 Release 附件」.
 */
export async function fetchGithubReleaseChannel(
	owner: string,
	repo: string,
): Promise<FetchPackagesResult> {
	const trace: string[] = [];
	let releaseItems = await fromReleasesApi(owner, repo, trace);
	if (releaseItems.length === 0) {
		releaseItems = await fromReleasesHtml(owner, repo, trace);
	}
	if (releaseItems.length === 0) {
		releaseItems = await fromReleaseAssetProbe(owner, repo, trace);
	}
	const releases = sortReleases(releaseItems);
	if (releases.length === 0) {
		trace.push("Release 通道：无带 zip 附件的 Release（API / 网页 / 附件探测均未找到）");
		return {
			ok: true,
			releases: [],
			trace,
		};
	}
	trace.push(`Release 通道：${releases.length} 个安装包`);
	return { ok: true, releases, trace };
}

/**
 * Fetch only Tags 源码包列表（不混 Release 附件）。
 * Fallback order inside tags: HTML → jsDelivr → Tags API → default branch snapshot.
 */
export async function fetchGithubTagsChannel(
	owner: string,
	repo: string,
): Promise<FetchPackagesResult> {
	const trace: string[] = [];
	const tagMap = new Map<string, PluginReleaseCacheEntry>();
	mergeEntries(tagMap, await fromTagsHtml(owner, repo, trace));
	if (tagMap.size === 0) {
		mergeEntries(tagMap, await fromJsDelivr(owner, repo, trace));
	}
	if (tagMap.size === 0) {
		mergeEntries(tagMap, await fromTagsApi(owner, repo, trace));
	}
	for (const e of tagMap.values()) {
		e.fetchChannel = "tags";
		e.fetchChannelLabel = e.fetchChannelLabel ?? "Tags 源码包";
		// Always open the tag tree page, never the Release notes page.
		e.htmlUrl = githubTagBrowseUrl(owner, repo, e.tagName || e.version);
	}
	if (tagMap.size > 0) {
		const releases = sortReleases([...tagMap.values()]);
		trace.push(
			`Tags 通道：${releases.length} 个（${releases.map((r) => r.tagName || r.version).join(", ")}）`,
		);
		return { ok: true, releases, trace };
	}

	const codeItems = await fromDefaultBranch(owner, repo, trace);
	for (const e of codeItems) {
		e.fetchChannel = "code";
		e.fetchChannelLabel = "Code Download ZIP";
	}
	if (codeItems.length > 0) {
		trace.push(`Tags 通道兜底：Code Download ZIP（${codeItems.length}）`);
		return { ok: true, releases: codeItems, trace };
	}

	return {
		ok: false,
		error:
			`未能从 ${owner}/${repo} 获取 Tags / 源码包版本。\n` +
			trace.join(" · "),
		trace,
	};
}

/**
 * Fetch one channel only. UI keeps Release / Tags as separate lists.
 */
export async function fetchGithubChannel(
	owner: string,
	repo: string,
	channel: FetchChannel,
): Promise<FetchPackagesResult> {
	if (channel === "release") {
		return fetchGithubReleaseChannel(owner, repo);
	}
	return fetchGithubTagsChannel(owner, repo);
}

/**
 * @deprecated Prefer fetchGithubChannel / fetchGithubReleaseChannel / fetchGithubTagsChannel.
 * Kept for older call sites: fetches Tags channel only was the previous fallback-heavy path;
 * now explicitly fetches release first then tags is wrong for split UI — callers must choose.
 * This legacy helper fetches **both** independently and returns release if any, else tags
 * (same as old exclusive behavior) so accidental callers don't break hard.
 */
export async function fetchGithubReleases(
	owner: string,
	repo: string,
): Promise<FetchPackagesResult> {
	const rel = await fetchGithubReleaseChannel(owner, repo);
	if (rel.ok && rel.releases.length > 0) return rel;
	const tags = await fetchGithubTagsChannel(owner, repo);
	if (tags.ok) {
		return {
			...tags,
			trace: [...(rel.ok ? rel.trace : []), ...tags.trace],
		};
	}
	return {
		ok: false,
		error:
			`未能从 ${owner}/${repo} 获取任何可安装版本。\n` +
			`请分别拉取「Release 安装包」与「Tags 源码包」。\n` +
			[...(rel.ok ? rel.trace : [rel.error]), ...tags.trace].join(" · "),
		trace: [...(rel.ok ? rel.trace : []), ...tags.trace],
	};
}

function sortReleases(
	items: PluginReleaseCacheEntry[],
): PluginReleaseCacheEntry[] {
	return [...items].sort((a, b) => {
		const aBranch = a.tagName === "main" || a.tagName === "master" ? 1 : 0;
		const bBranch = b.tagName === "main" || b.tagName === "master" ? 1 : 0;
		if (aBranch !== bBranch) return aBranch - bBranch;
		return b.version.localeCompare(a.version, undefined, { numeric: true });
	});
}



/** Download a zip as ArrayBuffer; try alternate archive URLs on failure. */
export async function downloadReleaseZip(
	downloadUrl: string,
	opts?: { owner?: string; repo?: string; tagName?: string },
): Promise<{ ok: true; data: ArrayBuffer } | { ok: false; error: string }> {
	const urls = [downloadUrl];
	if (opts?.owner && opts?.repo && opts?.tagName) {
		const tag = opts.tagName;
		const isBranch = tag === "main" || tag === "master";
		if (isBranch) {
			urls.push(
				githubBranchArchiveZipUrl(opts.owner, opts.repo, tag),
				codeloadBranchZipUrl(opts.owner, opts.repo, tag),
			);
		} else {
			urls.push(
				githubTagZipUrl(opts.owner, opts.repo, tag),
				githubArchiveZipUrl(opts.owner, opts.repo, tag),
				codeloadZipUrl(opts.owner, opts.repo, tag),
				`https://codeload.github.com/${opts.owner}/${opts.repo}/zip/${encodeURIComponent(tag)}`,
			);
		}
	}
	// dedupe
	const seen = new Set<string>();
	const unique = urls.filter((u) => {
		if (seen.has(u)) return false;
		seen.add(u);
		return true;
	});

	const errors: string[] = [];
	for (const url of unique) {
		try {
			const res = await requestUrl({
				url,
				method: "GET",
				headers: { "User-Agent": "ai-notebook-obsidian-plugin" },
				throw: false,
			});
			if (res.status < 200 || res.status >= 300) {
				errors.push(`${url} → HTTP ${res.status}`);
				continue;
			}
			const data = res.arrayBuffer;
			if (!data || data.byteLength < 32) {
				errors.push(`${url} → 内容过小`);
				continue;
			}
			// zip magic PK
			const head = new Uint8Array(data.slice(0, 2));
			if (head[0] !== 0x50 || head[1] !== 0x4b) {
				errors.push(`${url} → 不是 ZIP`);
				continue;
			}
			return { ok: true, data };
		} catch (e) {
			errors.push(
				`${url} → ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	// Last resort: fetch runtime files one-by-one via raw/jsdelivr (build a synthetic zip-less path handled by caller)
	return {
		ok: false,
		error: `下载失败：${errors.slice(0, 4).join("；")}`,
	};
}

/**
 * Fetch main.js / manifest.json / styles.css directly (no zip).
 * Tries release/ai-notebook/ then repo root, via raw.githubusercontent + jsDelivr.
 */
export async function downloadRuntimeFilesDirect(opts: {
	owner: string;
	repo: string;
	/** tag or branch */
	ref: string;
}): Promise<
	| {
			ok: true;
			files: { "main.js": ArrayBuffer; "manifest.json": ArrayBuffer; "styles.css"?: ArrayBuffer };
	  }
	| { ok: false; error: string }
> {
	const { owner, repo, ref } = opts;
	const bases = [
		`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/release/ai-notebook`,
		`https://raw.githubusercontent.com/${owner}/${repo}/${ref}`,
		`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/release/ai-notebook`,
		`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}`,
	];

	async function getFile(
		base: string,
		name: string,
	): Promise<ArrayBuffer | null> {
		const url = `${base}/${name}`;
		try {
			const res = await requestUrl({
				url,
				method: "GET",
				headers: { "User-Agent": "ai-notebook-obsidian-plugin" },
				throw: false,
			});
			if (res.status < 200 || res.status >= 300) return null;
			const data = res.arrayBuffer;
			if (!data || data.byteLength < 2) return null;
			return data;
		} catch {
			return null;
		}
	}

	for (const base of bases) {
		const mainJs = await getFile(base, "main.js");
		const manifest = await getFile(base, "manifest.json");
		if (!mainJs || !manifest) continue;
		const styles = await getFile(base, "styles.css");
		const files: {
			"main.js": ArrayBuffer;
			"manifest.json": ArrayBuffer;
			"styles.css"?: ArrayBuffer;
		} = {
			"main.js": mainJs,
			"manifest.json": manifest,
		};
		if (styles) files["styles.css"] = styles;
		return { ok: true, files };
	}
	return {
		ok: false,
		error: `无法从 ${owner}/${repo}@${ref} 直接读取 main.js/manifest.json（raw/jsDelivr 均失败）`,
	};
}

/** Short human summary from release body (first non-empty lines). */
export function summarizeReleaseBody(body: string, maxLines = 8): string[] {
	if (!body?.trim()) return [];
	const lines = body
		.split(/\r?\n/)
		.map((l) => l.replace(/^#+\s*/, "").replace(/^[-*]\s+/, "· ").trim())
		.filter((l) => l.length > 0 && !/^<!---/.test(l));
	return lines.slice(0, maxLines);
}

/** @deprecated use fetchGithubReleases (now multi-fallback) */
export const fetchGithubPackages = fetchGithubReleases;
