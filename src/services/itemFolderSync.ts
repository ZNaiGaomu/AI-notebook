/**
 * Orchestrates item-folder renames across every title-based layout under attachments:
 * - AttachmentService managed index
 * - CabinetService managed files
 * - chat-uploads structured dirs
 * - residual on-disk item folders that still use the old label
 */
import type { AiNotebookSettings, NotebookItem, NotebookMeta } from "../domain/types";
import {
	chatUploadsRoot,
	joinPath,
	pathSegment,
	structuredItemAttachmentsRoot,
} from "../infra/paths";
import type { IVaultFs } from "../infra/vaultPort";
import { isAbsoluteFsPath } from "../infra/folderPick";
import type { AttachmentService } from "./attachmentService";
import type { CabinetService } from "./cabinetService";
import { itemDisplayName } from "./itemDisplayName";

export type PathRewrite = { from: string; to: string };

export type ItemFolderSyncResult = {
	rewrites: PathRewrite[];
};

export async function syncAllItemFolderLayouts(input: {
	vault: IVaultFs;
	settings: AiNotebookSettings;
	meta: NotebookMeta;
	item: NotebookItem;
	/** Filename stem before rename; when omitted, only attachment index migration runs. */
	oldItemLabel?: string | null;
	attachments: AttachmentService;
	cabinet?: CabinetService | null;
}): Promise<ItemFolderSyncResult> {
	const {
		vault,
		settings,
		meta,
		item,
		oldItemLabel,
		attachments,
		cabinet,
	} = input;
	const newLabel = itemDisplayName(item);
	const rewrites: PathRewrite[] = [];

	const attachmentRewrites = await attachments.syncItemFolder(meta, item);
	rewrites.push(...attachmentRewrites);

	if (cabinet) {
		const cabinetRewrites = await cabinet.syncItemFolder(meta, item);
		rewrites.push(...cabinetRewrites);
	}

	const oldLabel = String(oldItemLabel ?? "").trim();
	if (oldLabel && oldLabel !== newLabel) {
		const chatRewrites = await syncStructuredItemTree({
			vault,
			settings,
			meta,
			itemId: item.frontmatter.item_id,
			oldLabel,
			newLabel,
			kind: "chat-uploads",
		});
		rewrites.push(...chatRewrites);

		// Catch residual files under attachments/.../items/{oldLabel} that are not
		// in the attachment index (e.g. dropped files, partial migrations).
		const residual = await syncResidualAttachmentItemFolder({
			vault,
			settings,
			meta,
			itemId: item.frontmatter.item_id,
			oldLabel,
			newLabel,
		});
		rewrites.push(...residual);
	}

	return { rewrites: dedupeRewrites(rewrites) };
}

async function syncStructuredItemTree(input: {
	vault: IVaultFs;
	settings: AiNotebookSettings;
	meta: NotebookMeta;
	itemId: string;
	oldLabel: string;
	newLabel: string;
	kind: "chat-uploads";
}): Promise<PathRewrite[]> {
	const { vault, settings, meta, oldLabel, newLabel } = input;
	const oldItemRoot = joinPath(
		chatUploadsRoot(settings),
		pathSegment(meta.name, "未命名记录本"),
		"items",
		pathSegment(oldLabel, "未命名条目"),
	);
	const newItemRoot = joinPath(
		chatUploadsRoot(settings),
		pathSegment(meta.name, "未命名记录本"),
		"items",
		pathSegment(newLabel, "未命名条目"),
	);
	if (normalize(oldItemRoot) === normalize(newItemRoot)) return [];
	return moveTreeFiles(vault, oldItemRoot, newItemRoot);
}

async function syncResidualAttachmentItemFolder(input: {
	vault: IVaultFs;
	settings: AiNotebookSettings;
	meta: NotebookMeta;
	itemId: string;
	oldLabel: string;
	newLabel: string;
}): Promise<PathRewrite[]> {
	const { vault, settings, meta, oldLabel, newLabel } = input;
	const oldRoot = structuredItemAttachmentsRoot(settings, meta.name, oldLabel);
	const newRoot = structuredItemAttachmentsRoot(settings, meta.name, newLabel);
	if (normalize(oldRoot) === normalize(newRoot)) return [];
	if (!(await pathExists(vault, oldRoot))) return [];
	// Only move residual files still physically under the old label.
	return moveTreeFiles(vault, oldRoot, newRoot);
}

