import { serializeFrontmatter } from "../infra/frontmatter";
import { parseFrontmatter } from "../infra/frontmatter";
import type {
	AiNotebookSettings,
	NotebookMeta,
	TemplateId,
} from "../domain/types";
import { createId, nowIso } from "../domain/ids";
import { buildTemplateBlueprint } from "../domain/templates";
import {
	blueprintIndexPath,
	blueprintsDir,
	cabinetDir,
	itemsDir,
	notebookFolderPath,
	notebookMetaPath,
	notebooksRoot,
	sanitizeFolderName,
	trashItemsDir,
} from "../infra/paths";
import type { IVaultFs } from "../infra/vaultPort";
import type { VersionService } from "./versionService";

export class NotebookService {
	constructor(
		private readonly vault: IVaultFs,
		private readonly versions: VersionService,
		private readonly getSettings: () => AiNotebookSettings,
	) {}

	async listNotebooks(): Promise<NotebookMeta[]> {
		const settings = this.getSettings();
		const root = notebooksRoot(settings);
		if (!(await this.vault.exists(root))) return [];
		const folders = this.vault.listImmediateFolders(root);
		const result: NotebookMeta[] = [];
		for (const folder of folders) {
			const metaPath = notebookMetaPath(settings, folder.name);
			if (!(await this.vault.exists(metaPath))) continue;
			try {
				const meta = await this.readMeta(folder.name);
				result.push(meta);
			} catch {
				// skip invalid
			}
		}
		result.sort((a, b) => b.updated.localeCompare(a.updated));
		return result;
	}

	async readMeta(folderName: string): Promise<NotebookMeta> {
		const settings = this.getSettings();
		const path = notebookMetaPath(settings, folderName);
		const content = await this.vault.read(path);
		const { frontmatter } = parseFrontmatter(content);
		if (frontmatter.type !== "ai-notebook") {
			throw new Error(`Not an ai-notebook: ${path}`);
		}
		const overrides = parseModelOverrides(frontmatter.model_overrides);
		return {
			type: "ai-notebook",
			notebook_id: String(frontmatter.notebook_id ?? ""),
			name: String(frontmatter.name ?? folderName),
			template_id: String(frontmatter.template_id ?? "blank"),
			current_blueprint: Number(frontmatter.current_blueprint ?? 1),
			created: String(frontmatter.created ?? ""),
			updated: String(frontmatter.updated ?? ""),
			provider_profile_id:
				frontmatter.provider_profile_id == null ||
				frontmatter.provider_profile_id === "null"
					? null
					: String(frontmatter.provider_profile_id),
			model_overrides: overrides,
			folderName,
		};
	}

	async createNotebook(input: {
		name: string;
		templateId: TemplateId;
	}): Promise<NotebookMeta> {
		const settings = this.getSettings();
		const name = input.name.trim() || "未命名记录本";
		let folderName = sanitizeFolderName(name);
		const root = notebooksRoot(settings);
		await this.vault.ensureFolder(root);

		// ensure unique folder
		let candidate = folderName;
		let n = 2;
		while (await this.vault.exists(notebookFolderPath(settings, candidate))) {
			candidate = `${folderName}-${n}`;
			n++;
		}
		folderName = candidate;

		const notebookId = createId();
		const created = nowIso();
		const blueprint = buildTemplateBlueprint(input.templateId, name);

		await this.vault.ensureFolder(itemsDir(settings, folderName));
		await this.vault.ensureFolder(blueprintsDir(settings, folderName));
		await this.vault.ensureFolder(cabinetDir(settings, folderName));
		await this.vault.ensureFolder(trashItemsDir(settings, folderName));

		const { version } = await this.versions.commit(
			folderName,
			notebookId,
			blueprint,
			{
				author: "template",
				changeSummary: `从模板 ${input.templateId} 初始化`,
			},
		);

		await this.vault.writeJson(
			`${cabinetDir(settings, folderName)}/links.json`,
			{ items: [] },
		);
		await this.vault.writeJson(
			`${cabinetDir(settings, folderName)}/files.json`,
			{ items: [] },
		);

		const meta: NotebookMeta = {
			type: "ai-notebook",
			notebook_id: notebookId,
			name,
			template_id: input.templateId,
			current_blueprint: version,
			created,
			updated: created,
			provider_profile_id: null,
			model_overrides: { planner: null, worker: null, voice: null },
			folderName,
		};

		await this.writeMeta(meta);
		return meta;
	}

	async writeMeta(meta: NotebookMeta): Promise<void> {
		const settings = this.getSettings();
		const path = notebookMetaPath(settings, meta.folderName);
		const fm = {
			type: "ai-notebook",
			notebook_id: meta.notebook_id,
			name: meta.name,
			template_id: meta.template_id,
			current_blueprint: meta.current_blueprint,
			created: meta.created,
			updated: meta.updated,
			provider_profile_id: meta.provider_profile_id,
			// flat JSON string — simple frontmatter parser has no nested maps
			model_overrides: JSON.stringify(meta.model_overrides),
		};
		const body = `# ${meta.name}\n\n此文件标记一个 AI 记录本实例。功能以 \`blueprints/\` 为准；条目在 \`items/\`。\n`;
		await this.vault.write(path, serializeFrontmatter(fm, body));
	}

	async touchCurrentBlueprint(
		meta: NotebookMeta,
		version: number,
	): Promise<NotebookMeta> {
		const next: NotebookMeta = {
			...meta,
			current_blueprint: version,
			updated: nowIso(),
		};
		await this.writeMeta(next);
		return next;
	}

	async findById(notebookId: string): Promise<NotebookMeta | null> {
		const all = await this.listNotebooks();
		return all.find((n) => n.notebook_id === notebookId) ?? null;
	}
}

function parseModelOverrides(raw: unknown): NotebookMeta["model_overrides"] {
	const empty = { planner: null, worker: null, voice: null };
	if (raw == null || raw === "") return empty;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			return {
				planner:
					parsed.planner == null || parsed.planner === ""
						? null
						: String(parsed.planner),
				worker:
					parsed.worker == null || parsed.worker === ""
						? null
						: String(parsed.worker),
				voice:
					parsed.voice == null || parsed.voice === ""
						? null
						: String(parsed.voice),
			};
		} catch {
			return empty;
		}
	}
	return empty;
}
