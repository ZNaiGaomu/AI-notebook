/**
 * Persist chat uploads for history open/download.
 * Supports vault-relative paths OR absolute OS paths (user-chosen folder).
 */
import type { AiNotebookSettings } from "../domain/types";
import { chatUploadsDir, joinPath } from "../infra/paths";
import { isAbsoluteFsPath } from "../infra/folderPick";
import type { IVaultFs } from "../infra/vaultPort";
import type { PendingChatFile } from "./assistantActions";
import type { ChatMessageAttachment } from "./chatHistoryStore";

export async function persistChatUpload(
	vault: IVaultFs,
	settings: AiNotebookSettings,
	notebookId: string,
	itemId: string | null,
	file: PendingChatFile,
): Promise<PendingChatFile> {
	if (file.vaultPath) return file;

	const destDir = chatUploadsDir(settings, notebookId, itemId);
	const safe = sanitize(file.name);
	const unique = await uniqueName(safe, async (n) =>
		pathExists(vault, joinPath(destDir, n)),
	);
	const fullPath = joinPath(destDir, unique);

	if (isAbsoluteFsPath(destDir)) {
		await writeBinaryAbsolute(fullPath, file.data);
	} else {
		if (!vault.writeBinary) {
			throw new Error("当前环境不支持写入二进制附件");
		}
		await vault.ensureFolder(destDir);
		await vault.writeBinary(fullPath, file.data);
	}

	return { ...file, vaultPath: fullPath, name: file.name || unique };
}

export function toChatMessageAttachments(
	files: PendingChatFile[],
): ChatMessageAttachment[] {
	return files
		.filter((f) => Boolean(f.vaultPath))
		.map((f) => ({
			id: f.id,
			name: f.name,
			mime: f.mime,
			size: f.size,
			vaultPath: f.vaultPath!,
			kind: f.kind,
		}));
}

export async function readStoredBinary(
	vault: IVaultFs,
	storagePath: string,
): Promise<ArrayBuffer> {
	const p = storagePath.replace(/\\/g, "/");
	if (isAbsoluteFsPath(p)) {
		return readBinaryAbsolute(p);
	}
	// vault adapter
	const appVault = (vault as { app?: { vault: { adapter: { readBinary: (x: string) => Promise<ArrayBuffer> } } } }).app;
	if (appVault?.vault?.adapter?.readBinary) {
		return appVault.vault.adapter.readBinary(p);
	}
	// fallback via exists + no read on port — throw
	throw new Error(`无法读取: ${p}`);
}

async function pathExists(vault: IVaultFs, path: string): Promise<boolean> {
	const p = path.replace(/\\/g, "/");
	if (isAbsoluteFsPath(p)) {
		return existsAbsolute(p);
	}
	return vault.exists(p);
}

function sanitize(name: string): string {
	const base = name.replace(/[\\/:*?"<>|]/g, "_").trim() || "file";
	return base.slice(0, 120);
}

async function uniqueName(
	base: string,
	exists: (name: string) => Promise<boolean>,
): Promise<string> {
	if (!(await exists(base))) return base;
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	for (let i = 1; i < 1000; i++) {
		const n = `${stem}-${i}${ext}`;
		if (!(await exists(n))) return n;
	}
	return `${stem}-${Date.now()}${ext}`;
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

async function writeBinaryAbsolute(
	fullPath: string,
	data: ArrayBuffer,
): Promise<void> {
	const fs = nodeFs();
	const path = nodePath();
	if (!fs || !path) {
		throw new Error("无法写入库外路径（需要桌面版 Obsidian）");
	}
	const dir = path.dirname(fullPath);
	await fs.promises.mkdir(dir, { recursive: true });
	await fs.promises.writeFile(fullPath, Buffer.from(data));
}

async function readBinaryAbsolute(fullPath: string): Promise<ArrayBuffer> {
	const fs = nodeFs();
	if (!fs) throw new Error("无法读取库外路径（需要桌面版 Obsidian）");
	const buf = await fs.promises.readFile(fullPath);
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function existsAbsolute(fullPath: string): Promise<boolean> {
	const fs = nodeFs();
	if (!fs) return false;
	try {
		await fs.promises.access(fullPath);
		return true;
	} catch {
		return false;
	}
}
