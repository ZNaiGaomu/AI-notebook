import type {
	AiNotebookSettings,
	Blueprint,
	NotebookItem,
	NotebookMeta,
} from "../domain/types";
import { joinPath, structuredAttachmentsDir } from "../infra/paths";
import type { IVaultFs } from "../infra/vaultPort";
import type { ItemService } from "./itemService";
import { itemDisplayName } from "./itemDisplayName";
import type { CabinetService } from "./cabinetService";
import type { AttachmentService } from "./attachmentService";
import { buildAttachmentEmbedMarkdown } from "./attachmentService";

/**
 * Structured actions the assistant may emit and the plugin will execute.
 * Default target is the currently selected item unless create / item_id is explicit.
 */
export type AssistantAction =
	| {
			type: "update_item";
			/** Omit or "current" → active selection. Otherwise item_id. */
			item_id?: string | null;
			title?: string;
			body?: string;
			fields?: Record<string, unknown>;
	  }
	| {
			type: "create_item";
			title: string;
			body?: string;
			entityType?: string;
			fields?: Record<string, unknown>;
	  }
	| {
			/**
			 * Put file into 收藏柜 only. Do NOT use for “放进正文/笔记”.
			 */
			type: "attach_chat_file";
			file_ref: string;
			item_id?: string | null;
	  }
	| {
			/**
			 * Copy upload into vault attachments and embed into item body as
			 * Obsidian media (image preview / video playable), not just a bare URL.
			 * Does NOT add to 收藏柜.
			 */
			type: "embed_in_body";
			file_ref: string;
			item_id?: string | null;
			/** Caption / description placed under the media */
			caption?: string;
			/** append (default) | prepend | replace_body */
			placement?: "append" | "prepend" | "replace_body";
			/** Optional full body when placement is replace_body (media embed injected automatically) */
			body?: string;
	  };

export type PendingChatFile = {
	id: string;
	name: string;
	mime: string;
	size: number;
	data: ArrayBuffer;
	/** data URL for images (small enough) used in multimodal chat */
	dataUrl?: string;
	kind: "image" | "video" | "audio" | "text" | "other";
	/** Extracted text preview for non-image files */
	textPreview?: string;
	/**
	 * Vault-relative path after immediate persist (chat upload archive).
	 * Used for history open/download; independent of embed_in_body copy.
	 */
	vaultPath?: string;
};

export type AssistantParseResult = {
	reply: string;
	actions: AssistantAction[];
};

export type AssistantApplyResult = {
	messages: string[];
	updatedItem: NotebookItem | null;
	createdItem: NotebookItem | null;
};


/**
 * Extract optional trailing JSON actions from model reply.
 * Tolerates multiple fenced blocks and partially broken fences.
 */
export function parseAssistantResponse(raw: string): AssistantParseResult {
	const text = raw.trim();
	if (!text) return { reply: "", actions: [] };

	// Prefer last fenced json block (models often put prose then actions)
	const fenceGlobal = /```(?:json)?\s*([\s\S]*?)```/gi;
	let fenceMatch: RegExpExecArray | null;
	const fences: string[] = [];
	while ((fenceMatch = fenceGlobal.exec(text)) != null) {
		if (fenceMatch[1]?.trim()) fences.push(fenceMatch[1].trim());
	}
	for (let i = fences.length - 1; i >= 0; i--) {
		const parsed = tryParseJson(fences[i]!);
		if (!parsed) continue;
		const { reply, actions } = coerceParsed(parsed, text);
		if (actions.length) {
			// Strip all fenced blocks from display reply
			const cleaned = text
				.replace(/```(?:json)?\s*[\s\S]*?```/gi, "")
				.trim();
			return {
				reply: reply || cleaned || "已处理。",
				actions,
			};
		}
	}

	const brace = findTrailingJson(text);
	if (brace) {
		const parsed = tryParseJson(brace.json);
		if (parsed) {
			const { reply, actions } = coerceParsed(parsed, text);
			if (actions.length) {
				return {
					reply: reply || brace.before.trim() || "已处理。",
					actions,
				};
			}
		}
	}

	// Fallback: scan for embed_in_body / update_item objects in free text
	const loose = extractLooseActions(text);
	if (loose.actions.length) {
		return {
			reply: loose.reply || stripJsonNoise(text) || "已处理。",
			actions: loose.actions,
		};
	}

	return { reply: stripJsonNoise(text) || text, actions: [] };
}

