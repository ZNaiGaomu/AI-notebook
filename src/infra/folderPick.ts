/**
 * Desktop folder picker (any drive).
 * Uses Electron dialog when available; falls back to prompt.
 */
export async function pickAnyDirectory(opts?: {
	title?: string;
	defaultPath?: string;
}): Promise<string | null> {
	const options = {
		title: opts?.title ?? "选择文件夹",
		defaultPath: opts?.defaultPath,
		properties: ["openDirectory", "createDirectory"] as Array<
			"openDirectory" | "createDirectory"
		>,
	};

	try {
		// Obsidian desktop (Electron): try remote then dialog
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const g = globalThis as any;
		const electron =
			g.require?.("electron") ??
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			(typeof require !== "undefined" ? require("electron") : null);

		if (electron?.remote?.dialog?.showOpenDialog) {
			const result = await electron.remote.dialog.showOpenDialog(options);
			if (!result.canceled && result.filePaths?.[0]) {
				return result.filePaths[0] as string;
			}
			return null;
		}

		if (electron?.dialog?.showOpenDialog) {
			// Some builds expose dialog without browserWindow arg
			const result = await electron.dialog.showOpenDialog(options);
			if (!result.canceled && result.filePaths?.[0]) {
				return result.filePaths[0] as string;
			}
			return null;
		}
	} catch (e) {
		console.warn("[ai-notebook] folder pick dialog failed", e);
	}

	const typed = window.prompt(
		opts?.title ??
			"请输入文件夹完整路径（可含盘符，如 D:\\MyChatUploads）",
		opts?.defaultPath ?? "",
	);
	const v = typed?.trim();
	return v || null;
}

export function isAbsoluteFsPath(p: string): boolean {
	const s = p.trim().replace(/\\/g, "/");
	if (!s) return false;
	if (/^[a-zA-Z]:\//.test(s)) return true;
	if (s.startsWith("//")) return true;
	// POSIX absolute (not relative vault path)
	if (s.startsWith("/") && !s.startsWith("./")) return true;
	return false;
}
