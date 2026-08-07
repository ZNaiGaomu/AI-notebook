import { itemDisplayName } from "./itemDisplayName";
import type { AiNotebookSettings, NotebookMeta } from "../domain/types";
import { createId, nowIso } from "../domain/ids";
import {
	attachmentsRoot,
	joinPath,
	notebookAttachmentsIndexPath,
	notebooksRoot,
	pathSegment,
	structuredAttachmentsDir,
	structuredItemAttachmentsRoot,
} from "../infra/paths";
import type { NotebookItem } from "../domain/types";
import type { IVaultFs } from "../infra/vaultPort";

export type AttachmentOwnership = "managed" | "external";
export type AttachmentKind =
	| "backup"
	| "voice"
	| "chat"
	| "embedded"
	| "unknown";

export type AttachmentRecord = {
	id: string;
	displayName: string;
	vaultPath: string;
	mime: string;
	size: number;
	item_id: string | null;
	ownership: AttachmentOwnership;
	kind: AttachmentKind;
	origin: string;
	managedRoot: string | null;
	created: string;
};

export type RemoveAttachmentResult = {
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

type AttachmentStore = { items: AttachmentRecord[] };

/**
 * Independent attachment management (not 收藏柜).
 * Index lives at AI Notebooks/<folder>/attachments/index.json.
 * Physical files still use structuredAttachmentsDir under attachmentsRoot.
 */
export class AttachmentService {
	constructor(
		private readonly vault: IVaultFs,
		private readonly getSettings: () => AiNotebookSettings,
	) {}

	async list(meta: NotebookMeta): Promise<AttachmentRecord[]> {
		const store = await this.readStore(meta.folderName);
		return store.items;
	}

	async listByItem(
		meta: NotebookMeta,
		itemId: string,
	): Promise<AttachmentRecord[]> {
		const all = await this.list(meta);
		return all.filter((a) => a.item_id === itemId);
	}

	async findById(
		meta: NotebookMeta,
		id: string,
	): Promise<AttachmentRecord | null> {
		const all = await this.list(meta);
		return all.find((a) => a.id === id) ?? null;
	}

	/**
	 * Import binary into managed attachment storage and index it.
	 * Prefer providing item_id so the file lands under the final item path.
	 */
	async importBinary(
		meta: NotebookMeta,
		input: {
			displayName: string;
			data: ArrayBuffer;
			mime?: string;
			item_id?: string | null;
			itemName?: string | null;
			kind?: AttachmentKind;
			origin?: string;
		},
	): Promise<AttachmentRecord> {
		const kind = input.kind ?? "backup";
		const itemLabel = input.item_id
			? await this.resolveItemFolderLabel(meta, input.item_id, input.itemName)
			: null;
		const destDir = structuredAttachmentsDir(
			this.getSettings(),
			meta.notebook_id,
			meta.name,
			input.item_id,
			itemLabel ?? input.itemName,
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
		return this.addRecord(meta, {
			displayName: input.displayName || safeName,
			vaultPath,
			mime: input.mime ?? guessMime(safeName),
			size: input.data.byteLength,
			item_id: input.item_id ?? null,
			ownership: "managed",
			kind,
			origin: input.origin ?? "imported",
			managedRoot: destDir,
		});
	}

	/**
	 * Register an already-written managed file (e.g. voice pipeline saved audio).
	 */
	async registerManaged(
		meta: NotebookMeta,
		input: {
			displayName: string;
			vaultPath: string;
			mime?: string;
			size?: number;
			item_id?: string | null;
			kind?: AttachmentKind;
			origin?: string;
			managedRoot?: string | null;
		},
	): Promise<AttachmentRecord> {
		const vaultPath = input.vaultPath.trim();
		if (!vaultPath) throw new Error("文件路径不能为空");
		const managedRoot =
			input.managedRoot ??
			(vaultPath.slice(0, Math.max(0, vaultPath.lastIndexOf("/"))) || null);
		return this.addRecord(meta, {
			displayName: input.displayName,
			vaultPath,
			mime: input.mime ?? guessMime(input.displayName),
			size: input.size ?? 0,
			item_id: input.item_id ?? null,
			ownership: "managed",
			kind: input.kind ?? "backup",
			origin: input.origin ?? "managed-register",
			managedRoot,
		});
	}

	/** External vault path reference only — never physically deleted by this service. */
	async registerExternal(
		meta: NotebookMeta,
		input: {
			displayName?: string;
			vaultPath: string;
			mime?: string;
			size?: number;
			item_id?: string | null;
			kind?: AttachmentKind;
			origin?: string;
		},
	): Promise<AttachmentRecord> {
		const vaultPath = input.vaultPath.trim();
		if (!vaultPath) throw new Error("文件路径不能为空");
		if (!(await this.vault.exists(vaultPath))) {
			throw new Error(`文件不存在: ${vaultPath}`);
		}
		const displayName =
			(input.displayName ?? "").trim() ||
			vaultPath.slice(vaultPath.lastIndexOf("/") + 1) ||
			"file";
		return this.addRecord(meta, {
			displayName,
			vaultPath,
			mime: input.mime ?? guessMime(displayName),
			size: input.size ?? 0,
			item_id: input.item_id ?? null,
			ownership: "external",
			kind: input.kind ?? "backup",
			origin: input.origin ?? "external-reference",
			managedRoot: null,
		});
	}

	async assignToItem(
		meta: NotebookMeta,
		attachmentId: string,
		itemId: string,
		itemName: string,
	): Promise<AttachmentRecord> {
		const store = await this.readStore(meta.folderName);
		const target = store.items.find((a) => a.id === attachmentId);
		if (!target) throw new Error("附件记录不存在");

		let updated: AttachmentRecord = {
			...target,
			item_id: itemId,
		};

		if (target.ownership === "managed") {
			if (
				!isManagedChildPath(target.vaultPath, target.managedRoot) ||
				!isManagedChildPath(
					target.vaultPath,
					attachmentsRoot(this.getSettings()),
				) ||
				isNotebookDataPath(target.vaultPath, this.getSettings())
			) {
				throw new Error("附件路径不属于插件托管目录，不能移动");
			}
			const itemLabel = await this.resolveItemFolderLabel(
				meta,
				itemId,
				itemName,
			);
			const destDir = structuredAttachmentsDir(
				this.getSettings(),
				meta.notebook_id,
				meta.name,
				itemId,
				itemLabel,
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
				if (!(await this.vault.exists(target.vaultPath))) {
					throw new Error("附件文件不存在，不能移动");
				}
				await this.vault.move(target.vaultPath, nextPath);
				if (!(await this.vault.exists(nextPath))) {
					throw new Error("附件移动失败，目标文件不存在");
				}
			} else if (!(await this.vault.exists(nextPath))) {
				throw new Error("附件文件不存在，不能移动");
			}
			updated = {
				...updated,
				vaultPath: nextPath,
				managedRoot: destDir,
			};
		}

		await this.writeStore(meta.folderName, {
			items: store.items.map((a) => (a.id === attachmentId ? updated : a)),
		});
		return updated;
	}

	/**
	 * Resolve a stable, human-readable item folder label under this notebook.
	 * Prefers pure title; reuses existing folder for same item_id; suffixes on collision.
	 */
	async resolveItemFolderLabel(
		meta: NotebookMeta,
		itemId: string,
		itemName: string | null | undefined,
	): Promise<string> {
		const store = await this.readStore(meta.folderName);
		const base = pathSegment(itemName, "未命名条目");
		for (const rec of store.items) {
			if (rec.item_id !== itemId || rec.ownership !== "managed") continue;
			const label = extractItemFolderLabel(rec.vaultPath, meta.name);
			if (label) return label;
		}
		const used = new Set<string>();
		for (const rec of store.items) {
			if (rec.item_id === itemId) continue;
			const label = extractItemFolderLabel(rec.vaultPath, meta.name);
			if (label) used.add(label);
		}
		const itemsRoot = joinPath(
			attachmentsRoot(this.getSettings()),
			pathSegment(meta.name, "未命名记录本"),
			"items",
		);
		for (const folder of this.vault.listImmediateFolders(itemsRoot)) {
			// Empty residue from an interrupted rename must not force a suffix.
			if (!this.vault.listFilesInFolder(folder.path).length) continue;
			used.add(folder.name);
		}
		let candidate = base;
		let n = 2;
		while (used.has(candidate)) {
			const owned = store.items.some(
				(r) =>
					r.item_id === itemId &&
					extractItemFolderLabel(r.vaultPath, meta.name) === candidate,
			);
			if (owned) break;
			candidate = `${base}-${n}`;
			n += 1;
			if (n > 200) break;
		}
		return candidate;
	}

	async syncItemFolder(
		meta: NotebookMeta,
		item: NotebookItem,
	): Promise<Array<{ from: string; to: string }>> {
		return this.syncItemTitle(
			meta,
			item.frontmatter.item_id,
			itemDisplayName(item),
		);
	}

	/** Move managed files into the stable filename-based item folder. */
	async migrateItemFolders(
		meta: NotebookMeta,
		items: NotebookItem[],
	): Promise<Map<string, Array<{ from: string; to: string }>>> {
		const migrated = new Map<string, Array<{ from: string; to: string }>>();
		for (const item of items) {
			const rewrites = await this.syncItemFolder(meta, item);
			if (rewrites.length) migrated.set(item.frontmatter.item_id, rewrites);
		}
		return migrated;
	}

	/**
	 * When item title changes: rename managed attachment folders and return path rewrites
	 * for updating ![[old]] in markdown bodies.
	 */
	async syncItemTitle(
		meta: NotebookMeta,
		itemId: string,
		newTitle: string,
	): Promise<Array<{ from: string; to: string }>> {
		const store = await this.readStore(meta.folderName);
		const owned = store.items.filter(
			(r) => r.item_id === itemId && r.ownership === "managed",
		);
		if (!owned.length) return [];

		const sameItemLabels = new Set(
			owned
				.map((r) => extractItemFolderLabel(r.vaultPath, meta.name))
				.filter((x): x is string => Boolean(x)),
		);
		const others = new Set<string>();
		for (const rec of store.items) {
			if (rec.item_id === itemId) continue;
			const label = extractItemFolderLabel(rec.vaultPath, meta.name);
			if (label) others.add(label);
		}
		const itemsRoot = joinPath(
			attachmentsRoot(this.getSettings()),
			pathSegment(meta.name, "未命名记录本"),
			"items",
		);
		for (const folder of this.vault.listImmediateFolders(itemsRoot)) {
			if (sameItemLabels.has(folder.name)) continue;
			// Empty leftover folders must not force a -2 suffix for this item.
			const nested = this.vault.listFilesInFolder(folder.path);
			if (!nested.length) continue;
			others.add(folder.name);
		}
		let nextLabel = pathSegment(newTitle, "未命名条目");
		let n = 2;
		const baseLabel = nextLabel;
		while (others.has(nextLabel)) {
			nextLabel = `${baseLabel}-${n}`;
			n += 1;
			if (n > 200) break;
		}
		const alreadyOnNext = owned.every((r) => {
			const label = extractItemFolderLabel(r.vaultPath, meta.name);
			return label === nextLabel;
		});
		if (alreadyOnNext) return [];

		const rewrites: Array<{ from: string; to: string }> = [];
		const nextItems = [...store.items];
		for (const rec of owned) {
			const kind = rec.kind || "backup";
			const destDir = structuredAttachmentsDir(
				this.getSettings(),
				meta.notebook_id,
				meta.name,
				itemId,
				nextLabel,
				kind,
			);
			await this.vault.ensureFolder(destDir);
			const currentLabel = extractItemFolderLabel(rec.vaultPath, meta.name);
			if (currentLabel === nextLabel) {
				const idx = nextItems.findIndex((x) => x.id === rec.id);
				if (idx >= 0 && rec.managedRoot !== destDir) {
					nextItems[idx] = { ...rec, managedRoot: destDir };
				}
				continue;
			}
			const baseName = sanitizeFileName(
				rec.vaultPath.slice(rec.vaultPath.lastIndexOf("/") + 1) ||
					rec.displayName,
			);
			const safeName = await uniqueFileName(baseName, async (name) =>
				this.vault.exists(joinPath(destDir, name)),
			);
			const nextPath = joinPath(destDir, safeName);
			if (sameVaultPath(rec.vaultPath, nextPath)) {
				const idx = nextItems.findIndex((x) => x.id === rec.id);
				if (idx >= 0) {
					nextItems[idx] = {
						...rec,
						vaultPath: nextPath,
						managedRoot: destDir,
					};
				}
				continue;
			}
			if (!(await this.vault.exists(rec.vaultPath))) {
				// Keep the stale index entry as-is; never rewrite body to a missing path.
				continue;
			}
			await this.vault.move(rec.vaultPath, nextPath);
			if (!(await this.vault.exists(nextPath))) {
				continue;
			}
			rewrites.push({ from: rec.vaultPath, to: nextPath });
			const idx = nextItems.findIndex((x) => x.id === rec.id);
			if (idx >= 0) {
				nextItems[idx] = {
					...rec,
					vaultPath: nextPath,
					managedRoot: destDir,
				};
			}
		}
		const changed = nextItems.some((rec, i) => {
				const prev = store.items[i];
				return (
					!prev ||
					prev.id !== rec.id ||
					prev.vaultPath !== rec.vaultPath ||
					prev.managedRoot !== rec.managedRoot
				);
			});
		if (rewrites.length || changed) {
			await this.writeStore(meta.folderName, { items: nextItems });
		}
		if (rewrites.length && this.vault.removeEmptyFolder) {
			const oldLabels = [...sameItemLabels].filter((label) => label !== nextLabel);
			for (const label of oldLabels) {
				const oldRoot = structuredItemAttachmentsRoot(
					this.getSettings(),
					meta.name,
					label,
				);
				if (!this.vault.listFilesInFolder(oldRoot).length) {
					await this.vault.removeEmptyFolder(oldRoot);
				}
			}
		}
		return rewrites;
	}

	/**
	 * Move an existing vault file into this item's attachment folder and register it.
	 */
	async absorbVaultFile(
		meta: NotebookMeta,
		input: {
			vaultPath: string;
			item_id: string;
			itemName: string;
			displayName?: string;
			kind?: AttachmentKind;
			origin?: string;
			mime?: string;
		},
	): Promise<{ record: AttachmentRecord; from: string; to: string } | null> {
		const from = input.vaultPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (!from) return null;
		if (!(await this.vault.exists(from))) return null;
		const existing = (await this.list(meta)).find(
			(r) => sameVaultPath(r.vaultPath, from) && r.item_id === input.item_id,
		);
		if (existing) {
			return { record: existing, from, to: existing.vaultPath };
		}

		const itemLabel = await this.resolveItemFolderLabel(
			meta,
			input.item_id,
			input.itemName,
		);
		const kind = input.kind ?? "backup";
		const destDir = structuredAttachmentsDir(
			this.getSettings(),
			meta.notebook_id,
			meta.name,
			input.item_id,
			itemLabel,
			kind,
		);
		await this.vault.ensureFolder(destDir);
		const displayName =
			(input.displayName ?? "").trim() ||
			from.slice(from.lastIndexOf("/") + 1) ||
			"file";
		const baseName = sanitizeFileName(displayName);
		const safeName = await uniqueFileName(baseName, async (name) =>
			this.vault.exists(joinPath(destDir, name)),
		);
		const to = joinPath(destDir, safeName);
		if (!sameVaultPath(from, to)) {
			if (
				isNotebookDataPath(from, this.getSettings()) &&
				from.includes("/items/") &&
				from.endsWith(".md")
			) {
				return null;
			}
			await this.vault.move(from, to);
		}
		const record = await this.addRecord(meta, {
			displayName,
			vaultPath: to,
			mime: input.mime ?? guessMime(displayName),
			size: 0,
			item_id: input.item_id,
			ownership: "managed",
			kind,
			origin: input.origin ?? "absorbed",
			managedRoot: destDir,
		});
		return { record, from, to };
	}

	/** Rewrite wiki embeds in markdown body according to path moves. */
	rewriteEmbedPaths(
		body: string,
		rewrites: Array<{ from: string; to: string }>,
	): string {
		if (!rewrites.length) return body;
		let out = body;
		for (const { from, to } of rewrites) {
			const a = from.replace(/\\/g, "/");
			const b = to.replace(/\\/g, "/");
			if (!a || a === b) continue;
			out = out.split(`![[${a}]]`).join(`![[${b}]]`);
			out = out.split(`[[${a}]]`).join(`[[${b}]]`);
			// Voice block markers keep an encoded copy of the same attachment path.
			out = out.split(encodeURIComponent(a)).join(encodeURIComponent(b));
			const base = a.slice(a.lastIndexOf("/") + 1);
			if (base) {
				out = out.split(`![[${base}]]`).join(`![[${b}]]`);
			}
		}
		return out;
	}

	/**
	 * Scan item body for embeds pointing at loose vault files; absorb into item folder.
	 */
	async absorbEmbedsInItem(
		meta: NotebookMeta,
		item: NotebookItem,
	): Promise<{ item: NotebookItem; rewrites: Array<{ from: string; to: string }> }> {
		const embeds = [
			...item.body.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g),
		].map((m) => m[1]!.trim().replace(/\\/g, "/"));
		if (!embeds.length) return { item, rewrites: [] };
		const rewrites: Array<{ from: string; to: string }> = [];
		const itemLabel = await this.resolveItemFolderLabel(
			meta,
			item.frontmatter.item_id,
			item.frontmatter.title,
		);
		const itemRoot = structuredItemAttachmentsRoot(
			this.getSettings(),
			meta.name,
			itemLabel,
		);
		const rootNorm = normalizeSafePath(itemRoot);

		for (const emb of embeds) {
			const path = emb.replace(/^\.\//, "");
			if (!path || path.endsWith(".md")) continue;
			const norm = normalizeSafePath(path);
			if (!norm) continue;
			if (rootNorm && norm.startsWith(`${rootNorm}/`)) continue;
			if (
				isNotebookDataPath(path, this.getSettings()) &&
				path.includes("/items/") &&
				path.endsWith(".md")
			) {
				continue;
			}
			if (!(await this.vault.exists(path))) continue;
			try {
				const absorbed = await this.absorbVaultFile(meta, {
					vaultPath: path,
					item_id: item.frontmatter.item_id,
					itemName: itemLabel,
					kind: "backup",
					origin: "body-embed-absorb",
				});
				if (absorbed && absorbed.from !== absorbed.to) {
					rewrites.push({ from: absorbed.from, to: absorbed.to });
				}
			} catch {
				// keep original embed if absorb fails
			}
		}
		if (!rewrites.length) return { item, rewrites: [] };
		return {
			item: { ...item, body: this.rewriteEmbedPaths(item.body, rewrites) },
			rewrites,
		};
	}

	/**
	 * Default: remove index record only (body embeds stay; file stays).
	 * Optional physical delete for managed files with path guards.
	 * Never touches item Markdown.
	 */
	async remove(
		meta: NotebookMeta,
		attachmentId: string,
		options?: { deleteManagedFile?: boolean },
	): Promise<RemoveAttachmentResult> {
		const store = await this.readStore(meta.folderName);
		const target = store.items.find((a) => a.id === attachmentId);
		const remaining = store.items.filter((a) => a.id !== attachmentId);
		await this.writeStore(meta.folderName, { items: remaining });

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
		if (remaining.some((a) => sameVaultPath(a.vaultPath, target.vaultPath))) {
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
		if (
			!isManagedChildPath(
				target.vaultPath,
				attachmentsRoot(this.getSettings()),
			)
		) {
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

	private async addRecord(
		meta: NotebookMeta,
		input: {
			displayName: string;
			vaultPath: string;
			mime: string;
			size: number;
			item_id: string | null;
			ownership: AttachmentOwnership;
			kind: AttachmentKind;
			origin: string;
			managedRoot: string | null;
		},
	): Promise<AttachmentRecord> {
		const store = await this.readStore(meta.folderName);
		const record: AttachmentRecord = {
			id: createId(),
			displayName: input.displayName,
			vaultPath: input.vaultPath,
			mime: input.mime,
			size: input.size,
			item_id: input.item_id,
			ownership: input.ownership,
			kind: input.kind,
			origin: input.origin,
			managedRoot:
				input.ownership === "managed" ? input.managedRoot : null,
			created: nowIso(),
		};
		await this.writeStore(meta.folderName, {
			items: [...store.items, record],
		});
		return record;
	}

	private async readStore(folderName: string): Promise<AttachmentStore> {
		const path = notebookAttachmentsIndexPath(this.getSettings(), folderName);
		if (!(await this.vault.exists(path))) {
			const empty: AttachmentStore = { items: [] };
			await this.vault.ensureFolder(
				path.slice(0, Math.max(0, path.lastIndexOf("/"))),
			);
			await this.vault.writeJson(path, empty);
			return empty;
		}
		const data = await this.vault.readJson<{ items?: unknown[] }>(path);
		return {
			items: Array.isArray(data.items)
				? data.items.map((item) => normalizeAttachment(item))
				: [],
		};
	}

	private async writeStore(
		folderName: string,
		store: AttachmentStore,
	): Promise<void> {
		const path = notebookAttachmentsIndexPath(this.getSettings(), folderName);
		await this.vault.ensureFolder(
			path.slice(0, Math.max(0, path.lastIndexOf("/"))),
		);
		await this.vault.writeJson(path, store);
	}
}

/** Body embed for viewing; stable id comment so attachment delete ≠ body delete. */
export function buildAttachmentEmbedMarkdown(
	record: Pick<AttachmentRecord, "id" | "vaultPath" | "displayName" | "mime">,
	opts?: { caption?: string },
): string {
	const path = record.vaultPath.replace(/\\/g, "/");
	const mime = (record.mime || "").toLowerCase();
	const name = record.displayName || path;
	const isMedia =
		mime.startsWith("image/") ||
		mime.startsWith("video/") ||
		mime.startsWith("audio/") ||
		/\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|mp3|wav|m4a|ogg|pdf)$/i.test(
			name,
		);
	const media = isMedia ? `![[${path}]]` : `[[${path}|${name}]]`;
	const cap = opts?.caption?.trim() ? `\n\n${opts.caption.trim()}` : "";
	return `<!-- ai-notebook-attachment:${record.id} -->\n${media}${cap}`;
}

function normalizeAttachment(raw: unknown): AttachmentRecord {
	const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const ownership: AttachmentOwnership =
		item.ownership === "managed" ? "managed" : "external";
	const rawKind = String(item.kind ?? "unknown");
	const kinds: AttachmentKind[] = [
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
		kind: kinds.includes(rawKind as AttachmentKind)
			? (rawKind as AttachmentKind)
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


function extractItemFolderLabel(
	vaultPath: string,
	notebookName: string,
): string | null {
	const norm = normalizeSafePath(vaultPath);
	if (!norm) return null;
	const nb = pathSegment(notebookName, "未命名记录本");
	const marker = `/${nb}/items/`;
	const idx = norm.indexOf(marker);
	if (idx >= 0) {
		const rest = norm.slice(idx + marker.length);
		const label = rest.split("/")[0] || "";
		return label || null;
	}
	const legacy = norm.match(/\/items\/(item-[^/]+)(?:\/|$)/);
	if (legacy?.[1]) {
		const seg = legacy[1];
		const parts = seg.split("__");
		if (parts.length >= 2) return parts.slice(1).join("__");
		return seg;
	}
	return null;
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
	if (lower.endsWith(".m4a")) return "audio/mp4";
	if (lower.endsWith(".mp4")) return "video/mp4";
	if (lower.endsWith(".webm")) return "video/webm";
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
