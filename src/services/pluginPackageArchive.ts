import type { Plugin } from "obsidian";
import { normalizePath } from "obsidian";

const RUNTIME_FILES = ["main.js", "manifest.json", "styles.css"] as const;

export type ArchivedPackage = {
	version: string;
	/** vault-relative folder, e.g. .obsidian/plugins/ai-notebook/package-archive/v0.1.1 */
	path: string;
	archivedAt: string;
	files: string[];
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
 * Keeps snapshots of plugin runtime files under:
 *   <pluginDir>/package-archive/vX.Y.Z/{main.js,manifest.json,styles.css}
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

	private adapter(): VaultAdapter {
		return this.plugin.app.vault.adapter as unknown as VaultAdapter;
	}

	private async ensureFolder(path: string): Promise<void> {
		const ad = this.adapter();
		const p = normalizePath(path);
		if (ad.mkdir) {
			// create parents segment by segment
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
		// fallback: write a keep file
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
		};
		const packages = [
			...index.packages.filter((p) => p.version !== version),
			entry,
		].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));

		await this.saveIndex({
			updatedAt: entry.archivedAt,
			packages,
		});

		// human readme
		await this.adapter().write(
			normalizePath(`${dest}/README.txt`),
			[
				`AI 记录本 安装包存档 v${version}`,
				`归档时间: ${entry.archivedAt}`,
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
		// also scan folders in case index lagging
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

	async hasArchive(version: string): Promise<boolean> {
		const root = this.archiveRoot();
		if (!root) return false;
		const main = normalizePath(`${root}/v${version}/main.js`);
		return this.pathExists(main);
	}

	/**
	 * Replace running plugin files with an archived snapshot.
	 * data.json is intentionally left untouched.
	 */
	async switchToPackage(
		version: string,
	): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
		const dir = this.pluginDir();
		const root = this.archiveRoot();
		if (!dir || !root) {
			return { ok: false, error: "无法定位插件目录" };
		}
		const srcDir = normalizePath(`${root}/v${version}`);
		const mainSrc = normalizePath(`${srcDir}/main.js`);
		if (!(await this.pathExists(mainSrc))) {
			return {
				ok: false,
				error: `本地没有 v${version} 的安装包存档。请先在该版本运行时打开过插件（会自动归档），或从 release/history 拷贝到 package-archive/v${version}/`,
			};
		}

		// safety: archive current first so user can switch back
		await this.archiveCurrentPackage();

		for (const file of RUNTIME_FILES) {
			const src = normalizePath(`${srcDir}/${file}`);
			if (!(await this.pathExists(src))) continue;
			await this.copyFile(src, `${dir}/${file}`);
		}

		await this.adapter().write(
			normalizePath(`${dir}/LAST_SWITCH.txt`),
			[
				`switchedTo: ${version}`,
				`at: ${new Date().toISOString()}`,
				`note: Reload Obsidian or disable/enable the plugin to load new main.js`,
				`data.json was not modified`,
			].join("\n"),
		);

		return { ok: true, version };
	}
}
