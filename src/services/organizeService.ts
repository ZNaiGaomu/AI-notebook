import type {
	AiNotebookSettings,
	Blueprint,
	NotebookItem,
	NotebookMeta,
	ProviderProfile,
} from "../domain/types";
import type { ChatMessage } from "../infra/aiGateway";
import type { HookRunner } from "./hookRunner";
import type { ItemService } from "./itemService";
import type { VersionService } from "./versionService";

export type ChatGateway = {
	chat(
		profile: ProviderProfile,
		model: string,
		messages: ChatMessage[],
		opts?: { maxTokens?: number; temperature?: number },
	): Promise<
		| { ok: true; content: string; raw: unknown }
		| { ok: false; error: string }
	>;
};

export type OrganizeResult =
	| {
			ok: true;
			title: string;
			fields: Record<string, unknown>;
			body: string;
			summary: string;
			tags: string[];
	  }
	| { ok: false; error: string };

/**
 * AI: messy free text → structured fields matching current blueprint entity.
 */
export class OrganizeService {
	/** Optional: set after construct to avoid circular ctor wiring. */
	hooks: HookRunner | null = null;

	constructor(
		private readonly gateway: ChatGateway,
		private readonly versions: VersionService,
		private readonly items: ItemService,
		private readonly getSettings: () => AiNotebookSettings,
		private readonly resolveWorker: (
			notebook?: NotebookMeta | null,
		) => { profile: ProviderProfile; model: string } | null,
	) {}

	async organizeText(
		meta: NotebookMeta,
		rawText: string,
		opts?: { entityType?: string; sourceHint?: string },
	): Promise<OrganizeResult> {
		const text = rawText.trim();
		if (!text) return { ok: false, error: "内容为空" };

		const resolved = this.resolveWorker(meta);
		if (!resolved) {
			return {
				ok: false,
				error: "未配置 AI Provider（worker）。请在设置中添加 URL + Key + 模型。",
			};
		}

		const { blueprint } = await this.versions.loadCurrentBlueprint(
			meta.folderName,
		);
		const entity =
			blueprint.entityTypes.find((e) => e.id === opts?.entityType) ??
			blueprint.entityTypes[0];
		if (!entity) return { ok: false, error: "蓝图无实体类型" };

		const fieldSpec = entity.fields.map((f) => ({
			id: f.id,
			label: f.label,
			type: f.type,
			options: f.options ?? null,
			required: Boolean(f.required),
		}));

		const system = `你是笔记结构化助手。把用户杂乱信息整理为 JSON（不要代码围栏外的废话）：
{
  "title": "简洁标题",
  "summary": "一两句摘要",
  "tags": ["标签"],
  "fields": { "字段id": 值 },
  "body": "规整后的分层 Markdown 正文（可用标题/列表）"
}
规则：
1. fields 的 key 必须来自给定字段定义；不要发明未定义字段。
2. select 值尽量落在 options 内；无法判断可留空字符串。
3. tags/multi-select 用字符串数组。
4. checkbox 用 boolean；number 用数字；date 用 YYYY-MM-DD。
5. body 用中文分层结构，保留关键事实与原文要点。
6. 只输出 JSON。`;

		const user = [
			`记录本: ${meta.name}`,
			`实体: ${entity.id} (${entity.label})`,
			`字段定义: ${JSON.stringify(fieldSpec)}`,
			opts?.sourceHint ? `来源提示: ${opts.sourceHint}` : "",
			"",
			"## 原始杂乱内容",
			text.slice(0, 12000),
		]
			.filter(Boolean)
			.join("\n");

		const chat = await this.gateway.chat(
			resolved.profile,
			resolved.model,
			[
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			{ maxTokens: 2048, temperature: 0.2 },
		);
		if (!chat.ok) return { ok: false, error: chat.error };

		const parsed = extractOrganizeJson(chat.content);
		if (!parsed.ok) return parsed;

		// sanitize fields to known ids
		const allowed = new Set(entity.fields.map((f) => f.id));
		const fields: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(parsed.fields)) {
			if (allowed.has(k) && k !== "title") fields[k] = v;
		}
		if (parsed.tags.length && allowed.has("tags")) {
			fields.tags = parsed.tags;
		}

		return {
			ok: true,
			title: parsed.title || text.slice(0, 40) || "整理条目",
			fields,
			body: parsed.body || text,
			summary: parsed.summary,
			tags: parsed.tags,
		};
	}

