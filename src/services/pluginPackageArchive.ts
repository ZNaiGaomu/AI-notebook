import type { Plugin } from "obsidian";
import { normalizePath } from "obsidian";
import {
	downloadReleaseZip,
	downloadRuntimeFilesDirect,
} from "./githubReleaseService";
import { pickPluginRuntimeFiles, unzipEntries } from "../infra/zipUtil";
import type { PluginReleaseCacheEntry } from "../domain/types";

const RUNTIME_FILES = ["main.js", "manifest.json", "styles.css"] as const;

/** Local snapshot of a running or downloaded package. */
export type ArchivedPackage = {
	version: string;
	/**
	 * vault-relative folder.
	 * - Legacy (no source): package-archive/v0.2.0
	 * - Source-scoped (A): package-archive/by-source/{sourceId}/v0.2.0
	 */
	path: string;
	archivedAt: string;
	files: string[];
	/** null/undefined = local backup of whatever was running */
	sourceId?: string | null;
	sourceName?: string | null;
};

export type PackageIndex = {
	updatedAt: string;
	packages: ArchivedPackage[];
};

type VaultAdapter = {
	exists: (path: string) => Promise<boolean> | boolean;
	read: (path: string) => Promise<string>;
	write: (path: string, data: string) => Promise<void>;
	readBinary?: (path: string) => Promise<ArrayBuffer>;
	writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
	mkdir?: (path: string) => Promise<void>;
	list?: (path: string) => Promise<{ files: string[]; folders: string[] }>;
};

/**
 * Keeps snapshots of plugin runtime files under package-archive/.
 *
 * Layout (option A):
 *   package-archive/vX.Y.Z/                     ← auto backup of current run
 *   package-archive/by-source/{sourceId}/vX.Y.Z/ ← downloaded from a GitHub source
 *
 * Switch copies a snapshot back to plugin root (does not touch data.json or vault notes).
 * Obsidian must be reloaded for new main.js to take effect.
 */
export class PluginPackageArchive {
	constructor(private readonly plugin: Plugin) {}

	pluginDir(): string | null {
		const dir = this.plugin.manifest.dir;
		if (!dir) return null;
		return normalizePath(dir);
	}

	archiveRoot(): string | null {
		const dir = this.pluginDir();
		if (!dir) return null;
		return normalizePath(`${dir}/package-archive`);
	}

	/** Path for a local (no-source) backup of the running package. */
	legacyVersionDir(version: string): string | null {
		const root = this.archiveRoot();
		if (!root) return null;
		return normalizePath(`${root}/v${version}`);
	}

	/** Path for a source-scoped downloaded package. */
	sourceVersionDir(sourceId: string, version: string): string | null {
		const root = this.archiveRoot();
		if (!root) return null;
		return normalizePath(`${root}/by-source/${sourceId}/v${version}`);
	}

	private adapter(): VaultAdapter {
		return this.plugin.app.vault.adapter as unknown as VaultAdapter;
	}

	private async ensureFolder(path: string): Promise<void> {
		const ad = this.adapter();
		const p = normalizePath(path);
		if (ad.mkdir) {
			const parts = p.split("/").filter(Boolean);
			let acc = "";
			for (const part of parts) {
				acc = acc ? `${acc}/${part}` : part;
				try {
					const ex = await ad.exists(acc);
					if (!ex) await ad.mkdir(acc);
				} catch {
					try {
						await ad.mkdir(acc);
					} catch {
						// ignore
					}
				}
			}
			return;
		}
		const keep = `${p}/.keep`;
		try {
			await ad.write(keep, "");
		} catch {
			// ignore
		}
	}

	private async pathExists(path: string): Promise<boolean> {
		try {
			return Boolean(await this.adapter().exists(normalizePath(path)));
		} catch {
			return false;
		}
	}

	private async copyFile(from: string, to: string): Promise<void> {
		const ad = this.adapter();
		const src = normalizePath(from);
		const dest = normalizePath(to);
		const parent = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : "";
		if (parent) await this.ensureFolder(parent);

		if (ad.readBinary && ad.writeBinary) {
			const bin = await ad.readBinary(src);
			await ad.writeBinary(dest, bin);
			return;
		}
		const text = await ad.read(src);
		await ad.write(dest, text);
	}

