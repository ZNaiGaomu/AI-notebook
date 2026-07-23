import { describe, expect, it } from "vitest";
import { parseBlueprint } from "../src/domain/blueprintSchema";
import { buildTemplateBlueprint } from "../src/domain/templates";

describe("blueprint schema", () => {
	it("accepts all templates", () => {
		for (const id of [
			"blank",
			"literature",
			"idea",
			"meeting",
			"cabinet-first",
		] as const) {
			const bp = buildTemplateBlueprint(id, "测试本");
			const result = parseBlueprint(bp);
			expect(result.ok, id).toBe(true);
		}
	});

	it("rejects unknown field type", () => {
		const bp = buildTemplateBlueprint("blank", "x") as unknown as Record<
			string,
			unknown
		>;
		const entityTypes = bp.entityTypes as Array<{
			fields: Array<{ type: string }>;
		}>;
		entityTypes[0]!.fields[0]!.type = "magic";
		const result = parseBlueprint(bp);
		expect(result.ok).toBe(false);
	});
});
