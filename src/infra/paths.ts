import type { AiNotebookSettings } from "../domain/types";

export function joinPath(...parts: string[]): string {
	return parts
		.map((p, i) => {
			let s = p.replace(/\\/g, "/");
			if (i > 0) s = s.replace(/^\/+/, "");
			// keep Windows drive "C:/" intact on first segment
			if (i === 0 && /^[a-zA-Z]:\//.test(s)) {
				s = s.replace(/\/+$/, "") || s.slice(0, 3);
			} else {
				s = s.replace(/\/+$/, "");
			}
			return s;
		})
		.filter((s, i) => Boolean(s) || (i === 0 && s === ""))
		.join("/");
}

export function notebooksRoot(settings: AiNotebookSettings): string {
	return settings.paths.notebooksRoot.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function notebookFolderPath(
	settings: AiNotebookSettings,
	folderName: string,
): string {
	return joinPath(notebooksRoot(settings), folderName);
}

export function notebookMetaPath(
	settings: AiNotebookSettings,
	folderName: string,
): string {
	return joinPath(notebookFolderPath(settings, folderName), "_notebook.md");
}

export function blueprintsDir(
	settings: AiNotebookSettings,
	folderName: string,
): string {
	return joinPath(notebookFolderPath(settings, folderName), "blueprints");
}

export function blueprintFilePath(
	settings: AiNotebookSettings,
	folderName: string,
	version: number,
): string {
	const file = `v${String(version).padStart(4, "0")}.json`;
	return joinPath(blueprintsDir(settings, folderName), file);
}

export function blueprintIndexPath(
	settings: AiNotebookSettings,
	folderName: string,
): string {
	return joinPath(blueprintsDir(settings, folderName), "index.json");
}

export function itemsDir(
	settings: AiNotebookSettings,
	folderName: string,
): string {
	return joinPath(notebookFolderPath(settings, folderName), "items");
}

export function cabinetDir(
	settings: AiNotebookSettings,
	folderName: string,
): string {
	return joinPath(notebookFolderPath(settings, folderName), "cabinet");
}

export function trashItemsDir(
	settings: AiNotebookSettings,
	folderName: string,
): string {
	return joinPath(notebookFolderPath(settings, folderName), ".trash", "items");
}

export function attachmentsDir(
	settings: AiNotebookSettings,
	notebookId: string,
): string {
	return joinPath(
		settings.paths.attachmentsRoot.replace(/\\/g, "/").replace(/\/+$/, ""),
		notebookId,
	);
}

/**
 * Root for assistant chat uploads (history / re-download).
 * May be vault-relative OR absolute (user picked any disk folder).
 * Default: `{attachmentsRoot}/chat-uploads`
 */
export function chatUploadsRoot(settings: AiNotebookSettings): string {
	const custom = settings.paths.chatUploadsRoot?.trim();
	if (custom) {
		return custom.replace(/\\/g, "/").replace(/\/+$/, "");
	}
	const att = settings.paths.attachmentsRoot
		.replace(/\\/g, "/")
		.replace(/\/+$/, "");
	return joinPath(att, "chat-uploads");
}

/** Per notebook (+ optional item) folder for chat-upload archive. */
export function chatUploadsDir(
	settings: AiNotebookSettings,
	notebookId: string,
	itemId?: string | null,
): string {
	const root = chatUploadsRoot(settings);
	if (itemId) return joinPath(root, notebookId, itemId);
	return joinPath(root, notebookId);
}

export function inboxRoot(settings: AiNotebookSettings): string {
	return settings.paths.inboxRoot.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function inboxPendingDir(settings: AiNotebookSettings): string {
	return joinPath(inboxRoot(settings), "pending");
}

export function inboxProcessedDir(settings: AiNotebookSettings): string {
	return joinPath(inboxRoot(settings), "processed");
}

export function inboxVoiceDir(settings: AiNotebookSettings): string {
	return joinPath(inboxRoot(settings), "voice-raw");
}

/** Sanitize folder display name for vault path segment. */
export function sanitizeFolderName(name: string): string {
	const cleaned = name
		.trim()
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/\s+/g, " ")
		.slice(0, 80);
	return cleaned || "untitled-notebook";
}
