import type { Blueprint, NotebookItem } from "../domain/types";

export type ListFilterState = Record<string, string>;

/**
 * Sort items according to entity.list.sort on the blueprint.
 * Defaults to updated_desc when unset.
 */
export function sortItemsByBlueprint(
	items: NotebookItem[],
	blueprint: Blueprint,
	entityTypeId?: string,
): NotebookItem[] {
	const entity =
		blueprint.entityTypes.find((e) => e.id === entityTypeId) ??
		blueprint.entityTypes[0];
	const sort = entity?.list?.sort ?? "updated_desc";
	const copy = [...items];
	copy.sort((a, b) => {
		switch (sort) {
			case "title_asc":
				return a.frontmatter.title.localeCompare(b.frontmatter.title, "zh");
			case "created_desc":
				return (b.frontmatter.created || "").localeCompare(
					a.frontmatter.created || "",
				);
			case "updated_asc":
				return (a.frontmatter.updated || "").localeCompare(
					b.frontmatter.updated || "",
				);
			case "updated_desc":
			default:
				return (b.frontmatter.updated || "").localeCompare(
					a.frontmatter.updated || "",
				);
		}
	});
	return copy;
}

/**
 * Apply simple equality filters for fields listed in entity.list.filterFields.
 * Empty filter values are ignored. tags/multi-select match if value is in array.
 */
export function filterItems(
	items: NotebookItem[],
	blueprint: Blueprint,
	entityTypeId: string | undefined,
	filters: ListFilterState,
): NotebookItem[] {
	const entity =
		blueprint.entityTypes.find((e) => e.id === entityTypeId) ??
		blueprint.entityTypes[0];
	const allowed = new Set(entity?.list?.filterFields ?? []);
	const active = Object.entries(filters).filter(
		([k, v]) => allowed.has(k) && v != null && String(v).trim() !== "",
	);
	if (active.length === 0) return items;

	return items.filter((item) => {
		for (const [key, raw] of active) {
			const want = String(raw).trim();
			const val = item.frontmatter[key];
			if (Array.isArray(val)) {
				if (!val.map(String).includes(want)) return false;
			} else if (String(val ?? "") !== want) {
				return false;
			}
		}
		return true;
	});
}

/** Primary entity for the notebook's main view. */
export function primaryEntityId(blueprint: Blueprint): string | null {
	const viewEntity = blueprint.views.find(
		(v) => v.type === "list" || v.type === "table" || v.type === "board",
	)?.entityType;
	if (viewEntity) return viewEntity;
	return blueprint.entityTypes[0]?.id ?? null;
}

/**
 * Default item-view mode: first list|table|board entry in blueprint.views.
 * UI may still switch among {@link availableItemViewModes}.
 */
export function resolveItemViewMode(
	blueprint: Blueprint,
): "list" | "table" | "board" {
	const first = blueprint.views.find(
		(v) => v.type === "list" || v.type === "table" || v.type === "board",
	);
	if (first?.type === "table") return "table";
	if (first?.type === "board") return "board";
	return "list";
}

/** Modes declared on the blueprint (always includes list as fallback). */
export function availableItemViewModes(
	blueprint: Blueprint,
): Array<"list" | "table" | "board"> {
	const modes: Array<"list" | "table" | "board"> = ["list"];
	const seen = new Set<"list" | "table" | "board">(["list"]);
	for (const v of blueprint.views) {
		if (
			(v.type === "list" || v.type === "table" || v.type === "board") &&
			!seen.has(v.type)
		) {
			seen.add(v.type);
			modes.push(v.type);
		}
	}
	// stable order: list, table, board
	const order: Array<"list" | "table" | "board"> = ["list", "table", "board"];
	return order.filter((m) => seen.has(m));
}

/**
 * Field used as board columns: first select field in filterFields or entity fields.
 */
export function resolveBoardColumnField(
	blueprint: Blueprint,
	entityTypeId?: string,
): { id: string; options: string[] } | null {
	const entity =
		blueprint.entityTypes.find((e) => e.id === entityTypeId) ??
		blueprint.entityTypes[0];
	if (!entity) return null;

	const candidates = [
		...(entity.list?.filterFields ?? []),
		...entity.fields.map((f) => f.id),
	];
	for (const id of candidates) {
		const field = entity.fields.find((f) => f.id === id);
		if (field?.type === "select" && field.options && field.options.length > 0) {
			return { id: field.id, options: [...field.options] };
		}
	}
	return null;
}

export function groupItemsByField(
	items: NotebookItem[],
	fieldId: string,
	options: string[],
): { key: string; label: string; items: NotebookItem[] }[] {
	const buckets = new Map<string, NotebookItem[]>();
	for (const opt of options) buckets.set(opt, []);
	const other: NotebookItem[] = [];

	for (const item of items) {
		const val = String(item.frontmatter[fieldId] ?? "");
		if (buckets.has(val)) {
			buckets.get(val)!.push(item);
		} else {
			other.push(item);
		}
	}

	const cols = options.map((opt) => ({
		key: opt,
		label: opt,
		items: buckets.get(opt) ?? [],
	}));
	if (other.length > 0) {
		cols.push({ key: "__other__", label: "其他", items: other });
	}
	return cols;
}
