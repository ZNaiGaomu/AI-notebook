import type { Blueprint, BlueprintField, ItemFrontmatter } from "../domain/types";
import { RESERVED_ITEM_KEYS } from "../domain/types";

export type ProjectedItem = {
	known: Record<string, unknown>;
	unmapped: Record<string, unknown>;
	entity: Blueprint["entityTypes"][number] | null;
	fields: BlueprintField[];
};

/**
 * Read-time projection: never deletes data from frontmatter.
 * Known blueprint fields + reserved keys go to known; rest to unmapped.
 */
export function projectItem(
	frontmatter: ItemFrontmatter,
	blueprint: Blueprint,
): ProjectedItem {
	const entity =
		blueprint.entityTypes.find((e) => e.id === frontmatter.entity_type) ??
		blueprint.entityTypes[0] ??
		null;
	const fields = entity?.fields ?? [];
	const fieldIds = new Set(fields.map((f) => f.id));

	const known: Record<string, unknown> = {};
	const unmapped: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(frontmatter)) {
		if (RESERVED_ITEM_KEYS.has(key) || fieldIds.has(key)) {
			known[key] = value;
		} else {
			unmapped[key] = value;
		}
	}

	return { known, unmapped, entity, fields };
}

export function listFieldIds(blueprint: Blueprint, entityTypeId: string): Set<string> {
	const entity =
		blueprint.entityTypes.find((e) => e.id === entityTypeId) ??
		blueprint.entityTypes[0];
	return new Set((entity?.fields ?? []).map((f) => f.id));
}
