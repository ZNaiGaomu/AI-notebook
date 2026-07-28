import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import { parseFrontmatter } from "../src/infra/frontmatter";
import { MemoryVault } from "../src/infra/memoryVault";
import { itemsDir } from "../src/infra/paths";
import { ItemService } from "../src/services/itemService";
import { NotebookService } from "../src/services/notebookService";
import { VersionService } from "../src/services/versionService";

describe("manual files in notebook items folder", () => {
	async function setup() {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "手工条目本",
			templateId: "blank",
		});
		return { vault, settings, items, meta };
	}

	it("upgrades a manually created markdown note into an AI notebook item", async () => {
		const { vault, settings, items, meta } = await setup();
		const path = `${itemsDir(settings, meta.folderName)}/111.md`;
		await vault.write(path, "# 手工标题\n\n手工正文");

		const listed = await items.listItems(meta);
		const manual = listed.find((item) => item.path === path);

		expect(manual).toBeTruthy();
		expect(manual?.frontmatter.ai_notebook).toBe(true);
		expect(manual?.frontmatter.notebook_id).toBe(meta.notebook_id);
		expect(manual?.frontmatter.title).toBe("手工标题");
		expect(manual?.frontmatter.entity_type).toBe("note");
		expect(manual?.body).toContain("手工正文");

		const raw = await vault.read(path);
		const parsed = parseFrontmatter(raw);
		expect(parsed.frontmatter.ai_notebook).toBe(true);
		expect(parsed.body).toContain("手工正文");
	});

	it("preserves existing frontmatter fields while upgrading markdown", async () => {
		const { vault, settings, items, meta } = await setup();
		const path = `${itemsDir(settings, meta.folderName)}/with-frontmatter.md`;
		await vault.write(
			path,
			["---", "title: 已有标题", "custom: keep-me", "---", "正文"].join("\n"),
		);

		const listed = await items.listItems(meta);
		const manual = listed.find((item) => item.path === path);

		expect(manual?.frontmatter.title).toBe("已有标题");
		expect(manual?.frontmatter.custom).toBe("keep-me");
		expect(manual?.body).toContain("正文");
	});

	it("creates one markdown wrapper item for a non-markdown file", async () => {
		const { vault, settings, items, meta } = await setup();
		const filePath = `${itemsDir(settings, meta.folderName)}/diagram.canvas`;
		await vault.write(filePath, "{\"nodes\":[]}");

		const first = await items.listItems(meta);
		const wrapper = first.find(
			(item) => item.frontmatter.source_file_path === filePath,
		);

		expect(wrapper).toBeTruthy();
		expect(wrapper?.path).toMatch(/diagram\.md$/);
		expect(wrapper?.frontmatter.title).toBe("diagram");
		expect(wrapper?.frontmatter.source_file_type).toBe("canvas");
		expect(wrapper?.body).toContain("![[AI Notebooks/手工条目本/items/diagram.canvas]]");

		const second = await items.listItems(meta);
		const wrappers = second.filter(
			(item) => item.frontmatter.source_file_path === filePath,
		);
		expect(wrappers).toHaveLength(1);
	});

	it("does not import files nested below the items folder", async () => {
		const { vault, settings, items, meta } = await setup();
		const nestedPath = `${itemsDir(settings, meta.folderName)}/nested/hidden.md`;
		await vault.write(nestedPath, "# 不应吸收\n\n子目录内容");

		const listed = await items.listItems(meta);

		expect(listed.some((item) => item.path === nestedPath)).toBe(false);
		expect(parseFrontmatter(await vault.read(nestedPath)).frontmatter.ai_notebook).toBe(
			undefined,
		);
	});
});
