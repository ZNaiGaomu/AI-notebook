import type {
	AiNotebookSettings,
	Blueprint,
	ItemFrontmatter,
	NotebookItem,
	NotebookMeta,
} from "../domain/types";
import { createId, dateTimeFilePrefix, nowIso, parseCaptureTime, shortId, toIso } from "../domain/ids";
import {
	asStringArray,
	parseFrontmatter,
	serializeFrontmatter,
} from "../infra/frontmatter";
import { itemsDir, trashItemsDir } from "../infra/paths";
import type { IVaultFs } from "../infra/vaultPort";
import type { VersionService } from "./versionService";

export class ItemService {
	constructor(
		private readonly vault: IVaultFs,
		private readonly versions: VersionService,
		private readonly getSettings: () => AiNotebookSettings,
	) {}

	async listItems(meta: NotebookMeta): Promise<NotebookItem[]> {
		const settings = this.getSettings();
		const dir = itemsDir(settings, meta.folderName);
		const files = this.vault
			.listFilesInFolder(dir)
			.filter((f) => f.extension === "md");
		const items: NotebookItem[] = [];
		for (const file of files) {
			try {
				const content = await this.vault.read(file.path);
				const { frontmatter, body } = parseFrontmatter(content);
				if (frontmatter.ai_notebook !== true) continue;
				if (String(frontmatter.notebook_id) !== meta.notebook_id) continue;
				items.push({
					path: file.path,
					frontmatter: coerceFrontmatter(frontmatter, meta.notebook_id),
					body,
				});
			} catch {
				// skip unreadable
			}
		}
		return sortItems(items, "updated_desc");
	}

	async createItem(
		meta: NotebookMeta,
		input: {
			title: string;
			entityType?: string;
			fields?: Record<string, unknown>;
			body?: string;
			/** When note was made (mobile queue time). ISO or epoch ms. */
			capturedAt?: string | number | null;
		},
	): Promise<NotebookItem> {
		const { blueprint } = await this.versions.loadCurrentBlueprint(meta.folderName);
		const entity =
			blueprint.entityTypes.find((e) => e.id === input.entityType) ??
			blueprint.entityTypes[0];
		if (!entity) throw new Error("蓝图中无实体类型");

		const itemId = createId();
		const at = parseCaptureTime(input.capturedAt) ?? new Date();
		const created = toIso(at);
		const title = input.title.trim() || "未命名";
		const fm: ItemFrontmatter = {
			ai_notebook: true,
			notebook_id: meta.notebook_id,
			item_id: itemId,
			schema_version: blueprint.blueprintVersion,
			entity_type: entity.id,
			title,
			tags: [],
			cabinet_refs: [],
			created,
			updated: created,
		};

		for (const field of entity.fields) {
			if (field.id === "title") continue;
			if (input.fields && field.id in input.fields) {
				fm[field.id] = input.fields[field.id];
			} else if (field.type === "tags" || field.type === "multi-select") {
				fm[field.id] = [];
			} else if (field.type === "checkbox") {
				fm[field.id] = false;
			} else if (field.type === "number") {
				fm[field.id] = 0;
			} else {
				fm[field.id] = "";
			}
		}

		// body field often lives in markdown body rather than fm
		let body = input.body ?? "";
		if (input.fields?.body != null && typeof input.fields.body === "string") {
			body = input.fields.body;
		}

		const settings = this.getSettings();
		const fileName = `${dateTimeFilePrefix(at)}-${shortId(itemId)}.md`;
		const path = `${itemsDir(settings, meta.folderName)}/${fileName}`;
		const content = serializeFrontmatter(fm, body);
		await this.vault.write(path, content);

		return { path, frontmatter: fm, body };
	}

	async updateItem(
		item: NotebookItem,
		patch: {
			title?: string;
			fields?: Record<string, unknown>;
			body?: string;
			schemaVersion?: number;
		},
	): Promise<NotebookItem> {
		const nextFm: ItemFrontmatter = {
			...item.frontmatter,
			updated: nowIso(),
		};
		if (patch.title != null) nextFm.title = patch.title;
		if (patch.schemaVersion != null) nextFm.schema_version = patch.schemaVersion;
		if (patch.fields) {
			for (const [k, v] of Object.entries(patch.fields)) {
				if (k === "title") {
					nextFm.title = String(v);
					continue;
				}
				nextFm[k] = v;
			}
		}
		const body = patch.body != null ? patch.body : item.body;
		const content = serializeFrontmatter(nextFm, body);
		await this.vault.write(item.path, content);
		return { path: item.path, frontmatter: nextFm, body };
	}

	async softDelete(meta: NotebookMeta, item: NotebookItem): Promise<void> {
		const settings = this.getSettings();
		const trashDir = trashItemsDir(settings, meta.folderName);
		const base = item.path.includes("/")
			? item.path.slice(item.path.lastIndexOf("/") + 1)
			: item.path;
		const target = `${trashDir}/${Date.now()}-${base}`;
		await this.vault.move(item.path, target);
	}

	defaultEntityType(blueprint: Blueprint): string {
		return blueprint.entityTypes[0]?.id ?? "note";
	}
}

function coerceFrontmatter(
	raw: Record<string, unknown>,
	notebookId: string,
): ItemFrontmatter {
	return {
		...raw,
		ai_notebook: true,
		notebook_id: String(raw.notebook_id ?? notebookId),
		item_id: String(raw.item_id ?? ""),
		schema_version: Number(raw.schema_version ?? 1),
		entity_type: String(raw.entity_type ?? "note"),
		title: String(raw.title ?? "未命名"),
		tags: asStringArray(raw.tags),
		cabinet_refs: asStringArray(raw.cabinet_refs),
		created: String(raw.created ?? ""),
		updated: String(raw.updated ?? ""),
	};
}

function sortItems(
	items: NotebookItem[],
	sort: "updated_desc" | "updated_asc" | "created_desc" | "title_asc",
): NotebookItem[] {
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