function stripJsonNoise(text: string): string {
	return text
		.replace(/```(?:json)?\s*[\s\S]*?```/gi, "")
		.replace(/^\s*[\]}]\s*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Best-effort: find action-like objects when full JSON parse fails. */
function extractLooseActions(text: string): AssistantParseResult {
	const actions: AssistantAction[] = [];
	// Match individual action objects with type embed_in_body / update_item / ...
	const objRe =
		/\{\s*"type"\s*:\s*"(embed_in_body|embed_file|insert_media|embed_media|update_item|create_item|attach_chat_file)"[\s\S]*?\}/gi;
	let m: RegExpExecArray | null;
	while ((m = objRe.exec(text)) != null) {
		// expand to balanced braces from m.index
		const slice = extractBalancedObject(text, m.index);
		if (!slice) continue;
		const parsed = tryParseJson(slice);
		const act = parsed ? normalizeAction(parsed) : null;
		if (act) actions.push(act);
	}
	return { reply: stripJsonNoise(text), actions };
}

function extractBalancedObject(text: string, start: number): string | null {
	if (text[start] !== "{") return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') {
			inStr = true;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function coerceParsed(
	parsed: unknown,
	fallbackReply: string,
): AssistantParseResult {
	if (Array.isArray(parsed)) {
		return {
			reply: "",
			actions: parsed
				.map(normalizeAction)
				.filter((a): a is AssistantAction => a != null),
		};
	}
	if (parsed && typeof parsed === "object") {
		const o = parsed as Record<string, unknown>;
		if ("actions" in o || "reply" in o || "message" in o) {
			const actionsRaw = Array.isArray(o.actions) ? o.actions : [];
			return {
				reply:
					(typeof o.reply === "string" && o.reply) ||
					(typeof o.message === "string" && o.message) ||
					"",
				actions: actionsRaw
					.map(normalizeAction)
					.filter((a): a is AssistantAction => a != null),
			};
		}
		const one = normalizeAction(o);
		if (one) {
			return { reply: "", actions: [one] };
		}
	}
	return { reply: fallbackReply, actions: [] };
}

function normalizeAction(raw: unknown): AssistantAction | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const type = String(o.type ?? o.action ?? "").trim();

	if (type === "update_item" || type === "update" || type === "edit_item") {
		const fields =
			o.fields && typeof o.fields === "object" && !Array.isArray(o.fields)
				? (o.fields as Record<string, unknown>)
				: undefined;
		return {
			type: "update_item",
			item_id:
				o.item_id == null || o.item_id === "current"
					? null
					: String(o.item_id),
			title: typeof o.title === "string" ? o.title : undefined,
			body: typeof o.body === "string" ? o.body : undefined,
			fields,
		};
	}

	if (type === "create_item" || type === "create") {
		const title =
			typeof o.title === "string" && o.title.trim()
				? o.title.trim()
				: "未命名";
		const fields =
			o.fields && typeof o.fields === "object" && !Array.isArray(o.fields)
				? (o.fields as Record<string, unknown>)
				: undefined;
		return {
			type: "create_item",
			title,
			body: typeof o.body === "string" ? o.body : undefined,
			entityType:
				typeof o.entityType === "string"
					? o.entityType
					: typeof o.entity_type === "string"
						? o.entity_type
						: undefined,
			fields,
		};
	}

	if (
		type === "embed_in_body" ||
		type === "embed_file" ||
		type === "insert_media" ||
		type === "embed_media"
	) {
		const fileRef = String(
			o.file_ref ?? o.file ?? o.name ?? o.filename ?? "",
		).trim();
		if (!fileRef) return null;
		const placementRaw = String(o.placement ?? "append");
		const placement =
			placementRaw === "prepend" || placementRaw === "replace_body"
				? placementRaw
				: "append";
		return {
			type: "embed_in_body",
			file_ref: fileRef,
			item_id:
				o.item_id == null || o.item_id === "current"
					? null
					: String(o.item_id),
			caption:
				typeof o.caption === "string"
					? o.caption
					: typeof o.description === "string"
						? o.description
						: undefined,
			placement,
			body: typeof o.body === "string" ? o.body : undefined,
		};
	}

	if (
		type === "attach_chat_file" ||
		type === "attach_file" ||
		type === "import_file" ||
		type === "cabinet_attach"
	) {
		const fileRef = String(
			o.file_ref ?? o.file ?? o.name ?? o.filename ?? "",
		).trim();
		if (!fileRef) return null;
		return {
			type: "attach_chat_file",
			file_ref: fileRef,
			item_id:
				o.item_id == null || o.item_id === "current"
					? null
					: String(o.item_id),
		};
	}

	return null;
}