	private async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
		const ad = this.adapter();
		const dest = normalizePath(path);
		const parent = dest.includes("/") ? dest.slice(0, dest.lastIndexOf("/")) : "";
		if (parent) await this.ensureFolder(parent);
		const ab =
			data instanceof ArrayBuffer
				? data
				: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
		if (ad.writeBinary) {
			await ad.writeBinary(dest, ab as ArrayBuffer);
			return;
		}
		// text fallback (unlikely for binary)
		const text = new TextDecoder("utf-8").decode(
			data instanceof Uint8Array ? data : new Uint8Array(data),
		);
		await ad.write(dest, text);
	}

	async loadIndex(): Promise<PackageIndex> {
		const root = this.archiveRoot();
		if (!root) return { updatedAt: "", packages: [] };
		const indexPath = normalizePath(`${root}/index.json`);
		if (!(await this.pathExists(indexPath))) {
			return { updatedAt: "", packages: [] };
		}
		try {
			const raw = await this.adapter().read(indexPath);
			const data = JSON.parse(raw) as PackageIndex;
			return {
				updatedAt: data.updatedAt ?? "",
				packages: Array.isArray(data.packages) ? data.packages : [],
			};
		} catch {
			return { updatedAt: "", packages: [] };
		}
	}

	private async saveIndex(index: PackageIndex): Promise<void> {
		const root = this.archiveRoot();
		if (!root) return;
		await this.ensureFolder(root);
		await this.adapter().write(
			normalizePath(`${root}/index.json`),
			`${JSON.stringify(index, null, 2)}\n`,
		);
	}

	private packageKey(p: ArchivedPackage): string {
		return `${p.sourceId ?? "local"}@${p.version}`;
	}

	/** Snapshot current running package into package-archive/v{version}/ */
	async archiveCurrentPackage(): Promise<
		{ ok: true; version: string; path: string } | { ok: false; error: string }
	> {
		const dir = this.pluginDir();
		const root = this.archiveRoot();
		if (!dir || !root) {
			return { ok: false, error: "无法定位插件目录（非本地 vault？）" };
		}
		const version = this.plugin.manifest.version || "0.0.0";
		const dest = normalizePath(`${root}/v${version}`);
		await this.ensureFolder(dest);

		const copied: string[] = [];
		for (const file of RUNTIME_FILES) {
			const src = normalizePath(`${dir}/${file}`);
			if (!(await this.pathExists(src))) continue;
			await this.copyFile(src, `${dest}/${file}`);
			copied.push(file);
		}
		if (copied.length === 0) {
			return { ok: false, error: "插件目录中找不到 main.js / manifest.json" };
		}

		const index = await this.loadIndex();
		const entry: ArchivedPackage = {
			version,
			path: dest,
			archivedAt: new Date().toISOString(),
			files: copied,
			sourceId: null,
			sourceName: "本地运行备份",
		};
		const packages = [
			...index.packages.filter(
				(p) => !(p.version === version && (p.sourceId == null || p.sourceId === "")),
			),
			entry,
		].sort((a, b) =>
			b.version.localeCompare(a.version, undefined, { numeric: true }),
		);

		await this.saveIndex({
			updatedAt: entry.archivedAt,
			packages,
		});

		await this.adapter().write(
			normalizePath(`${dest}/README.txt`),
			[
				`AI 记录本 安装包存档 v${version}`,
				`归档时间: ${entry.archivedAt}`,
				`来源: 本地运行备份`,
				``,
				`本目录由插件自动保留，用于「历史版本 → 插件整体历史」一键切换。`,
				`切换时只会覆盖插件根目录的 main.js / manifest.json / styles.css，`,
				`不会修改 data.json、也不会改 vault 里的笔记。`,
				``,
			].join("\n"),
		);

		return { ok: true, version, path: dest };
	}

	async listArchivedVersions(): Promise<string[]> {
		const index = await this.loadIndex();
		const fromIndex = index.packages.map((p) => p.version);
		const root = this.archiveRoot();
		if (root && this.adapter().list) {
			try {
				const listing = await this.adapter().list!(root);
				for (const folder of listing.folders ?? []) {
					const name = folder.includes("/")
						? folder.slice(folder.lastIndexOf("/") + 1)
						: folder;
					if (name.startsWith("v") && !fromIndex.includes(name.slice(1))) {
						fromIndex.push(name.slice(1));
					}
				}
			} catch {
				// ignore
			}
		}
		return [...new Set(fromIndex)].sort((a, b) =>
			b.localeCompare(a, undefined, { numeric: true }),
		);
	}

	/** Legacy: any archive for this version (local or any source). */

	/**
	 * Local-only backups (sourceId null/empty), including folder scan.
	 * Used by UI to show switchable cards after「立即备份」.
	 */
	/** True only for local (no-source) backup folder package-archive/v{version}/. */
	async hasLocalBackup(version: string): Promise<boolean> {
		const dir = this.legacyVersionDir(version);
		if (!dir) return false;
		return this.pathExists(normalizePath(`${dir}/main.js`));
	}

	/**
	 * Startup helper: archive current package only if no local backup for this version yet.
	 * Manual backup / switch-safety still call archiveCurrentPackage() which always writes.
	 */
	async archiveCurrentPackageIfNeeded(): Promise<
		| { ok: true; version: string; path: string; skipped: boolean }
		| { ok: false; error: string }
	> {
		const version = this.plugin.manifest.version || "0.0.0";
		const dest = this.legacyVersionDir(version);
		if (dest && (await this.hasLocalBackup(version))) {
			return { ok: true, version, path: dest, skipped: true };
		}
		const r = await this.archiveCurrentPackage();
		if (!r.ok) return r;
		return { ...r, skipped: false };
	}

	async listLocalBackups(): Promise<ArchivedPackage[]> {
		const index = await this.loadIndex();
		const byVer = new Map<string, ArchivedPackage>();
		for (const p of index.packages) {
			if (p.sourceId) continue;
			const main = normalizePath(`${p.path}/main.js`);
			if (await this.pathExists(main)) {
				byVer.set(p.version, {
					...p,
					sourceId: null,
					sourceName: p.sourceName || "本地运行备份",
				});
			}
		}
		const root = this.archiveRoot();
		if (root && this.adapter().list) {
			try {
				const listing = await this.adapter().list!(root);
				for (const folder of listing.folders ?? []) {
					const name = folder.includes("/")
						? folder.slice(folder.lastIndexOf("/") + 1)
						: folder;
					if (!name.startsWith("v")) continue;
					const version = name.slice(1);
					if (!version || byVer.has(version)) continue;
					const path = normalizePath(`${root}/${name}`);
					if (!(await this.pathExists(normalizePath(`${path}/main.js`)))) continue;
					byVer.set(version, {
						version,
						path,
						archivedAt: "",
						files: ["main.js"],
						sourceId: null,
						sourceName: "本地运行备份",
					});
				}
			} catch {
				// ignore
			}
		}
		return [...byVer.values()].sort((a, b) =>
			b.version.localeCompare(a.version, undefined, { numeric: true }),
		);
	}

	async hasArchive(version: string): Promise<boolean> {

		const root = this.archiveRoot();
		if (!root) return false;
		const main = normalizePath(`${root}/v${version}/main.js`);
		if (await this.pathExists(main)) return true;
		const index = await this.loadIndex();
		for (const p of index.packages) {
			if (p.version !== version) continue;
			if (await this.pathExists(normalizePath(`${p.path}/main.js`))) return true;
		}
		return false;
	}

	async hasSourceArchive(sourceId: string, version: string): Promise<boolean> {
		const dir = this.sourceVersionDir(sourceId, version);
		if (!dir) return false;
		return this.pathExists(normalizePath(`${dir}/main.js`));
	}

	/**
	 * Download a GitHub release zip into package-archive/by-source/{sourceId}/v{version}/.
	 * Does NOT switch the running package.
	 */
	async downloadReleaseToArchive(opts: {
		sourceId: string;
		sourceName: string;
		release: PluginReleaseCacheEntry;
		/** Prefer explicit owner/repo from the configured source row */
		owner?: string;
		repo?: string;
	}): Promise<
		{ ok: true; version: string; path: string } | { ok: false; error: string }
	> {
		const dest = this.sourceVersionDir(opts.sourceId, opts.release.version);
		if (!dest) return { ok: false, error: "无法定位插件目录" };

		// Parse owner/repo from release html/download when possible
		const ownerRepo =
			opts.owner && opts.repo
				? { owner: opts.owner, repo: opts.repo }
				: parseOwnerRepoFromRelease(opts.release);
		let mainJs: Uint8Array | undefined;
		let manifest: Uint8Array | undefined;
		let styles: Uint8Array | undefined;
		const errors: string[] = [];

		// 1) zip download (with alternate URLs)
		const dl = await downloadReleaseZip(opts.release.downloadUrl, {
			owner: ownerRepo?.owner,
			repo: ownerRepo?.repo,
			tagName: opts.release.tagName || opts.release.version,
		});
		if (dl.ok) {
			try {
				const entries = await unzipEntries(dl.data);
				const picked = pickPluginRuntimeFiles(entries);
				mainJs = picked.mainJs;
				manifest = picked.manifest;
				styles = picked.styles;
				if (!mainJs || !manifest) {
					errors.push("ZIP 内未找到 main.js/manifest.json");
				}
			} catch (e) {
				errors.push(`解压失败: ${e instanceof Error ? e.message : String(e)}`);
			}
		} else {
			errors.push(dl.error);
		}

		// 2) direct raw/jsDelivr files if zip path failed
		if ((!mainJs || !manifest) && ownerRepo) {
			const direct = await downloadRuntimeFilesDirect({
				owner: ownerRepo.owner,
				repo: ownerRepo.repo,
				ref: opts.release.tagName || opts.release.version,
			});
			if (direct.ok) {
				mainJs = new Uint8Array(direct.files["main.js"]);
				manifest = new Uint8Array(direct.files["manifest.json"]);
				if (direct.files["styles.css"]) {
					styles = new Uint8Array(direct.files["styles.css"]);
				}
			} else {
				errors.push(direct.error);
			}
		}

		if (!mainJs || !manifest) {
			return {
				ok: false,
				error: errors.join("；") || "无法获取安装包文件",
			};
		}

		const files = { mainJs, manifest, styles };

		await this.ensureFolder(dest);
		const copied: string[] = [];
		await this.writeBinary(`${dest}/main.js`, files.mainJs);
		copied.push("main.js");
		await this.writeBinary(`${dest}/manifest.json`, files.manifest);
		copied.push("manifest.json");
		if (files.styles) {
			await this.writeBinary(`${dest}/styles.css`, files.styles);
			copied.push("styles.css");
		}

		const meta = {
			sourceId: opts.sourceId,
			sourceName: opts.sourceName,
			version: opts.release.version,
			tagName: opts.release.tagName,
			downloadUrl: opts.release.downloadUrl,
			htmlUrl: opts.release.htmlUrl,
			archivedAt: new Date().toISOString(),
		};
		await this.adapter().write(
			normalizePath(`${dest}/SOURCE.json`),
			`${JSON.stringify(meta, null, 2)}\n`,
		);
		await this.adapter().write(
			normalizePath(`${dest}/README.txt`),
			[
				`AI 记录本 安装包存档 v${opts.release.version}`,
				`来源: ${opts.sourceName} (${opts.sourceId})`,
				`归档时间: ${meta.archivedAt}`,
				`Release: ${opts.release.htmlUrl}`,
				``,
				`此目录按「来源 id + 版本号」隔离，不会与其他来源的同号版本互相覆盖。`,
				`仅在你点「使用此版本」时才会覆盖运行中的 main.js / manifest / styles。`,
				``,
			].join("\n"),
		);

		const index = await this.loadIndex();
		const entry: ArchivedPackage = {
			version: opts.release.version,
			path: dest,
			archivedAt: meta.archivedAt,
			files: copied,
			sourceId: opts.sourceId,
			sourceName: opts.sourceName,
		};
		const packages = [
			...index.packages.filter(
				(p) =>
					!(p.sourceId === opts.sourceId && p.version === opts.release.version),
			),
			entry,
		].sort((a, b) =>
			b.version.localeCompare(a.version, undefined, { numeric: true }),
		);
		await this.saveIndex({ updatedAt: meta.archivedAt, packages });

		return { ok: true, version: opts.release.version, path: dest };
	}

	/**
	 * Replace running plugin files with an archived snapshot.
	 * Prefer source-scoped path when sourceId is provided.
	 * data.json is intentionally left untouched.
	 */
	async switchToPackage(
		version: string,
		opts?: { sourceId?: string | null; sourceName?: string | null },
	): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
		const dir = this.pluginDir();
		const root = this.archiveRoot();
		if (!dir || !root) {
			return { ok: false, error: "无法定位插件目录" };
		}

		let srcDir: string | null = null;
		if (opts?.sourceId) {
			const scoped = this.sourceVersionDir(opts.sourceId, version);
			if (scoped && (await this.pathExists(normalizePath(`${scoped}/main.js`)))) {
				srcDir = scoped;
			}
		}
		if (!srcDir) {
			// legacy / local backup
			const legacy = normalizePath(`${root}/v${version}`);
			if (await this.pathExists(normalizePath(`${legacy}/main.js`))) {
				srcDir = legacy;
			}
		}
		if (!srcDir) {
			// any index entry matching version (+ optional source)
			const index = await this.loadIndex();
			const candidates = index.packages.filter((p) => p.version === version);
			const prefer = opts?.sourceId
				? candidates.find((p) => p.sourceId === opts.sourceId)
				: candidates.find((p) => !p.sourceId) ?? candidates[0];
			if (prefer && (await this.pathExists(normalizePath(`${prefer.path}/main.js`)))) {
				srcDir = prefer.path;
			}
		}

		if (!srcDir) {
			return {
				ok: false,
				error: opts?.sourceId
					? `本地没有来源存档：${opts.sourceName || opts.sourceId} / v${version}。请先「下载到本地」。`
					: `本地没有 v${version} 的安装包存档。可从 GitHub 来源下载，或先备份当前运行包。`,
			};
		}

		// Must have the two required runtime files before touching the running package.
		const srcMain = normalizePath(`${srcDir}/main.js`);
		const srcManifest = normalizePath(`${srcDir}/manifest.json`);
		if (!(await this.pathExists(srcMain)) || !(await this.pathExists(srcManifest))) {
			return {
				ok: false,
				error: `存档不完整（缺少 main.js 或 manifest.json）：${srcDir}`,
			};
		}

		// safety: archive current first so user can switch back.
		// Backup failure aborts the switch — never leave the user without a local rollback.
		const backup = await this.archiveCurrentPackage();
		if (!backup.ok) {
			return {
				ok: false,
				error: `切换前备份当前版本失败，已中止切换。${backup.error}。可先点「立即备份当前安装包到本地存档」再重试。`,
			};
		}

		try {
			for (const file of RUNTIME_FILES) {
				const src = normalizePath(`${srcDir}/${file}`);
				if (!(await this.pathExists(src))) {
					// styles.css is optional; main/manifest already validated
					if (file === "styles.css") continue;
					throw new Error(`源存档缺少 ${file}`);
				}
				await this.copyFile(src, `${dir}/${file}`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				ok: false,
				error:
					`切换写入失败：${msg}。当前运行包可能未完整更新。` +
					`请到「本地运行备份」切换回 v${backup.version}（路径 ${backup.path}）。`,
			};
		}

		const label = opts?.sourceName
			? `${opts.sourceName} · v${version}`
			: `v${version}`;
		await this.adapter().write(
			normalizePath(`${dir}/LAST_SWITCH.txt`),
			[
				`switchedTo: ${version}`,
				`sourceId: ${opts?.sourceId ?? "(local)"}`,
				`sourceName: ${opts?.sourceName ?? "本地存档"}`,
				`from: ${srcDir}`,
				`label: ${label}`,
				`preSwitchBackup: v${backup.version} @ ${backup.path}`,
				`at: ${new Date().toISOString()}`,
				`note: Reload Obsidian or disable/enable the plugin to load new main.js`,
				`data.json was not modified`,
			].join("\n"),
		);

		return { ok: true, version };
	}
}

function parseOwnerRepoFromRelease(
	rel: PluginReleaseCacheEntry,
): { owner: string; repo: string } | null {
	const urls = [rel.htmlUrl, rel.downloadUrl].filter(Boolean);
	for (const u of urls) {
		const m = String(u).match(
			/github\.com\/([^\/]+)\/([^\/\?#]+)/i,
		);
		if (m) {
			return {
				owner: m[1]!,
				repo: m[2]!.replace(/\.git$/i, ""),
			};
		}
		const c = String(u).match(
			/codeload\.github\.com\/([^\/]+)\/([^\/]+)/i,
		);
		if (c) {
			return { owner: c[1]!, repo: c[2]! };
		}
	}
	return null;
}
