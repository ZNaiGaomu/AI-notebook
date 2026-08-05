import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import { cabinetDir, joinPath } from "../src/infra/paths";
import { MemoryVault } from "../src/infra/memoryVault";
import { CabinetService } from "../src/services/cabinetService";
import { NotebookService } from "../src/services/notebookService";
import { VersionService } from "../src/services/versionService";
import { ItemService } from "../src/services/itemService";

describe("CabinetService P3", () => {
	it("adds links, files and removes only cabinet registrations by default", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const cabinet = new CabinetService(vault, () => settings);
		const items = new ItemService(vault, versions, () => settings);

		const meta = await notebooks.createNotebook({
			name: "柜测试",
			templateId: "cabinet-first",
		});

		const link = await cabinet.addLink(meta, {
			url: "https://example.com/papers/deep-learning.pdf",
			title: "",
		});
		const parsed = await cabinet.parseLinkTitle(meta, link.id);
		expect(parsed.title).toBe("deep-learning.pdf");

		const item = await items.createItem(meta, { title: "clip" });
		const file = await cabinet.addFileRef(meta, {
			displayName: "notes.txt",
			vaultPath: "",
			textContent: "hello cabinet",
			mime: "text/plain",
			item_id: item.frontmatter.item_id,
			itemName: item.frontmatter.title,
		});
		expect(file.ownership).toBe("managed");
		expect(file.kind).toBe("backup");
		expect(file.vaultPath).toContain(meta.name);
		expect(file.vaultPath).toContain(item.frontmatter.title);
		expect(await vault.read(file.vaultPath)).toBe("hello cabinet");

		const itemRawBefore = await vault.read(item.path);
		const removed = await cabinet.removeFile(meta, file.id);
		expect(removed).toMatchObject({
			recordRemoved: true,
			physicalDeleted: false,
			reason: "record-only",
		});
		expect(await cabinet.listFiles(meta)).toHaveLength(0);
		expect(await vault.exists(file.vaultPath)).toBe(true);
		expect(await vault.read(item.path)).toBe(itemRawBefore);
	});

	it("never physically deletes external or legacy records", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const cabinet = new CabinetService(vault, () => settings);
		const meta = await notebooks.createNotebook({
			name: "外部文件",
			templateId: "cabinet-first",
		});

		await vault.write("notes/hello.md", "# hi");
		const registered = await cabinet.registerVaultFile(meta, {
			vaultPath: "notes/hello.md",
		});
		expect(registered.ownership).toBe("external");
		const externalResult = await cabinet.removeFile(meta, registered.id, {
			deleteManagedFile: true,
		});
		expect(externalResult.reason).toBe("external");
		expect(await vault.exists("notes/hello.md")).toBe(true);

		await vault.write("notes/legacy.pdf", "legacy");
		const filesPath = joinPath(cabinetDir(settings, meta.folderName), "files.json");
		await vault.writeJson(filesPath, {
			items: [
				{
					id: "legacy-file",
					displayName: "legacy.pdf",
					vaultPath: "notes/legacy.pdf",
					mime: "application/pdf",
					size: 6,
					item_id: null,
					created: "",
				},
			],
		});
		const [legacy] = await cabinet.listFiles(meta);
		expect(legacy?.ownership).toBe("external");
		const legacyResult = await cabinet.removeFile(meta, "legacy-file", {
			deleteManagedFile: true,
		});
		expect(legacyResult.reason).toBe("external");
		expect(await vault.exists("notes/legacy.pdf")).toBe(true);
	});

	it("deletes only an explicitly requested, unshared managed backup", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const cabinet = new CabinetService(vault, () => settings);
		const meta = await notebooks.createNotebook({
			name: "托管附件",
			templateId: "cabinet-first",
		});
		const bin = new TextEncoder().encode("pdf-bytes").buffer;

		const imported = await cabinet.importBinary(meta, {
			displayName: "paper.pdf",
			data: bin,
			mime: "application/pdf",
			item_id: "item-1",
			itemName: "论文 A",
			origin: "desktop-import",
		});
		expect(imported.ownership).toBe("managed");
		expect(imported.origin).toBe("desktop-import");
		expect(imported.item_id).toBe("item-1");
		expect(imported.vaultPath).toContain("论文 A");
		expect(await vault.exists(imported.vaultPath)).toBe(true);

		const duplicate = await cabinet.addFileRef(meta, {
			displayName: "paper shared.pdf",
			vaultPath: imported.vaultPath,
			ownership: "managed",
			managedRoot: imported.managedRoot ?? undefined,
			origin: "shared-test",
		});
		const sharedResult = await cabinet.removeFile(meta, imported.id, {
			deleteManagedFile: true,
		});
		expect(sharedResult.reason).toBe("shared-path");
		expect(await vault.exists(imported.vaultPath)).toBe(true);

		const deleted = await cabinet.removeFile(meta, duplicate.id, {
			deleteManagedFile: true,
		});
		expect(deleted.reason).toBe("deleted");
		expect(deleted.physicalDeleted).toBe(true);
		expect(await vault.exists(imported.vaultPath)).toBe(false);
	});

	it("refuses to physically delete notebook Markdown even if marked managed", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const cabinet = new CabinetService(vault, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "主数据保护",
			templateId: "blank",
		});
		const item = await items.createItem(meta, { title: "不能删除" });
		const unsafe = await cabinet.addFileRef(meta, {
			displayName: "不能删除.md",
			vaultPath: item.path,
			ownership: "managed",
			managedRoot: item.path.slice(0, item.path.lastIndexOf("/")),
		});

		const result = await cabinet.removeFile(meta, unsafe.id, {
			deleteManagedFile: true,
		});
		expect(result.reason).toBe("unsafe-path");
		expect(await vault.exists(item.path)).toBe(true);
	});

	it("moves an unlinked managed backup into its item folder", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const cabinet = new CabinetService(vault, () => settings);
		const meta = await notebooks.createNotebook({
			name: "手机归属",
			templateId: "blank",
		});
		const uploaded = await cabinet.importBinary(meta, {
			displayName: "mobile.pdf",
			data: new TextEncoder().encode("mobile").buffer,
			origin: "mobile-upload",
		});
		expect(uploaded.vaultPath).toContain("_unlinked/backup");

		const assigned = await cabinet.assignFileToItem(
			meta,
			uploaded.id,
			"item-mobile",
			"手机新条目",
		);
		expect(assigned.item_id).toBe("item-mobile");
		expect(assigned.vaultPath).toContain("手机新条目");
		expect(await vault.exists(assigned.vaultPath)).toBe(true);
		expect(await vault.exists(uploaded.vaultPath)).toBe(false);
		expect((await cabinet.listFiles(meta))[0]?.vaultPath).toBe(assigned.vaultPath);
	});

	it("keeps unique names in the structured unlinked folder", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const cabinet = new CabinetService(vault, () => settings);
		const meta = await notebooks.createNotebook({
			name: "柜导入",
			templateId: "cabinet-first",
		});
		const bin = new TextEncoder().encode("pdf-bytes").buffer;

		const first = await cabinet.importBinary(meta, {
			displayName: "paper.pdf",
			data: bin,
		});
		const second = await cabinet.importBinary(meta, {
			displayName: "paper.pdf",
			data: bin,
		});
		expect(first.vaultPath).toContain("_unlinked/backup");
		expect(second.vaultPath).not.toBe(first.vaultPath);
		expect(await cabinet.listFiles(meta)).toHaveLength(2);
	});
});
