import { normalizePath, type App, type TAbstractFile, TFile, TFolder } from "obsidian";
import type { IVaultFs, VaultFileRef, VaultFolderRef } from "./vaultPort";

export class VaultIo implements IVaultFs {
	constructor(private readonly app: App) {}

	normalize(path: string): string {
		return normalizePath(path);
	}

	async ensureFolder(path: string): Promise<void> {
		const p = this.normalize(path);
		const existing = this.app.vault.getAbstractFileByPath(p);
		if (existing instanceof TFolder) return;
		if (existing instanceof TFile) {
			throw new Error(`Path exists as file: ${p}`);
		}
		const parts = p.split("/").filter(Boolean);
		let acc = "";
		for (const part of parts) {
			acc = acc ? `${acc}/${part}` : part;
			const cur = this.app.vault.getAbstractFileByPath(acc);
			if (cur instanceof TFolder) continue;
			if (cur instanceof TFile) {
				throw new Error(`Path exists as file: ${acc}`);
			}
			await this.app.vault.createFolder(acc);
		}
	}

	async exists(path: string): Promise<boolean> {
		return this.app.vault.getAbstractFileByPath(this.normalize(path)) != null;
	}

	getFile(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.normalize(path));
		return f instanceof TFile ? f : null;
	}

	async read(path: string): Promise<string> {
		const file = this.getFile(path);
		if (!file) throw new Error(`File not found: ${path}`);
		return this.app.vault.read(file);
	}

	async readJson<T>(path: string): Promise<T> {
		const raw = await this.read(path);
		return JSON.parse(raw) as T;
	}

	async write(path: string, content: string): Promise<TFile> {
		const p = this.normalize(path);
		const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
		if (parent) await this.ensureFolder(parent);
		const existing = this.getFile(p);
		if (existing) {
			await this.app.vault.modify(existing, content);
			return existing;
		}
		return this.app.vault.create(p, content);
	}

	async writeJson(path: string, data: unknown): Promise<TFile> {
		return this.write(path, `${JSON.stringify(data, null, 2)}\n`);
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		const p = this.normalize(path);
		const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
		if (parent) await this.ensureFolder(parent);
		const existing = this.getFile(p);
		if (existing) {
			await this.app.vault.modifyBinary(existing, data);
			return existing;
		}
		return this.app.vault.createBinary(p, data);
	}

	async remove(path: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(this.normalize(path));
		if (f) await this.app.vault.trash(f, true);
	}

	async move(from: string, to: string): Promise<void> {
		const file = this.getFile(from);
		if (!file) throw new Error(`File not found: ${from}`);
		const target = this.normalize(to);
		const parent = target.includes("/")
			? target.slice(0, target.lastIndexOf("/"))
			: "";
		if (parent) await this.ensureFolder(parent);
		await this.app.fileManager.renameFile(file, target);
	}

	listFilesInFolder(folderPath: string): VaultFileRef[] {
		const folder = this.app.vault.getAbstractFileByPath(
			this.normalize(folderPath),
		);
		if (!(folder instanceof TFolder)) return [];
		const out: VaultFileRef[] = [];
		const walk = (node: TAbstractFile) => {
			if (node instanceof TFile) {
				out.push({ path: node.path, extension: node.extension });
				return;
			}
			if (node instanceof TFolder) {
				for (const child of node.children) walk(child);
			}
		};
		for (const child of folder.children) walk(child);
		return out;
	}

	listImmediateFolders(folderPath: string): VaultFolderRef[] {
		const folder = this.app.vault.getAbstractFileByPath(
			this.normalize(folderPath),
		);
		if (!(folder instanceof TFolder)) return [];
		return folder.children
			.filter((c): c is TFolder => c instanceof TFolder)
			.map((f) => ({ name: f.name, path: f.path }));
	}
}
