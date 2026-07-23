import { describe, expect, it, vi } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import { buildTemplateBlueprint } from "../src/domain/templates";
import type { Blueprint, ProviderProfile } from "../src/domain/types";
import { MemoryVault } from "../src/infra/memoryVault";
import { CabinetService } from "../src/services/cabinetService";
import { HookRunner } from "../src/services/hookRunner";
import { ItemService } from "../src/services/itemService";
import { NotebookService } from "../src/services/notebookService";
import type { OrganizeService } from "../src/services/organizeService";
import { VersionService } from "../src/services/versionService";

function makeExtractor(
	impl: OrganizeService["organizeText"],
): Pick<OrganizeService, "organizeText"> {
	return { organizeText: impl };
}

describe("HookRunner onCreate", () => {
	it("runs notify, attachIfUrl, and ai.extract in order", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const cabinet = new CabinetService(vault, () => settings);

		const meta = await notebooks.createNotebook({
			name: "钩子本",
			templateId: "cabinet-first",
		});

		const notices: string[] = [];
		const extract = vi.fn(async () => ({
			ok: true as const,
			title: "抽取标题",
			fields: { url: "https://extracted.example/x" },
			body: "抽取正文",
			summary: "摘要",
			tags: [],
		}));

		const runner = new HookRunner({
			cabinet,
			items,
			organize: makeExtractor(extract) as OrganizeService,
			notify: (m) => notices.push(m),
		});

		const item = await items.createItem(meta, {
			title: "原始",
			fields: { url: "https://example.com/page" },
			body: "原始正文",
		});

		const blueprint: Blueprint = {
			...buildTemplateBlueprint("cabinet-first", meta.name),
			hooks: {
				onCreate: [
					{ type: "notify", message: "已创建" },
					{ type: "cabinet.attachIfUrl" },
					{ type: "ai.extract" },
				],
			},
		};

		const result = await runner.runOnCreate({ meta, item, blueprint });

		expect(notices).toContain("已创建");
		expect(result.steps.map((s) => s.type)).toEqual([
			"notify",
			"cabinet.attachIfUrl",
			"ai.extract",
		]);
		expect(result.steps.every((s) => s.ok)).toBe(true);

		const links = await cabinet.listLinks(meta);
		expect(links.some((l) => l.url === "https://example.com/page")).toBe(true);

		expect(extract).toHaveBeenCalledOnce();
		expect(result.item.frontmatter.title).toBe("抽取标题");
		expect(result.item.frontmatter.url).toBe("https://extracted.example/x");
		expect(result.item.body).toContain("抽取正文");
	});

	it("does not fail create when ai.extract has no provider", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const cabinet = new CabinetService(vault, () => settings);

		const meta = await notebooks.createNotebook({
			name: "无AI",
			templateId: "blank",
		});
		const item = await items.createItem(meta, { title: "t", body: "b" });

		const runner = new HookRunner({
			cabinet,
			items,
			organize: makeExtractor(async () => ({
				ok: false,
				error: "未配置 AI Provider（worker）",
			})) as OrganizeService,
			notify: () => undefined,
		});

		const bp = buildTemplateBlueprint("blank", meta.name);
		const withExtract: Blueprint = {
			...bp,
			hooks: { onCreate: [{ type: "ai.extract" }] },
		};

		const result = await runner.runOnCreate({
			meta,
			item,
			blueprint: withExtract,
		});
		expect(result.steps[0]?.ok).toBe(false);
		expect(result.item.frontmatter.title).toBe("t");
	});

	it("skips attachIfUrl when no url field", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const cabinet = new CabinetService(vault, () => settings);
		const meta = await notebooks.createNotebook({
			name: "灵感",
			templateId: "idea",
		});
		const item = await items.createItem(meta, { title: "想法" });
		const runner = new HookRunner({
			cabinet,
			items,
			organize: makeExtractor(async () => ({
				ok: false,
				error: "skip",
			})) as OrganizeService,
			notify: () => undefined,
		});
		const bp: Blueprint = {
			...buildTemplateBlueprint("idea", meta.name),
			hooks: { onCreate: [{ type: "cabinet.attachIfUrl" }] },
		};
		const result = await runner.runOnCreate({ meta, item, blueprint: bp });
		expect(result.steps[0]?.ok).toBe(true);
		expect(result.steps[0]?.detail).toMatch(/跳过|无/);
		expect(await cabinet.listLinks(meta)).toHaveLength(0);
	});
});

describe("list projection helpers", () => {
	it("sorts and filters by blueprint list config", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "文献",
			templateId: "literature",
		});
		const a = await items.createItem(meta, {
			title: "A",
			fields: { status: "done" },
		});
		await new Promise((r) => setTimeout(r, 5));
		const b = await items.createItem(meta, {
			title: "B",
			fields: { status: "to-read" },
		});
		// bump A updated later
		await items.updateItem(a, { fields: { status: "done" } });

		const all = await items.listItems(meta);
		const { filterItems, sortItemsByBlueprint } = await import(
			"../src/runtime/listQuery"
		);
		const bp = buildTemplateBlueprint("literature", meta.name);
		const sorted = sortItemsByBlueprint(all, bp, "literature");
		expect(sorted[0]?.frontmatter.title).toBe("A");

		const filtered = filterItems(sorted, bp, "literature", {
			status: "to-read",
		});
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.frontmatter.title).toBe("B");
		expect(b.frontmatter.title).toBe("B");
	});
});

// silence unused import in types-only usage
void (null as unknown as ProviderProfile);
