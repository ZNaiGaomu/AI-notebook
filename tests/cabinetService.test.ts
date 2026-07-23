import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import { MemoryVault } from "../src/infra/memoryVault";
import { CabinetService } from "../src/services/cabinetService";
import { NotebookService } from "../src/services/notebookService";
import { VersionService } from "../src/services/versionService";
import { ItemService } from "../src/services/itemService";

describe("CabinetService P3", () => {
	it("adds links, parse title, files, attachIfUrl, remove", async () => {
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
		expect(link.url).toContain("example.com");

		const parsed = await cabinet.parseLinkTitle(meta, link.id);
		expect(parsed.title).toBe("deep-learning.pdf");

		const file = await cabinet.addFileRef(meta, {
			displayName: "notes.txt",
			vaultPath: "",
			textContent: "hello cabinet",
			mime: "text/plain",
		});
		expect(file.vaultPath).toContain(meta.notebook_id);
		expect(await vault.read(file.vaultPath)).toBe("hello cabinet");

		const item = await items.createItem(meta, {
			title: "clip",
			fields: { url: "https://obsidian.md" },
		});
		const attached = await cabinet.attachIfUrl(meta, {
			item_id: item.frontmatter.item_id,
			url: item.frontmatter.url,
			title: item.frontmatter.title,
		});
		expect(attached?.url).toBe("https://obsidian.md");

		expect(await cabinet.listLinks(meta)).toHaveLength(2);
		expect(await cabinet.listFiles(meta)).toHaveLength(1);

		await cabinet.removeLink(meta, link.id);
		await cabinet.removeFile(meta, file.id);
		expect(await cabinet.listLinks(meta)).toHaveLength(1);
		expect(await cabinet.listFiles(meta)).toHaveLength(0);
	});

	it("registerVaultFile and importBinary copy into attachments", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const cabinet = new CabinetService(vault, () => settings);

		const meta = await notebooks.createNotebook({
			name: "柜导入",
			templateId: "cabinet-first",
		});

		// pre-existing vault file
		await vault.write("notes/hello.md", "# hi");
		const reg = await cabinet.registerVaultFile(meta, {
			vaultPath: "notes/hello.md",
		});
		expect(reg.vaultPath).toBe("notes/hello.md");
		expect(reg.displayName).toBe("hello.md");

		const bin = new TextEncoder().encode("pdf-bytes").buffer;
		const imported = await cabinet.importBinary(meta, {
			displayName: "paper.pdf",
			data: bin,
			mime: "application/pdf",
		});
		expect(imported.vaultPath).toContain(meta.notebook_id);
		expect(imported.vaultPath.endsWith("paper.pdf")).toBe(true);
		expect(await vault.exists(imported.vaultPath)).toBe(true);
		expect(imported.size).toBe(bin.byteLength);

		// second import same name gets unique suffix
		const imported2 = await cabinet.importBinary(meta, {
			displayName: "paper.pdf",
			data: bin,
		});
		expect(imported2.vaultPath).not.toBe(imported.vaultPath);
		expect(await cabinet.listFiles(meta)).toHaveLength(3);
	});

});
