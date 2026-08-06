import type { NotebookItem } from "../domain/types";

/** The stable user-facing name for an item is its items/*.md filename stem. */
export function itemDisplayNameFromPath(path: string): string {
	const normalized = String(path || "").replace(/\\/g, "/");
	const filename = normalized.slice(normalized.lastIndexOf("/") + 1);
	return filename.replace(/\.md$/i, "").trim();
}

export function itemDisplayName(item: Pick<NotebookItem, "path">): string {
	return itemDisplayNameFromPath(item.path) || "未命名";
}
