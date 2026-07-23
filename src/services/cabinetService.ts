import type { AiNotebookSettings, NotebookMeta } from "../domain/types";
import { createId, nowIso } from "../domain/ids";
import {
	attachmentsDir,
	cabinetDir,
	joinPath,
} from "../infra/paths";
import type { IVaultFs } from "../infra/vaultPort";

export type CabinetLink = {
	id: string;
	url: string;
	title: string;
	note: string;
	item_id: string | null;
	created: string;
	updated: string;
};

export type CabinetFile = {
	id: string;
	displayName: string;
	vaultPath: string;
	mime: string;
	size: number;
	item_id: string | null;
	created: string;
};

type LinkStore = { items: CabinetLink[] };
type FileStore = { items: CabinetFile[] };

export class CabinetService {
	constructor(
		private readonly vault: IVaultFs,
		private readonly getSettings: () => AiNotebookSettings,
	) {}

	private linksPath(folderName: string): string {
		return joinPath(cabinetDir(this.getSettings(), folderName), "links.json");
	}

	private filesPath(folderName: string): string {
		return joinPath(cabinetDir(this.getSettings(), folderName), "files.json");
	}

	async listLinks(meta: NotebookMeta): Promise<CabinetLink[]> {
		const store = await this.readLinks(meta.folderName);
		return store.items;
	}

	async listFiles(meta: NotebookMeta): Promise<CabinetFile[]> {
		const store = await this.readFiles(meta.folderName);
		return store.items;
	}

	async addLink(
		meta: NotebookMeta,
		input: { url: string; title?: string; note?: string; item_id?: string | null },
	): Promise<CabinetLink> {
		const url = input.url.trim();
		if (!url) throw new Error("URL 不能为空");
		const store = await this.readLinks(meta.folderName);
		const now = nowIso();
		const link: CabinetLink = {
			id: createId(),
			url,
			title: (input.title ?? "").trim() || url,
			note: input.note ?? "",
			item_id: input.item_id ?? null,
			created: now,
			updated: now,
		};
		const next: LinkStore = { items: [...store.items, link] };
		await this.vault.writeJson(this.linksPath(meta.folderName), next);
		return link;
	}

	/**
	 * Manual parse: set title from URL hostname + path tail (no network fetch in V1 core).
	 * Real fetch can fail CORS in desktop webview; user asked for click-to-parse.
	 */
	async parseLinkTitle(meta: NotebookMeta, linkId: string): Promise<CabinetLink> {
		const store = await this.readLinks(meta.folderName);
		const idx = store.items.findIndex((l) => l.id === linkId);
		if (idx < 0) throw new Error("链接不存在");
		const link = store.items[idx]!;
		const title = deriveTitleFromUrl(link.url);
		const updated: CabinetLink = {
			...link,
			title,
			updated: nowIso(),
		};
		const items = store.items.map((l, i) => (i === idx ? updated : l));
		await this.vault.writeJson(this.linksPath(meta.folderName), { items });
		return updated;
	}

	/**
	 * Register a file already in vault (or write binary-less placeholder content for tests).
	 * In Obsidian runtime, caller should copy binary via vault API then call this with path.
	 */
	async addFileRef(
		meta: NotebookMeta,
		input: {
			displayName: string;
			vaultPath: string;
			mime?: string;
			size?: number;
			item_id?: string | null;
			/** If provided, write this text content to vaultPath (for smoke tests). */
			textContent?: string;
		},
	): Promise<CabinetFile> {
		const settings = this.getSettings();
		const destDir = attachmentsDir(settings, meta.notebook_id);
		await this.vault.ensureFolder(destDir);

		let vaultPath = input.vaultPath;
		if (input.textContent != null) {
			const safeName = sanitizeFileName(input.displayName);
			vaultPath = joinPath(destDir, safeName);
			await this.vault.write(vaultPath, input.textContent);
		}

		const store = await this.readFiles(meta.folderName);
		const file: CabinetFile = {
			id: createId(),
			displayName: input.displayName,
			vaultPath,
			mime: input.mime ?? "application/octet-stream",
			size: input.size ?? (input.textContent?.length ?? 0),
			item_id: input.item_id ?? null,
			created: nowIso(),
		};
		await this.vault.writeJson(this.filesPath(meta.folderName), {
			items: [...store.items, file],
		});
		return file;
	}

	/**
	 * Register a file that already lives in the vault (no copy).
	 */
	async registerVaultFile(
		meta: NotebookMeta,
		input: {
			displayName?: string;
			vaultPath: string;
			mime?: string;
			size?: number;
			item_id?: string | null;
		},
	): Promise<CabinetFile> {
		const vaultPath = input.vaultPath.trim();
		if (!vaultPath) throw new Error("文件路径不能为空");
		if (!(await this.vault.exists(vaultPath))) {
			throw new Error(`文件不存在: ${vaultPath}`);
		}
		const displayName =
			(input.displayName ?? "").trim() ||
			vaultPath.slice(vaultPath.lastIndexOf("/") + 1) ||
			"file";
		return this.addFileRef(meta, {
			displayName,
			vaultPath,
			mime: input.mime ?? guessMime(displayName),
			size: input.size ?? 0,
			item_id: input.item_id ?? null,
		});
	}

