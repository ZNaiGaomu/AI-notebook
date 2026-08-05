import type { AiNotebookSettings, NotebookMeta } from "../domain/types";
import { createId, nowIso } from "../domain/ids";
import {
	attachmentsRoot,
	cabinetDir,
	joinPath,
	notebooksRoot,
	structuredAttachmentsDir,
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

export type CabinetFileOwnership = "managed" | "external";
export type CabinetFileKind =
	| "backup"
	| "voice"
	| "chat"
	| "embedded"
	| "unknown";

export type CabinetFile = {
	id: string;
	displayName: string;
	vaultPath: string;
	mime: string;
	size: number;
	item_id: string | null;
	ownership: CabinetFileOwnership;
	kind: CabinetFileKind;
	origin: string;
	managedRoot: string | null;
	created: string;
};

export type RemoveCabinetFileResult = {
	recordRemoved: boolean;
	physicalDeleted: boolean;
	reason:
		| "record-only"
		| "not-found"
		| "external"
		| "shared-path"
		| "unsafe-path"
		| "deleted";
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

	async parseLinkTitle(meta: NotebookMeta, linkId: string): Promise<CabinetLink> {
		const store = await this.readLinks(meta.folderName);
		const idx = store.items.findIndex((link) => link.id === linkId);
		if (idx < 0) throw new Error("链接不存在");
		const link = store.items[idx]!;
		const updated: CabinetLink = {
			...link,
			title: deriveTitleFromUrl(link.url),
			updated: nowIso(),
		};
		const items = store.items.map((candidate, index) =>
			index === idx ? updated : candidate,
		);
		await this.vault.writeJson(this.linksPath(meta.folderName), { items });
		return updated;
	}

	async addFileRef(
		meta: NotebookMeta,
		input: {
			displayName: string;
			vaultPath: string;
			mime?: string;
			size?: number;
			item_id?: string | null;
			itemName?: string | null;
			ownership?: CabinetFileOwnership;
			kind?: CabinetFileKind;
			origin?: string;
			managedRoot?: string;
			textContent?: string;
		},
	): Promise<CabinetFile> {
		const settings = this.getSettings();
		const ownership =
			input.ownership ?? (input.textContent != null ? "managed" : "external");
		const kind = input.kind ?? "backup";
		let vaultPath = input.vaultPath;
		let managedRoot = input.managedRoot ?? null;

		if (input.textContent != null) {
			const destDir = structuredAttachmentsDir(
				settings,
				meta.notebook_id,
				meta.name,
				input.item_id,
				input.itemName,
				kind,
			);
			await this.vault.ensureFolder(destDir);
			vaultPath = joinPath(destDir, sanitizeFileName(input.displayName));
			managedRoot = destDir;
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
			ownership,
			kind,
			origin:
				input.origin ??
				(ownership === "managed" ? "imported" : "external-reference"),
			managedRoot: ownership === "managed" ? managedRoot : null,
			created: nowIso(),
		};
		await this.vault.writeJson(this.filesPath(meta.folderName), {
			items: [...store.items, file],
		});
		return file;
	}

	async registerVaultFile(
		meta: NotebookMeta,
		input: {
			displayName?: string;
			vaultPath: string;
			mime?: string;
			size?: number;
			item_id?: string | null;
			itemName?: string | null;
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
			itemName: input.itemName,
			ownership: "external",
			kind: "backup",
			origin: "external-reference",
		});
	}

	async importBinary(
		meta: NotebookMeta,
		input: {
			displayName: string;
			data: ArrayBuffer;
			mime?: string;
			item_id?: string | null;
			itemName?: string | null;
			kind?: CabinetFileKind;
			origin?: string;
		},
	): Promise<CabinetFile> {
		const kind = input.kind ?? "backup";
		const destDir = structuredAttachmentsDir(
			this.getSettings(),
			meta.notebook_id,
			meta.name,
			input.item_id,
			input.itemName,
			kind,
		);
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
			itemName: input.itemName,
			ownership: "managed",
			kind,
			origin: input.origin ?? "imported",
			managedRoot: destDir,
		});
	}

	async assignFileToItem(
		meta: NotebookMeta,
		fileId: string,
		itemId: string,
		itemName: string,
	): Promise<CabinetFile> {
		const store = await this.readFiles(meta.folderName);
		const target = store.items.find((file) => file.id === fileId);
		if (!target) throw new Error("附件记录不存在");

		let updated: CabinetFile = {
			...target,
			item_id: itemId,
		};
		if (target.ownership === "managed") {
			if (
				!isManagedChildPath(target.vaultPath, target.managedRoot) ||
				!isManagedChildPath(target.vaultPath, attachmentsRoot(this.getSettings())) ||
				isNotebookDataPath(target.vaultPath, this.getSettings())
			) {
				throw new Error("附件路径不属于插件托管目录，不能移动");
			}
			const destDir = structuredAttachmentsDir(
				this.getSettings(),
				meta.notebook_id,
				meta.name,
				itemId,
				itemName,
				target.kind,
			);
			await this.vault.ensureFolder(destDir);
			const baseName = sanitizeFileName(
				target.vaultPath.slice(target.vaultPath.lastIndexOf("/") + 1) ||
					target.displayName,
			);
			const safeName = await uniqueFileName(baseName, async (name) =>
				this.vault.exists(joinPath(destDir, name)),
			);
			const nextPath = joinPath(destDir, safeName);
			if (!sameVaultPath(target.vaultPath, nextPath)) {
				await this.vault.move(target.vaultPath, nextPath);
			}
			updated = {
				...updated,
				vaultPath: nextPath,
				managedRoot: destDir,
			};
		}

		await this.vault.writeJson(this.filesPath(meta.folderName), {
			items: store.items.map((file) => (file.id === fileId ? updated : file)),
		});
		return updated;
	}

	async removeLink(meta: NotebookMeta, linkId: string): Promise<void> {
		const store = await this.readLinks(meta.folderName);
		await this.vault.writeJson(this.linksPath(meta.folderName), {
			items: store.items.filter((link) => link.id !== linkId),
		});
	}

	async removeFile(
		meta: NotebookMeta,
		fileId: string,
		options?: { deleteManagedFile?: boolean },
	): Promise<RemoveCabinetFileResult> {
		const store = await this.readFiles(meta.folderName);
		const target = store.items.find((file) => file.id === fileId);
		const remaining = store.items.filter((file) => file.id !== fileId);
		await this.vault.writeJson(this.filesPath(meta.folderName), {
			items: remaining,
		});
		if (!target) {
			return {
				recordRemoved: false,
				physicalDeleted: false,
				reason: "not-found",
			};
		}
		if (!options?.deleteManagedFile) {
			return {
				recordRemoved: true,
				physicalDeleted: false,
				reason: "record-only",
			};
		}
		if (target.ownership !== "managed") {
			return {
				recordRemoved: true,
				physicalDeleted: false,
				reason: "external",
			};
		}
		if (remaining.some((file) => sameVaultPath(file.vaultPath, target.vaultPath))) {
			return {
				recordRemoved: true,
				physicalDeleted: false,
				reason: "shared-path",
			};
		}
		if (!isManagedChildPath(target.vaultPath, target.managedRoot)) {
			return {
				recordRemoved: true,
				physicalDeleted: false,
				reason: "unsafe-path",
			};
		}
		if (!isManagedChildPath(target.vaultPath, attachmentsRoot(this.getSettings()))) {
			return {
				recordRemoved: true,
				physicalDeleted: false,
				reason: "unsafe-path",
			};
		}
		if (isNotebookDataPath(target.vaultPath, this.getSettings())) {
			return {
				recordRemoved: true,
				physicalDeleted: false,
				reason: "unsafe-path",
			};
		}
		await this.vault.remove(target.vaultPath);
		return {
			recordRemoved: true,
			physicalDeleted: true,
			reason: "deleted",
		};
	}

	async attachIfUrl(
		meta: NotebookMeta,
		item: { item_id: string; url?: unknown; title?: string },
	): Promise<CabinetLink | null> {
		const url = typeof item.url === "string" ? item.url.trim() : "";
		if (!url) return null;
		const existing = await this.listLinks(meta);
		const found = existing.find(
			(link) => link.url === url && link.item_id === item.item_id,
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
		const data = await this.vault.readJson<{ items?: unknown[] }>(path);
		return {
			items: Array.isArray(data.items)
				? data.items.map((item) => normalizeCabinetFile(item))
				: [],
		};
	}
}