async function moveTreeFiles(
	vault: IVaultFs,
	oldRoot: string,
	newRoot: string,
): Promise<PathRewrite[]> {
	const rewrites: PathRewrite[] = [];
	const oldNorm = normalize(oldRoot);
	const newNorm = normalize(newRoot);
	if (!oldNorm || oldNorm === newNorm) return [];

	if (isAbsoluteFsPath(oldNorm)) {
		return moveAbsoluteTree(oldNorm, newNorm);
	}

	if (!(await vault.exists(oldNorm))) return [];
	const files = vault.listFilesInFolder(oldNorm);
	for (const file of files) {
		const from = normalize(file.path);
		if (!from.startsWith(`${oldNorm}/`) && from !== oldNorm) continue;
		const rel = from.slice(oldNorm.length).replace(/^\//, "");
		const to = joinPath(newNorm, rel);
		if (from === to) continue;
		if (!(await vault.exists(from))) continue;
		await vault.ensureFolder(to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : newNorm);
		const finalTo = await uniqueDest(vault, to);
		await vault.move(from, finalTo);
		if (await vault.exists(finalTo)) {
			rewrites.push({ from, to: finalTo });
		}
	}
	if (vault.removeEmptyFolder && !vault.listFilesInFolder(oldNorm).length) {
		await vault.removeEmptyFolder(oldNorm);
	}
	return rewrites;
}

async function moveAbsoluteTree(
	oldRoot: string,
	newRoot: string,
): Promise<PathRewrite[]> {
	const fs = nodeFs();
	const path = nodePath();
	if (!fs || !path) return [];
	const rewrites: PathRewrite[] = [];
	try {
		await fs.promises.access(oldRoot);
	} catch {
		return [];
	}
	const stack = [oldRoot];
	const files: string[] = [];
	while (stack.length) {
		const dir = stack.pop()!;
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile()) files.push(full);
		}
	}
	for (const from of files) {
		const rel = path.relative(oldRoot, from).replace(/\\/g, "/");
		const to = path.join(newRoot, rel).replace(/\\/g, "/");
		await fs.promises.mkdir(path.dirname(to), { recursive: true });
		const finalTo = await uniqueAbsolute(to);
		await fs.promises.rename(from, finalTo);
		rewrites.push({ from: from.replace(/\\/g, "/"), to: finalTo });
	}
	// best-effort remove empty dirs
	try {
		await fs.promises.rm(oldRoot, { recursive: true, force: false });
	} catch {
		/* non-empty or locked */
	}
	return rewrites;
}

async function uniqueDest(vault: IVaultFs, dest: string): Promise<string> {
	if (!(await vault.exists(dest))) return dest;
	const slash = dest.lastIndexOf("/");
	const dir = slash >= 0 ? dest.slice(0, slash) : "";
	const base = slash >= 0 ? dest.slice(slash + 1) : dest;
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	for (let i = 2; i < 1000; i++) {
		const candidate = joinPath(dir, `${stem}-${i}${ext}`);
		if (!(await vault.exists(candidate))) return candidate;
	}
	return joinPath(dir, `${stem}-${Date.now()}${ext}`);
}

async function uniqueAbsolute(dest: string): Promise<string> {
	const fs = nodeFs();
	const path = nodePath();
	if (!fs || !path) return dest;
	try {
		await fs.promises.access(dest);
	} catch {
		return dest;
	}
	const dir = path.dirname(dest);
	const base = path.basename(dest);
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	for (let i = 2; i < 1000; i++) {
		const candidate = path.join(dir, `${stem}-${i}${ext}`);
		try {
			await fs.promises.access(candidate);
		} catch {
			return candidate.replace(/\\/g, "/");
		}
	}
	return path.join(dir, `${stem}-${Date.now()}${ext}`).replace(/\\/g, "/");
}

async function pathExists(vault: IVaultFs, p: string): Promise<boolean> {
	const n = normalize(p);
	if (!n) return false;
	if (isAbsoluteFsPath(n)) {
		const fs = nodeFs();
		if (!fs) return false;
		try {
			await fs.promises.access(n);
			return true;
		} catch {
			return false;
		}
	}
	return vault.exists(n);
}

function dedupeRewrites(rewrites: PathRewrite[]): PathRewrite[] {
	const seen = new Set<string>();
	const out: PathRewrite[] = [];
	for (const r of rewrites) {
		const key = `${normalize(r.from)}=>${normalize(r.to)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ from: normalize(r.from), to: normalize(r.to) });
	}
	return out;
}

function normalize(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

function nodeFs(): typeof import("fs") | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return require("fs") as typeof import("fs");
	} catch {
		return null;
	}
}

function nodePath(): typeof import("path") | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return require("path") as typeof import("path");
	} catch {
		return null;
	}
}

/** Apply path rewrites to free-form text (bodies, history JSON paths, markers). */
export function applyPathRewrites(text: string, rewrites: PathRewrite[]): string {
	if (!rewrites.length || !text) return text;
	let out = text;
	for (const { from, to } of rewrites) {
		if (!from || from === to) continue;
		out = out.split(from).join(to);
		out = out.split(encodeURIComponent(from)).join(encodeURIComponent(to));
	}
	return out;
}