	/**
	 * Import binary from outside the vault: copy into attachments then register.
	 */
	async importBinary(
		meta: NotebookMeta,
		input: {
			displayName: string;
			data: ArrayBuffer;
			mime?: string;
			item_id?: string | null;
		},
	): Promise<CabinetFile> {
		const settings = this.getSettings();
		const destDir = attachmentsDir(settings, meta.notebook_id);
		await this.vault.ensureFolder(destDir);
		const baseName = sanitizeFileName(input.displayName);
		const safeName = await uniqueFileName(baseName, async (name) =>
			this.vault.exists(joinPath(destDir, name)),
		);
		const vaultPath = joinPath(destDir, safeName);
		if (!this.vault.writeBinary) {
			throw new Error("当前存储不支持二进制写入");
		}
		await this.vault.writeBinary(vaultPath, input.data);
		return this.addFileRef(meta, {
			displayName: input.displayName || safeName,
			vaultPath,
			mime: input.mime ?? guessMime(safeName),
			size: input.data.byteLength,
			item_id: input.item_id ?? null,
		});
	}

		async removeLink(meta: NotebookMeta, linkId: string): Promise<void> {
		const store = await this.readLinks(meta.folderName);
		await this.vault.writeJson(this.linksPath(meta.folderName), {
			items: store.items.filter((l) => l.id !== linkId),
		});
	}

	async removeFile(meta: NotebookMeta, fileId: string): Promise<void> {
		const store = await this.readFiles(meta.folderName);
		const target = store.items.find((f) => f.id === fileId);
		await this.vault.writeJson(this.filesPath(meta.folderName), {
			items: store.items.filter((f) => f.id !== fileId),
		});
		if (target) {
			try {
				await this.vault.remove(target.vaultPath);
			} catch {
				// file may already be gone
			}
		}
	}

	/** Hook helper: if item has url field, ensure a cabinet link exists. */
	async attachIfUrl(
		meta: NotebookMeta,
		item: { item_id: string; url?: unknown; title?: string },
	): Promise<CabinetLink | null> {
		const url = typeof item.url === "string" ? item.url.trim() : "";
		if (!url) return null;
		const existing = await this.listLinks(meta);
		const found = existing.find(
			(l) => l.url === url && l.item_id === item.item_id,
		);
		if (found) return found;
		return this.addLink(meta, {
			url,
			title: item.title,
			item_id: item.item_id,
		});
	}

	private async readLinks(folderName: string): Promise<LinkStore> {
		const path = this.linksPath(folderName);
		if (!(await this.vault.exists(path))) {
			const empty: LinkStore = { items: [] };
			await this.vault.writeJson(path, empty);
			return empty;
		}
		const data = await this.vault.readJson<LinkStore>(path);
		return { items: Array.isArray(data.items) ? data.items : [] };
	}

	private async readFiles(folderName: string): Promise<FileStore> {
		const path = this.filesPath(folderName);
		if (!(await this.vault.exists(path))) {
			const empty: FileStore = { items: [] };
			await this.vault.writeJson(path, empty);
			return empty;
		}
		const data = await this.vault.readJson<FileStore>(path);
		return { items: Array.isArray(data.items) ? data.items : [] };
	}
}

function deriveTitleFromUrl(url: string): string {
	try {
		const u = new URL(url);
		const tail = u.pathname.split("/").filter(Boolean).pop() ?? "";
		const decoded = decodeURIComponent(tail || u.hostname);
		return decoded || u.hostname;
	} catch {
		return url.slice(0, 80);
	}
}

function sanitizeFileName(name: string): string {
	const cleaned = name.replace(/[\\/:*?"<>|]/g, "-").trim();
	return cleaned || `file-${Date.now()}.bin`;
}

function guessMime(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith(".pdf")) return "application/pdf";
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".md") || lower.endsWith(".txt")) return "text/plain";
	if (lower.endsWith(".json")) return "application/json";
	if (lower.endsWith(".mp3")) return "audio/mpeg";
	if (lower.endsWith(".wav")) return "audio/wav";
	if (lower.endsWith(".mp4")) return "video/mp4";
	return "application/octet-stream";
}

async function uniqueFileName(
	base: string,
	exists: (name: string) => Promise<boolean>,
): Promise<string> {
	if (!(await exists(base))) return base;
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	for (let i = 2; i < 1000; i++) {
		const candidate = `${stem}-${i}${ext}`;
		if (!(await exists(candidate))) return candidate;
	}
	return `${stem}-${Date.now()}${ext}`;
}