function tryParseJson(s: string): unknown | null {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

function findTrailingJson(
	text: string,
): { before: string; json: string } | null {
	const lastObj = text.lastIndexOf("\n{");
	const lastArr = text.lastIndexOf("\n[");
	const lastBrace = text.lastIndexOf("{");
	const lastBracket = text.lastIndexOf("[");
	let start = -1;
	if (lastObj >= 0 || lastArr >= 0) {
		start = Math.max(
			lastObj >= 0 ? lastObj + 1 : -1,
			lastArr >= 0 ? lastArr + 1 : -1,
		);
	} else {
		if (text.startsWith("{") || text.startsWith("[")) start = 0;
		else start = Math.max(lastBrace, lastBracket);
	}
	if (start < 0) return null;
	const json = text.slice(start).trim();
	if (!(json.startsWith("{") || json.startsWith("["))) return null;
	if (tryParseJson(json) == null) return null;
	return { before: text.slice(0, start), json };
}

export class AssistantActionRunner {
	constructor(
		private readonly items: ItemService,
		private readonly cabinet: CabinetService,
		private readonly attachments: AttachmentService,
		private readonly vault: IVaultFs,
		private readonly getSettings: () => AiNotebookSettings,
	) {}

	async apply(
		meta: NotebookMeta,
		blueprint: Blueprint,
		activeItem: NotebookItem | null,
		allItems: NotebookItem[],
		actions: AssistantAction[],
		pendingFiles: PendingChatFile[],
	): Promise<AssistantApplyResult> {
		const messages: string[] = [];
		let updatedItem: NotebookItem | null = null;
		let createdItem: NotebookItem | null = null;

		for (const action of actions) {
			try {
				if (action.type === "update_item") {
					const target = resolveTargetItem(
						action.item_id,
						activeItem,
						allItems,
					);
					if (!target) {
						messages.push(
							"跳过 update_item：没有目标条目（请先选中条目或指定 item_id）",
						);
						continue;
					}
					const next = await this.items.updateItem(target, {
						title: action.title,
						body: action.body,
						fields: action.fields,
						schemaVersion: blueprint.blueprintVersion,
					});
					updatedItem = next;
					patchList(allItems, next);
					if (
						activeItem &&
						activeItem.frontmatter.item_id === next.frontmatter.item_id
					) {
						activeItem = next;
					}
					messages.push(`已更新条目「${next.frontmatter.title}」`);
				} else if (action.type === "create_item") {
					const created = await this.items.createItem(meta, {
						title: action.title,
						body: action.body,
						entityType: action.entityType,
						fields: action.fields,
					});
					createdItem = created;
					allItems.push(created);
					messages.push(`已新建条目「${created.frontmatter.title}」`);
				} else if (action.type === "embed_in_body") {
					const file = resolvePendingFile(action.file_ref, pendingFiles);
					if (!file) {
						const hint =
							pendingFiles.length === 0
								? "（会话里没有可用附件，请重新上传后再说「插入正文」）"
								: `（当前可用：${pendingFiles
										.map((f, i) => `[${i}]${f.name}`)
										.join("、")}）`;
						messages.push(
							`跳过 embed_in_body：找不到附件「${action.file_ref}」${hint}`,
						);
						continue;
					}
					const target = resolveTargetItem(
						action.item_id,
						activeItem,
						allItems,
					);
					if (!target) {
						messages.push(
							"跳过 embed_in_body：没有目标条目（请先选中条目）",
						);
						continue;
					}
					const stored = await this.attachments.importBinary(meta, {
						displayName: file.name,
						data: file.data,
						mime: file.mime,
						item_id: target.frontmatter.item_id,
						itemName: itemDisplayName(target),
						kind: "embedded",
						origin: "assistant-embed",
					});
					const vaultPath = stored.vaultPath;
					const embedMd = buildAttachmentEmbedMarkdown(stored, {
						caption: action.caption,
					});
					const placement = action.placement ?? "append";
					let nextBody: string;
					if (placement === "replace_body") {
						const base =
							action.body != null ? action.body : embedMd;
						// ensure embed present if model only gave caption text
						nextBody = base.includes(vaultPath)
							? base
							: `${embedMd}\n\n${base}`.trim();
					} else if (placement === "prepend") {
						nextBody = [embedMd, target.body]
							.filter(Boolean)
							.join("\n\n");
					} else {
						nextBody = [target.body, embedMd]
							.filter(Boolean)
							.join("\n\n");
					}
					const next = await this.items.updateItem(target, {
						body: nextBody,
					});
					updatedItem = next;
					patchList(allItems, next);
					if (
						activeItem &&
						activeItem.frontmatter.item_id === next.frontmatter.item_id
					) {
						activeItem = next;
					}
					messages.push(
						`已将「${file.name}」嵌入正文（可预览/播放，未进收藏柜）`,
					);
				} else if (action.type === "attach_chat_file") {
					const file = resolvePendingFile(action.file_ref, pendingFiles);
					if (!file) {
						messages.push(
							`跳过 attach_chat_file：找不到附件「${action.file_ref}」`,
						);
						continue;
					}
					const target = resolveTargetItem(
						action.item_id,
						activeItem,
						allItems,
					);
					const cab = await this.cabinet.importBinary(meta, {
						displayName: file.name,
						data: file.data,
						mime: file.mime,
						item_id: target?.frontmatter.item_id ?? null,
						itemName: target ? itemDisplayName(target) : null,
						kind: "backup",
						origin: "assistant-cabinet",
					});
					if (target) {
						const refs = [
							...new Set([
								...target.frontmatter.cabinet_refs,
								cab.id,
							]),
						];
						const next = await this.items.updateItem(target, {
							fields: { cabinet_refs: refs },
						});
						updatedItem = next;
						patchList(allItems, next);
						messages.push(
							`已将「${file.name}」放入收藏柜并关联到「${next.frontmatter.title}」`,
						);
					} else {
						messages.push(
							`已将「${file.name}」放入本记录本收藏柜（未关联条目）`,
						);
					}
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				messages.push(`动作失败（${action.type}）：${msg}`);
			}
		}

		return { messages, updatedItem, createdItem };
	}

	private async writePendingToAttachments(
		meta: NotebookMeta,
		item: NotebookItem,
		file: PendingChatFile,
	): Promise<string> {
		const settings = this.getSettings();
		const destDir = structuredAttachmentsDir(
			settings,
			meta.notebook_id,
			meta.name,
			item.frontmatter.item_id,
			item.frontmatter.title,
			"embedded",
		);
		await this.vault.ensureFolder(destDir);
		const safeName = await uniqueName(
			sanitizeFileName(file.name),
			async (n) => this.vault.exists(joinPath(destDir, n)),
		);
		const vaultPath = joinPath(destDir, safeName);
		if (!this.vault.writeBinary) {
			throw new Error("当前存储不支持二进制写入，无法嵌入媒体");
		}
		await this.vault.writeBinary(vaultPath, file.data);
		return vaultPath;
	}
}

function patchList(all: NotebookItem[], next: NotebookItem): void {
	const idx = all.findIndex(
		(it) => it.frontmatter.item_id === next.frontmatter.item_id,
	);
	if (idx >= 0) all[idx] = next;
}

/**
 * Obsidian-native embeds: images render, videos play in reading view.
 * Also include HTML fallback for our in-plugin detail preview.
 */
/**
 * One embed only — wiki `![[path]]` is enough for Obsidian preview/playback.
 * (Previously wiki + md/html double-embed caused the same image twice.)
 */
export function buildMediaEmbedMarkdown(
	vaultPath: string,
	file: PendingChatFile,
	caption?: string,
): string {
	const path = vaultPath.replace(/\\/g, "/");
	let media: string;
	if (file.kind === "image" || file.kind === "video" || file.kind === "audio") {
		media = `![[${path}]]`;
	} else {
		media = `[${file.name}](${path})`;
	}
	const cap = caption?.trim() ? `\n\n${caption.trim()}` : "";
	return `${media}${cap}`;
}

function resolveTargetItem(
	itemId: string | null | undefined,
	active: NotebookItem | null,
	all: NotebookItem[],
): NotebookItem | null {
	if (!itemId || itemId === "current") return active;
	return (
		all.find((it) => it.frontmatter.item_id === itemId) ??
		all.find((it) => it.frontmatter.title === itemId) ??
		null
	);
}

function resolvePendingFile(
	ref: string,
	files: PendingChatFile[],
): PendingChatFile | null {
	const r = ref.trim();
	if (!r) return null;
	const byId = files.find((f) => f.id === r || f.name === r);
	if (byId) return byId;
	if (/^\d+$/.test(r)) {
		const i = Number(r);
		return files[i] ?? null;
	}
	// basename without extension
	const rBase = r.replace(/\.[^.]+$/, "").toLowerCase();
	const rNorm = r.toLowerCase();
	const byPartial = files.find((f) => {
		const n = f.name.toLowerCase();
		const nBase = n.replace(/\.[^.]+$/, "");
		return (
			n === rNorm ||
			n.includes(rNorm) ||
			rNorm.includes(n) ||
			nBase === rBase ||
			nBase.includes(rBase) ||
			rBase.includes(nBase)
		);
	});
	if (byPartial) return byPartial;
	// single pending file → use it
	if (files.length === 1) return files[0]!;
	return null;
}

/**
 * When user clearly asks to put uploads into note body but the model omitted
 * structured actions, synthesize embed_in_body for each pending file.
 */
export function maybeInferEmbedActions(
	userText: string,
	actions: AssistantAction[],
	pending: PendingChatFile[],
): AssistantAction[] {
	if (!pending.length) return actions;
	if (actions.some((a) => a.type === "embed_in_body")) return actions;
	const t = userText.toLowerCase();
	const wantsEmbed =
		/插入正文|放进正文|写入正文|放进笔记|插入笔记|embed|正文里|笔记里|图和描述|图片.*正文|正文.*图|视频.*正文|正文.*视频/.test(
			userText,
		) || /insert.*(body|note)|into (the )?note/i.test(t);
	if (!wantsEmbed) return actions;
	const inferred: AssistantAction[] = pending.map((f, i) => ({
		type: "embed_in_body" as const,
		file_ref: f.name || String(i),
		item_id: null,
		caption: undefined,
		placement: "append" as const,
	}));
	return [...actions, ...inferred];
}

function sanitizeFileName(name: string): string {
	const base = name.replace(/[\\/:*?"<>|]/g, "_").trim() || "file";
	return base.slice(0, 120);
}

async function uniqueName(
	base: string,
	exists: (name: string) => Promise<boolean>,
): Promise<string> {
	if (!(await exists(base))) return base;
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	for (let i = 1; i < 1000; i++) {
		const n = `${stem}-${i}${ext}`;
		if (!(await exists(n))) return n;
	}
	return `${stem}-${Date.now()}${ext}`;
}

/** Build system prompt rules for assistant write tools. */
export function assistantToolSystemAppendix(
	pendingFiles: PendingChatFile[],
): string {
	const fileList =
		pendingFiles.length === 0
			? "（本轮无上传文件）"
			: pendingFiles
					.map(
						(f, i) =>
							`- [${i}] id=${f.id} name=${f.name} kind=${f.kind} mime=${f.mime} size=${f.size}`,
					)
					.join("\n");

	return [
		"你是记录本助手，可以**真正写入**笔记（条目）内容，不是只能建议。",
		"职责：改当前选中条目的标题/正文/字段、按指令重排内容结构；也可在用户明确要求时新建条目或改其它条目。",
		"不要修改记录本的「功能蓝图」（加字段类型、开收藏柜能力等属于「改功能」模式，不是你的职责）。",
		"",
		"【上传文件规则 — 很重要】",
		"- 默认：仅作理解参考，不要 attach，不要 embed。",
		"- 用户要求「放进正文/插入笔记/图片和描述都放进正文/视频放进正文」→ 必须用 embed_in_body（会复制文件并用 Obsidian 媒体语法嵌入，正文里可看图/播视频）。**禁止**用 attach_chat_file。",
		"- 用户明确说「放进收藏柜/cabinet」→ 才用 attach_chat_file。",
		"- 图+描述：embed_in_body 的 caption 写描述；placement 默认 append。",
		"",
		"当你需要写入时，在回复末尾附加一个 JSON 代码块，格式：",
		"```json",
		"{",
		'  "reply": "给用户看的简短中文说明",',
		'  "actions": [',
		'    { "type": "update_item", "title": "可选", "body": "可选全文", "fields": {} },',
		'    { "type": "create_item", "title": "标题", "body": "可选" },',
		'    { "type": "embed_in_body", "file_ref": "文件名或id或0", "caption": "图片/视频描述", "placement": "append" },',
		'    { "type": "attach_chat_file", "file_ref": "…", "item_id": "current" }',
		"  ]",
		"}",
		"```",
		"规则：",
		"1. 默认 update_item / embed_in_body 作用于当前选中条目。",
		"2. 用户明确说新建时才 create_item。",
		"3. 纯问答、无需写入时不要输出 actions。",
		"4. body 若 update_item 更新请给完整正文（会覆盖）。embed_in_body 会自动插入媒体，无需手写路径。",
		"",
		"本轮上传文件：",
		fileList,
	].join("\n");
}
