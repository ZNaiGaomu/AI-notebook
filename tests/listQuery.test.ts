import { describe, expect, it } from "vitest";
import { buildTemplateBlueprint } from "../src/domain/templates";
import type { NotebookItem } from "../src/domain/types";
import {
	filterItems,
	groupItemsByField,
	resolveBoardColumnField,
	resolveItemViewMode,
	sortItemsByBlueprint,
} from "../src/runtime/listQuery";

function item(
	title: string,
	extra: Record<string, unknown> = {},
	updated = "2026-07-19T12:00:00",
): NotebookItem {
	return {
		path: `items/${title}.md`,
		body: "",
		frontmatter: {
			ai_notebook: true,
			notebook_id: "n1",
			item_id: title,
			schema_version: 1,
			entity_type: "literature",
			title,
			tags: [],
			cabinet_refs: [],
			created: updated,
			updated,
			...extra,
		},
	};
}

describe("listQuery", () => {
	it("resolveItemViewMode follows first list|table|board view", () => {
		const base = buildTemplateBlueprint("literature", "文");
		// literature template declares list first
		expect(resolveItemViewMode(base)).toBe("list");
		expect(
			resolveItemViewMode({
				...base,
				views: [
					{ id: "t", type: "table", entityType: "literature" },
					{ id: "main", type: "list", entityType: "literature" },
				],
			}),
		).toBe("table");
		expect(
			resolveItemViewMode({
				...base,
				views: [{ id: "b", type: "board", entityType: "literature" }],
			}),
		).toBe("board");
	});

	it("resolveBoardColumnField picks status select", () => {
		const bp = buildTemplateBlueprint("literature", "文");
		const col = resolveBoardColumnField(bp, "literature");
		expect(col?.id).toBe("status");
		expect(col?.options).toContain("to-read");
	});

	it("groupItemsByField buckets correctly", () => {
		const items = [
			item("a", { status: "to-read" }),
			item("b", { status: "done" }),
			item("c", { status: "mystery" }),
		];
		const groups = groupItemsByField(items, "status", [
			"to-read",
			"reading",
			"done",
		]);
		expect(groups.find((g) => g.key === "to-read")?.items).toHaveLength(1);
		expect(groups.find((g) => g.key === "done")?.items).toHaveLength(1);
		expect(groups.find((g) => g.key === "__other__")?.items[0]?.frontmatter.title).toBe(
			"c",
		);
	});

	it("sort title_asc and filter status", () => {
		const bp = {
			...buildTemplateBlueprint("literature", "文"),
			entityTypes: buildTemplateBlueprint("literature", "文").entityTypes.map(
				(e) =>
					e.id === "literature"
						? {
								...e,
								list: {
									sort: "title_asc" as const,
									filterFields: ["status"],
								},
							}
						: e,
			),
		};
		const items = [
			item("Z", { status: "done" }, "2026-07-19T10:00:00"),
			item("A", { status: "to-read" }, "2026-07-19T11:00:00"),
		];
		const sorted = sortItemsByBlueprint(items, bp, "literature");
		expect(sorted.map((i) => i.frontmatter.title)).toEqual(["A", "Z"]);
		const filtered = filterItems(sorted, bp, "literature", { status: "done" });
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.frontmatter.title).toBe("Z");
	});
});
