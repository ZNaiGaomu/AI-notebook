import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import { notebookAttachmentsIndexPath } from "../src/infra/paths";
import { MemoryVault } from "../src/infra/memoryVault";
import {
	AttachmentService,
	buildAttachmentEmbedMarkdown,
} from "../src/services/attachmentService";
import { NotebookService } from "../src/services/notebookService";
import { VersionService } from "../src/services/versionService";
import { ItemService } from "../src/services/itemService";

describe("AttachmentService", () => {
	it("imports binary under item path, embeds independently, and record-only removes", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const attachments = new AttachmentService(vault, () => settings);

		const meta = await notebooks.createNotebook({
			name: "附件本",
			templateId: "blank",
		});
		const item = await items.createItem(meta, { title: "条目A", body: "hello" });
		const data = new TextEncoder().encode("pdf-bytes").buffer;
		const stored = await attachments.importBinary(meta, {
			displayName: "paper.pdf",
			data,
			mime: "application/pdf",
			item_id: item.frontmatter.item_id,
			itemName: item.frontmatter.title,
			kind: "backup",
			origin: "test",
		});
		expect(stored.ownership).toBe("managed");
		expect(stored.vaultPath).toContain("条目A");
		expect(await vault.exists(stored.vaultPath)).toBe(true);

		const embed = buildAttachmentEmbedMarkdown(stored);
		expect(embed).toContain(`ai-notebook-attachment:${stored.id}`);
		expect(embed).toContain(`![[${stored.vaultPath}]]`);

		const updated = await items.appendToItem(item, {
			body: embed,
			heading: "附件",
		});
		const removed = await attachments.remove(meta, stored.id);
		expect(removed).toMatchObject({
			recordRemoved: true,
			physicalDeleted: false,
			reason: "record-only",
		});
		expect(await vault.exists(stored.vaultPath)).toBe(true);
		const after = await items.findById(meta, item.frontmatter.item_id);
		expect(after?.body).toContain(stored.vaultPath);
		expect(updated.body).toContain(stored.vaultPath);

		const indexPath = notebookAttachmentsIndexPath(settings, meta.folderName);
		const store = await vault.readJson<{ items: unknown[] }>(indexPath);
		expect(store.items).toHaveLength(0);
	});

	it("does not physically delete external paths even when requested", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const attachments = new AttachmentService(vault, () => settings);
		const meta = await notebooks.createNotebook({
			name: "外",
			templateId: "blank",
		});
		await vault.write("notes/keep.md", "keep");
		const registered = await attachments.registerExternal(meta, {
			vaultPath: "notes/keep.md",
		});
		const result = await attachments.remove(meta, registered.id, {
			deleteManagedFile: true,
		});
		expect(result.reason).toBe("external");
		expect(await vault.exists("notes/keep.md")).toBe(true);
	});

	it("assignToItem moves managed files into item folders", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const attachments = new AttachmentService(vault, () => settings);
		const meta = await notebooks.createNotebook({
			name: "移",
			templateId: "blank",
		});
		const data = new TextEncoder().encode("x").buffer;
		const unlinked = await attachments.importBinary(meta, {
			displayName: "a.bin",
			data,
			origin: "test",
		});
		expect(unlinked.vaultPath).toContain("_unlinked");
		const item = await items.createItem(meta, { title: "目标" });
		const assigned = await attachments.assignToItem(
			meta,
			unlinked.id,
			item.frontmatter.item_id,
			item.frontmatter.title,
		);
		expect(assigned.item_id).toBe(item.frontmatter.item_id);
		expect(assigned.vaultPath).toContain("目标");
		expect(await vault.exists(assigned.vaultPath)).toBe(true);
	});

	it("uses title-based folders and renames on title sync", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const attachments = new AttachmentService(vault, () => settings);
		const meta = await notebooks.createNotebook({
			name: "会议ppt+voice记录",
			templateId: "blank",
		});
		const item = await items.createItem(meta, { title: "基础电化学-詹东平" });
		const data = new TextEncoder().encode("img").buffer;
		const stored = await attachments.importBinary(meta, {
			displayName: "a.jpg",
			data,
			mime: "image/jpeg",
			item_id: item.frontmatter.item_id,
			itemName: item.frontmatter.title,
		});
		expect(stored.vaultPath).toContain("会议ppt+voice记录");
		expect(stored.vaultPath).toContain("基础电化学-詹东平");
		expect(stored.vaultPath).not.toContain("item-");

		const rewrites = await attachments.syncItemTitle(
			meta,
			item.frontmatter.item_id,
			"基础电化学-詹东平-改名",
		);
		expect(rewrites.length).toBeGreaterThan(0);
		expect(rewrites[0]!.to).toContain("基础电化学-詹东平-改名");
		const body = `pre
![[${stored.vaultPath}]]
post`;
		const next = attachments.rewriteEmbedPaths(body, rewrites);
		expect(next).toContain(rewrites[0]!.to);
		expect(next).not.toContain(stored.vaultPath);
	});

});
