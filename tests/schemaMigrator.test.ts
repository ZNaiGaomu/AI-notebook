import { describe, expect, it } from "vitest";
import { buildTemplateBlueprint } from "../src/domain/templates";
import type { ItemFrontmatter } from "../src/domain/types";
import { projectItem } from "../src/services/schemaMigrator";

describe("schemaMigrator", () => {
	it("keeps unmapped fields without deleting", () => {
		const bp = buildTemplateBlueprint("blank", "本");
		const fm: ItemFrontmatter = {
			ai_notebook: true,
			notebook_id: "n1",
			item_id: "i1",
			schema_version: 2,
			entity_type: "note",
			title: "t",
			tags: [],
			cabinet_refs: [],
			created: "",
			updated: "",
			legacy_status: "old",
			extra_url: "https://x",
		};
		const projected = projectItem(fm, bp);
		expect(projected.unmapped.legacy_status).toBe("old");
		expect(projected.unmapped.extra_url).toBe("https://x");
		expect(projected.known.title).toBe("t");
	});
});
