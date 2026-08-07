import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import { MemoryVault } from "../src/infra/memoryVault";
import {
	chatUploadsRoot,
	joinPath,
	structuredChatUploadsDir,
	structuredItemAttachmentsRoot,
} from "../src/infra/paths";
import { AttachmentService } from "../src/services/attachmentService";
import { ItemService } from "../src/services/itemService";
import { NotebookService } from "../src/services/notebookService";
import { VersionService } from "../src/services/versionService";
import {
	applyPathRewrites,
	syncAllItemFolderLayouts,
} from "../src/services/itemFolderSync";
import { itemDisplayName } from "../src/services/itemDisplayName";

describe("itemFolderSync", () => {
	it("renames chat-uploads and residual attachment folders with the item", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const attachments = new AttachmentService(vault, () => settings);
		const meta = await notebooks.createNotebook({
			name: "空白本66",
			templateId: "blank",
		});
		const item = await items.createItem(meta, { title: "测试" });
		const label = itemDisplayName(item);
		const managed = await attachments.importBinary(meta, {
			displayName: "voice.m4a",
			data: new TextEncoder().encode("v").buffer,
			mime: "audio/mp4",
			item_id: item.frontmatter.item_id,
			itemName: label,
			kind: "voice",
		});
		expect(managed.vaultPath).toContain(`/items/${label}/`);

		const chatDir = structuredChatUploadsDir(
			settings,
			meta.notebook_id,
			meta.name,
			item.frontmatter.item_id,
			label,
		);
		await vault.ensureFolder(chatDir);
		const chatFile = joinPath(chatDir, "截图.png");
		await vault.writeBinary(chatFile, new TextEncoder().encode("img").buffer);

		// Residual unindexed file under old attachment item folder label.
		const residualDir = joinPath(
			structuredItemAttachmentsRoot(settings, meta.name, label),
			"backup",
		);
		await vault.ensureFolder(residualDir);
		const residualFile = joinPath(residualDir, "loose.bin");
		await vault.writeBinary(residualFile, new TextEncoder().encode("x").buffer);

		// Simulate Obsidian rename of the markdown file stem.
		const oldPath = item.path;
		const newPath = oldPath.replace(/[^/]+\.md$/i, "测试66.md");
		await vault.move(oldPath, newPath);
		const renamed = {
			...item,
			path: newPath,
		};
		expect(itemDisplayName(renamed)).toBe("测试66");

		const { rewrites } = await syncAllItemFolderLayouts({
			vault,
			settings,
			meta,
			item: renamed,
			oldItemLabel: label,
			attachments,
		});
		expect(rewrites.length).toBeGreaterThan(0);
		expect(rewrites.some((r) => r.to.includes("/items/测试66/"))).toBe(true);
		expect(rewrites.every((r) => !r.to.includes("/items/测试66-2/"))).toBe(true);

		expect(await vault.exists(managed.vaultPath)).toBe(false);
		const afterManaged = await attachments.findById(meta, managed.id);
		expect(afterManaged?.vaultPath).toContain("/items/测试66/");
		expect(await vault.exists(afterManaged!.vaultPath)).toBe(true);

		const newChat = joinPath(
			structuredChatUploadsDir(
				settings,
				meta.notebook_id,
				meta.name,
				item.frontmatter.item_id,
				"测试66",
			),
			"截图.png",
		);
		expect(await vault.exists(newChat)).toBe(true);
		expect(await vault.exists(chatFile)).toBe(false);

		const history = `path=${chatFile}`;
		expect(applyPathRewrites(history, rewrites)).toContain("测试66");
		expect(await vault.exists(residualFile)).toBe(false);
	});
});
