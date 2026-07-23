import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import { buildTemplateBlueprint } from "../src/domain/templates";
import { MemoryVault } from "../src/infra/memoryVault";
import { ItemService } from "../src/services/itemService";
import { NotebookService } from "../src/services/notebookService";
import { projectItem } from "../src/services/schemaMigrator";
import { VersionService } from "../src/services/versionService";
import { parseFrontmatter } from "../src/infra/frontmatter";

describe("P0/P1 end-to-end smoke (memory vault)", () => {
	it("create notebook → items → version restore keeps item body", async () => {
		const vault = new MemoryVault();
		let settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);

		// 1) create literature notebook
		const meta = await notebooks.createNotebook({
			name: "文献测试本",
			templateId: "literature",
		});
		expect(meta.notebook_id).toBeTruthy();
		expect(meta.current_blueprint).toBe(1);

		const listed = await notebooks.listNotebooks();
		expect(listed.some((n) => n.notebook_id === meta.notebook_id)).toBe(true);

		// 2) create items
		const item1 = await items.createItem(meta, {
			title: "论文 A",
			fields: { url: "https://example.com/a", status: "to-read" },
			body: "原始正文不应因功能回滚消失",
		});
		const item2 = await items.createItem(meta, { title: "论文 B" });
		expect(item1.frontmatter.entity_type).toBe("literature");
		expect(item1.path).toMatch(/items\/\d{4}-\d{2}-\d{2}.+\.md$/);

		let all = await items.listItems(meta);
		expect(all).toHaveLength(2);

		// 3) commit blueprint v2 with extra field
		const { blueprint: v1 } = await versions.loadCurrentBlueprint(
			meta.folderName,
		);
		const v2 = {
			...v1,
			entityTypes: v1.entityTypes.map((e) =>
				e.id === "literature"
					? {
							...e,
							fields: [
								...e.fields,
								{
									id: "priority",
									label: "优先级",
									type: "select" as const,
									options: ["low", "high"],
									showInList: true,
								},
							],
						}
					: e,
			),
		};
		const commit = await versions.commit(meta.folderName, meta.notebook_id, v2, {
			author: "user",
			changeSummary: "加 priority 字段",
		});
		expect(commit.version).toBe(2);
		const meta2 = await notebooks.touchCurrentBlueprint(meta, commit.version);
		expect(meta2.current_blueprint).toBe(2);

		// update item with new field
		const updated = await items.updateItem(item1, {
			fields: { priority: "high" },
			schemaVersion: 2,
		});
		expect(updated.frontmatter.priority).toBe("high");

		// 4) restore to v1 via new commit (v3 content = v1)
		const restored = await versions.restore(
			meta2.folderName,
			meta2.notebook_id,
			1,
		);
		expect(restored.version).toBe(3);
		const meta3 = await notebooks.touchCurrentBlueprint(meta2, restored.version);
		const { blueprint: currentBp } = await versions.loadCurrentBlueprint(
			meta3.folderName,
		);
		expect(
			currentBp.entityTypes[0]?.fields.some((f) => f.id === "priority"),
		).toBe(false);

		// 5) item body + unmapped priority still on disk
		all = await items.listItems(meta3);
		const reloaded = all.find(
			(i) => i.frontmatter.item_id === item1.frontmatter.item_id,
		);
		expect(reloaded).toBeTruthy();
		expect(reloaded!.body).toContain("原始正文不应因功能回滚消失");
		expect(reloaded!.frontmatter.priority).toBe("high");

		const projected = projectItem(reloaded!.frontmatter, currentBp);
		expect(projected.unmapped.priority).toBe("high");
		expect(projected.known.title).toBe("论文 A");

		// 6) soft delete
		await items.softDelete(meta3, item2);
		all = await items.listItems(meta3);
		expect(all).toHaveLength(1);
		expect(
			vault.dumpPaths().some((p) => p.includes(".trash/items")),
		).toBe(true);

		// 7) frontmatter on disk parseable
		const raw = await vault.read(reloaded!.path);
		const parsed = parseFrontmatter(raw);
		expect(parsed.frontmatter.ai_notebook).toBe(true);

		// 8) second notebook isolation
		const metaB = await notebooks.createNotebook({
			name: "灵感本",
			templateId: "idea",
		});
		await items.createItem(metaB, { title: "想法1" });
		expect(await items.listItems(meta3)).toHaveLength(1);
		expect(await items.listItems(metaB)).toHaveLength(1);

		// 9) all templates validate via create
		for (const tid of ["blank", "meeting", "cabinet-first"] as const) {
			const m = await notebooks.createNotebook({
				name: `T-${tid}`,
				templateId: tid,
			});
			expect(m.current_blueprint).toBe(1);
			const bp = buildTemplateBlueprint(tid, m.name);
			expect(bp.entityTypes.length).toBeGreaterThan(0);
		}

		// 10) version index length
		const index = await versions.loadIndex(meta3.folderName);
		expect(index.versions.length).toBe(3);
		expect(index.current).toBe(3);
	});

	it("diff detects field add", () => {
		const vault = new MemoryVault();
		const versions = new VersionService(vault, () => createDefaultSettings());
		const a = buildTemplateBlueprint("blank", "a");
		const b = {
			...a,
			entityTypes: a.entityTypes.map((e) => ({
				...e,
				fields: [
					...e.fields,
					{ id: "x", label: "X", type: "text" as const },
				],
			})),
		};
		const lines = versions.diffBlueprints(a, b);
		expect(lines.some((l) => l.kind === "add" && l.text.includes("x"))).toBe(
			true,
		);
	});

	it("commit stores changeDetails and timestamps", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "版本明细本",
			templateId: "blank",
		});
		const index1 = await versions.loadIndex(meta.folderName);
		const v1 = index1.versions[0]!;
		expect(v1.changeDetails?.length).toBeGreaterThan(0);
		expect(v1.changeDetails?.some((d) => d.includes("字段") || d.includes("实体"))).toBe(
			true,
		);
		expect(v1.createdAt).toMatch(/^\d{4}-/);

		const { blueprint } = await versions.loadCurrentBlueprint(meta.folderName);
		const next = {
			...blueprint,
			entityTypes: blueprint.entityTypes.map((e) => ({
				...e,
				fields: [
					...e.fields,
					{
						id: "priority",
						label: "优先级",
						type: "select" as const,
						options: ["low", "high"],
					},
				],
			})),
			views: [
				...blueprint.views,
				{ id: "board", type: "board" as const, entityType: eId(blueprint) },
			],
		};
		function eId(bp: typeof blueprint) {
			return bp.entityTypes[0]!.id;
		}
		const { version } = await versions.commit(
			meta.folderName,
			meta.notebook_id,
			next,
			{ author: "user", changeSummary: "加优先级与看板" },
		);
		expect(version).toBe(2);
		const index2 = await versions.loadIndex(meta.folderName);
		const v2 = index2.versions.find((x) => x.version === 2)!;
		expect(v2.changeDetails?.some((d) => d.includes("priority") || d.includes("优先级"))).toBe(
			true,
		);
		expect(v2.changeDetails?.some((d) => d.includes("看板") || d.includes("board"))).toBe(
			true,
		);
		// resolveChangeDetails for legacy-style (clear details)
		const legacy = { ...v2, changeDetails: undefined };
		const resolved = await versions.resolveChangeDetails(meta.folderName, legacy);
		expect(resolved.length).toBeGreaterThan(0);
	});

});
