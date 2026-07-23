/**
 * Storage port used by domain services.
 * VaultIo (Obsidian) and MemoryVaultIo (tests) both implement this.
 */
export type VaultFileRef = {
	path: string;
	extension: string;
};

export type VaultFolderRef = {
	name: string;
	path: string;
};

export interface IVaultFs {
	normalize(path: string): string;
	ensureFolder(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	readJson<T>(path: string): Promise<T>;
	write(path: string, content: string): Promise<unknown>;
	writeJson(path: string, data: unknown): Promise<unknown>;
	/** Binary files (audio, images). Optional for pure-text mocks. */
	writeBinary?(path: string, data: ArrayBuffer): Promise<unknown>;
	remove(path: string): Promise<void>;
	move(from: string, to: string): Promise<void>;
	listFilesInFolder(folderPath: string): VaultFileRef[];
	listImmediateFolders(folderPath: string): VaultFolderRef[];
}
