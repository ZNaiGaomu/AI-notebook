import type { IVaultFs, VaultFileRef, VaultFolderRef } from "./vaultPort";

/** In-memory vault for offline smoke tests (no Obsidian runtime). */
export class MemoryVault implements IVaultFs {
	private files = new Map<string, string>();
	private folders = new Set<string>([""]);

	normalize(path: string): string {
		return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "").replace(/\/$/, "");
	}

	async ensureFolder(path: string): Promise<void> {
		const p = this.normalize(path);
		if (!p) return;
		const parts = p.split("/");
		let acc = "";
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			this.folders.add(acc);
		}
	}

	async exists(path: string): Promise<boolean> {
		const p = this.normalize(path);
		return this.files.has(p) || this.folders.has(p);
	}

	async read(path: string): Promise<string> {
		const p = this.normalize(path);
		const content = this.files.get(p);
		if (content == null) throw new Error(`File not found: ${path}`);
		return content;
	}

	async readJson<T>(path: string): Promise<T> {
		return JSON.parse(await this.read(path)) as T;
	}

	async write(path: string, content: string): Promise<unknown> {
		const p = this.normalize(path);
		const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
		if (parent) await this.ensureFolder(parent);
		this.files.set(p, content);
		return { path: p };
	}

	async writeJson(path: string, data: unknown): Promise<unknown> {
		return this.write(path, `${JSON.stringify(data, null, 2)}\n`);
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<unknown> {
		// store as base64 marker for tests
		const b64 = Buffer.from(data).toString("base64");
		return this.write(path, `__binary_base64__:${b64}`);
	}

	async remove(path: string): Promise<void> {
		const p = this.normalize(path);
		this.files.delete(p);
	}

	async removeEmptyFolder(path: string): Promise<boolean> {
		const p = this.normalize(path);
		if (!this.folders.has(p) || this.listFilesInFolder(p).length) return false;
		for (const folder of [...this.folders]) {
			if (folder === p || folder.startsWith(`${p}/`)) this.folders.delete(folder);
		}
		return true;
	}

	async move(from: string, to: string): Promise<void> {
		const content = await this.read(from);
		await this.write(to, content);
		await this.remove(from);
	}

	listFilesInFolder(folderPath: string): VaultFileRef[] {
		const prefix = this.normalize(folderPath);
		const out: VaultFileRef[] = [];
		for (const path of this.files.keys()) {
			if (!path.startsWith(prefix + "/") && path !== prefix) continue;
			// only files directly under or nested; include nested like real walk
			const name = path.slice(path.lastIndexOf("/") + 1);
			const extension = name.includes(".")
				? name.slice(name.lastIndexOf(".") + 1)
				: "";
			out.push({ path, extension });
		}
		return out;
	}

	listImmediateFolders(folderPath: string): VaultFolderRef[] {
		const prefix = this.normalize(folderPath);
		const depth = prefix ? prefix.split("/").length + 1 : 1;
		const names = new Set<string>();
		for (const folder of this.folders) {
			if (!folder) continue;
			if (prefix) {
				if (!folder.startsWith(prefix + "/")) continue;
			}
			const parts = folder.split("/");
			if (parts.length !== depth) continue;
			const name = parts[parts.length - 1] ?? "";
			if (name) names.add(name);
		}
		// also infer from files
		for (const path of this.files.keys()) {
			if (prefix && !path.startsWith(prefix + "/")) continue;
			if (!prefix && path.includes("/")) {
				const name = path.split("/")[0] ?? "";
				if (name) names.add(name);
			} else if (prefix) {
				const rest = path.slice(prefix.length + 1);
				const name = rest.split("/")[0] ?? "";
				// if rest still has slash, first segment is folder
				if (rest.includes("/") && name) names.add(name);
			}
		}
		return [...names].map((name) => ({
			name,
			path: prefix ? `${prefix}/${name}` : name,
		}));
	}

	/** Test helper */
	dumpPaths(): string[] {
		return [...this.files.keys()].sort();
	}
}
