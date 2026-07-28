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
		const files = this.vault.listFilesInFolder(dir);
		await this.ensureManualFilesImported(meta, files);
		const refreshedFiles = this.vault
			.listFilesInFolder(dir)
			.filter((f) => f.extension === "md");
		const items: NotebookItem[] = [];
		for (const file of refreshedFiles) {
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

	private async ensureManualFilesImported(
		meta: NotebookMeta,
		files: Array<{ path: string; extension: string }>,
	): Promise<void> {
		const settings = this.getSettings();
		const dir = itemsDir(settings, meta.folderName).replace(/\/+$/, "");
		const directFiles = files.filter((file) => isDirectChild(dir, file.path));
		const markdownFiles = directFiles.filter(
			(file) => normalizeExtension(file.extension) === "md",
		);
		const wrappedSourcePaths = await this.collectWrappedSourcePaths(markdownFiles);

		for (const file of markdownFiles) {
			try {
				await this.upgradeMarkdownFile(meta, file.path);
			} catch {
				// leave user file untouched if import fails
			}
		}

		for (const file of directFiles) {
			if (normalizeExtension(file.extension) === "md") continue;
			if (wrappedSourcePaths.has(file.path)) continue;
			try {
				await this.createWrapperForFile(
					meta,
					file.path,
					normalizeExtension(file.extension),
					markdownFiles,
				);
			} catch {
				// leave user file untouched if wrapper creation fails
			}
		}
	}

	private async collectWrappedSourcePaths(
		markdownFiles: Array<{ path: string }>,
	): Promise<Set<string>> {
		const wrapped = new Set<string>();
		for (const file of markdownFiles) {
			try {
				const { frontmatter } = parseFrontmatter(await this.vault.read(file.path));
				const source = frontmatter.source_file_path;
				if (typeof source === "string" && source.trim()) {
					wrapped.add(source.trim());
				}
			} catch {
				// ignore unreadable wrapper candidates
			}
		}
		return wrapped;
	}

	private async upgradeMarkdownFile(
		meta: NotebookMeta,
		path: string,
	): Promise<void> {
		const content = await this.vault.read(path);
		const { frontmatter, body } = parseFrontmatter(content);
		if (
			frontmatter.ai_notebook === true &&
			String(frontmatter.notebook_id) === meta.notebook_id
		) {
			return;
		}
		if (
			frontmatter.ai_notebook === true &&
			frontmatter.notebook_id != null &&
			String(frontmatter.notebook_id) !== meta.notebook_id
		) {
			return;
		}

		const { blueprint } = await this.versions.loadCurrentBlueprint(meta.folderName);
		const entityType = this.defaultEntityType(blueprint);
		const now = nowIso();
		const title = titleFromFrontmatterBodyOrPath(frontmatter.title, body, path);
		const nextFm: ItemFrontmatter = coerceFrontmatter(
			{
				...frontmatter,
				ai_notebook: true,
				notebook_id: meta.notebook_id,
				item_id:
					typeof frontmatter.item_id === "string" && frontmatter.item_id.trim()
						? frontmatter.item_id
						: createId(),
				schema_version:
					typeof frontmatter.schema_version === "number"
						? frontmatter.schema_version
						: blueprint.blueprintVersion,
				entity_type:
					typeof frontmatter.entity_type === "string" &&
					frontmatter.entity_type.trim()
						? frontmatter.entity_type
						: entityType,
				title,
				tags: asStringArray(frontmatter.tags),
				cabinet_refs: asStringArray(frontmatter.cabinet_refs),
				created:
					typeof frontmatter.created === "string" && frontmatter.created.trim()
						? frontmatter.created
						: now,
				updated: now,
			},
			meta.notebook_id,
		);
		await this.vault.write(path, serializeFrontmatter(nextFm, body));
	}

	private async createWrapperForFile(
		meta: NotebookMeta,
		sourcePath: string,
		extension: string,
		markdownFiles: Array<{ path: string }>,
	): Promise<void> {
		const base = baseNameWithoutExtension(sourcePath);
		const wrapperPath = await this.nextWrapperPath(sourcePath, markdownFiles);
		const body = [
			`![[${sourcePath}]]`,
			"",
			`文件：\`${sourcePath}\``,
			`类型：${extension || "file"}`,
			"",
			"此条目由 AI 记录本从 items 文件夹内的非 Markdown 文件自动生成。",
		].join("\n");
		const now = nowIso();
		const { blueprint } = await this.versions.loadCurrentBlueprint(meta.folderName);
		const fm: ItemFrontmatter = {
			ai_notebook: true,
			notebook_id: meta.notebook_id,
			item_id: createId(),
			schema_version: blueprint.blueprintVersion,
			entity_type: this.defaultEntityType(blueprint),
			title: base,
			tags: [],
			cabinet_refs: [],
			created: now,
			updated: now,
			source_file_path: sourcePath,
			source_file_type: extension || "file",
		};
		await this.vault.write(wrapperPath, serializeFrontmatter(fm, body));
	}

	private async nextWrapperPath(
		sourcePath: string,
		markdownFiles: Array<{ path: string }>,
	): Promise<string> {
		const dir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
		const base = sanitizeFileStem(baseNameWithoutExtension(sourcePath));
		const used = new Set(markdownFiles.map((file) => file.path));
		let candidate = `${dir}/${base}.md`;
		let n = 2;
		while (used.has(candidate) || (await this.vault.exists(candidate))) {
			candidate = `${dir}/${base}-${n}.md`;
			n++;
		}
		return candidate;
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

function isDirectChild(folder: string, path: string): boolean {
	const normalizedFolder = folder.replace(/\/+$/, "");
	const normalizedPath = path.replace(/\\/g, "/");
	if (!normalizedPath.startsWith(`${normalizedFolder}/`)) return false;
	const rest = normalizedPath.slice(normalizedFolder.length + 1);
	return Boolean(rest) && !rest.includes("/");
}

function titleFromFrontmatterBodyOrPath(
	rawTitle: unknown,
	body: string,
	path: string,
): string {
	if (typeof rawTitle === "string" && rawTitle.trim()) {
		return rawTitle.trim();
	}
	const heading = body.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return heading;
	return baseNameWithoutExtension(path) || "未命名";
}

function baseNameWithoutExtension(path: string): string {
	const file = path.slice(path.lastIndexOf("/") + 1);
	const dot = file.lastIndexOf(".");
	return (dot > 0 ? file.slice(0, dot) : file).trim();
}

function sanitizeFileStem(stem: string): string {
	const safe = stem.replace(/[\\/:*?"<>|]/g, "-").trim();
	return safe || "file-item";
}

function normalizeExtension(extension: string): string {
	return extension.trim().toLowerCase();
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