function normalizeCabinetFile(raw: unknown): CabinetFile {
	const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const ownership: CabinetFileOwnership =
		item.ownership === "managed" ? "managed" : "external";
	const rawKind = String(item.kind ?? "unknown");
	const kinds: CabinetFileKind[] = [
		"backup",
		"voice",
		"chat",
		"embedded",
		"unknown",
	];
	return {
		id: String(item.id ?? ""),
		displayName: String(item.displayName ?? "file"),
		vaultPath: String(item.vaultPath ?? ""),
		mime: String(item.mime ?? "application/octet-stream"),
		size: Number(item.size ?? 0),
		item_id:
			typeof item.item_id === "string" && item.item_id.trim()
				? item.item_id
				: null,
		ownership,
		kind: kinds.includes(rawKind as CabinetFileKind)
			? (rawKind as CabinetFileKind)
			: "unknown",
		origin: String(
			item.origin ??
				(ownership === "managed" ? "legacy-managed" : "legacy-external"),
		),
		managedRoot:
			ownership === "managed" && typeof item.managedRoot === "string"
				? item.managedRoot
				: null,
		created: String(item.created ?? ""),
	};
}

function isManagedChildPath(path: string, root: string | null): boolean {
	if (!root) return false;
	const normalizedPath = normalizeSafePath(path);
	const normalizedRoot = normalizeSafePath(root);
	if (!normalizedPath || !normalizedRoot) return false;
	return normalizedPath.startsWith(`${normalizedRoot}/`);
}

function isNotebookDataPath(path: string, settings: AiNotebookSettings): boolean {
	const normalized = normalizeSafePath(path);
	const root = normalizeSafePath(notebooksRoot(settings));
	return Boolean(normalized && root && normalized.startsWith(`${root}/`));
}

function sameVaultPath(left: string, right: string): boolean {
	return normalizeSafePath(left) === normalizeSafePath(right);
}

function normalizeSafePath(path: string): string {
	const normalized = path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!normalized || normalized.split("/").some((part) => part === "..")) {
		return "";
	}
	return normalized;
}

function deriveTitleFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const tail = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
		const decoded = decodeURIComponent(tail || parsed.hostname);
		return decoded || parsed.hostname;
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