	/** Create notebook item from messy text (optionally AI-structured). */
	async captureStructured(
		meta: NotebookMeta,
		rawText: string,
		opts?: {
			useAi?: boolean;
			entityType?: string;
			source?: string;
			inboxPath?: string;
			sourceHint?: string;
			/** Mobile queue / capture instant (ISO or epoch ms) */
			capturedAt?: string | number | null;
			/**
			 * Markdown that must survive AI rewrite (e.g. audio embed).
			 * Appended if missing after organize.
			 */
			preserveEmbedsFrom?: string;
		},
	): Promise<{ item: NotebookItem; organized: boolean; error?: string }> {
		const useAi = opts?.useAi !== false;
		let title = rawText.trim().split(/\n/)[0]?.slice(0, 40) || "快速记录";
		let body = rawText;
		let fields: Record<string, unknown> = {};
		let organized = false;
		const embedSource = opts?.preserveEmbedsFrom || rawText;

		if (useAi) {
			const result = await this.organizeText(meta, rawText, {
				entityType: opts?.entityType,
				sourceHint: opts?.sourceHint,
			});
			if (result.ok) {
				title = result.title;
				body = result.summary
					? `> ${result.summary}\n\n${result.body}`
					: result.body;
				body = ensureVaultEmbeds(embedSource, body);
				fields = { ...result.fields };
				organized = true;
			} else {
				// fallback: still create raw item (keep embeds)
				const item = await this.items.createItem(meta, {
					title,
					body: ensureVaultEmbeds(embedSource, body),
					entityType: opts?.entityType,
					capturedAt: opts?.capturedAt,
					fields: {
						...fields,
						source: opts?.source ?? "unknown",
						organized: false,
						inbox_path: opts?.inboxPath ?? "",
					},
				});
				const afterHooks = await this.runCreateHooks(meta, item);
				return {
					item: afterHooks,
					organized: false,
					error: result.error,
				};
			}
		} else {
			body = ensureVaultEmbeds(embedSource, body);
		}

		const item = await this.items.createItem(meta, {
			title,
			body,
			entityType: opts?.entityType,
			capturedAt: opts?.capturedAt,
			fields: {
				...fields,
				source: opts?.source ?? "unknown",
				organized,
				inbox_path: opts?.inboxPath ?? "",
			},
		});
		const afterHooks = await this.runCreateHooks(meta, item);
		return { item: afterHooks, organized };
	}

	/** Run blueprint onCreate hooks when a HookRunner is attached. */
	private async runCreateHooks(
		meta: NotebookMeta,
		item: NotebookItem,
	): Promise<NotebookItem> {
		if (!this.hooks) return item;
		try {
			const { blueprint } = await this.versions.loadCurrentBlueprint(
				meta.folderName,
			);
			const result = await this.hooks.runOnCreate({
				meta,
				item,
				blueprint,
			});
			return result.item;
		} catch {
			return item;
		}
	}

	/** Re-organize an existing item's body into fields. */
	async reorganizeItem(
		meta: NotebookMeta,
		item: NotebookItem,
	): Promise<{ item: NotebookItem } | { error: string }> {
		const raw = [item.frontmatter.title, item.body].filter(Boolean).join("\n\n");
		const result = await this.organizeText(meta, raw, {
			entityType: item.frontmatter.entity_type,
			sourceHint: "重新整理已有条目",
		});
		if (!result.ok) return { error: result.error };

		const body = result.summary
			? `> ${result.summary}\n\n${result.body}`
			: result.body;
		const updated = await this.items.updateItem(item, {
			title: result.title,
			body,
			fields: {
				...result.fields,
				organized: true,
			},
		});
		return { item: updated };
	}

	fieldGuide(blueprint: Blueprint): string {
		return blueprint.entityTypes
			.map(
				(e) =>
					`${e.label}(${e.id}): ` +
					e.fields.map((f) => `${f.id}:${f.type}`).join(", "),
			)
			.join(" | ");
	}
}

/** Keep vault wikilink embeds (e.g. audio) after AI rewrites body. */
function ensureVaultEmbeds(original: string, nextBody: string): string {
	const embeds = original.match(/!\[\[[^\]]+\]\]/g) ?? [];
	if (!embeds.length) return nextBody;
	let out = nextBody;
	const missing: string[] = [];
	for (const e of embeds) {
		if (!out.includes(e)) missing.push(e);
	}
	if (!missing.length) return out;
	return `${out.trimEnd()}\n\n## 录音\n\n${missing.join("\n")}\n`;
}

function extractOrganizeJson(text: string):
	| {
			ok: true;
			title: string;
			summary: string;
			tags: string[];
			fields: Record<string, unknown>;
			body: string;
	  }
	| { ok: false; error: string } {
	const trimmed = text.trim();
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = fence ? fence[1]!.trim() : trimmed;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) {
		return { ok: false, error: "AI 响应中无 JSON" };
	}
	try {
		const obj = JSON.parse(body.slice(start, end + 1)) as Record<
			string,
			unknown
		>;
		const tags = Array.isArray(obj.tags)
			? obj.tags.map((t) => String(t))
			: [];
		const fields =
			obj.fields && typeof obj.fields === "object" && !Array.isArray(obj.fields)
				? (obj.fields as Record<string, unknown>)
				: {};
		return {
			ok: true,
			title: typeof obj.title === "string" ? obj.title : "整理条目",
			summary: typeof obj.summary === "string" ? obj.summary : "",
			tags,
			fields,
			body: typeof obj.body === "string" ? obj.body : "",
		};
	} catch (e) {
		return {
			ok: false,
			error: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}
