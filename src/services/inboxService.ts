import { itemDisplayName } from "./itemDisplayName";
import type { AiNotebookSettings, NotebookMeta } from "../domain/types";
import { createId, nowIso, shortId, todayDatePrefix } from "../domain/ids";
import {
	parseFrontmatter,
	serializeFrontmatter,
} from "../infra/frontmatter";
import {
	inboxFilesDir,
	inboxPendingDir,
	inboxProcessedDir,
	inboxRoot,
	inboxVoiceDir,
	joinPath,
} from "../infra/paths";
import type { AttachmentService } from "./attachmentService";
import { buildAttachmentEmbedMarkdown } from "./attachmentService";
import type { ItemService } from "./itemService";
import type { NotebookItem } from "../domain/types";
import type { IVaultFs } from "../infra/vaultPort";
import type { OrganizeService } from "./organizeService";
import type { NotebookService } from "./notebookService";

export type InboxListItem = {
	path: string;
	name: string;
	title: string;
	preview: string;
	source: string;
	created: string;
};

/**
 * Mobile / cross-device dump area inside the vault.
 * Phone writes notes into AI Inbox/pending via Obsidian mobile + Sync.
 * Desktop (or mobile with plugin) processes them into notebooks via AI.
 */
export class InboxService {
	attachments: AttachmentService | null = null;
	items: ItemService | null = null;

	constructor(
		private readonly vault: IVaultFs,
		private readonly notebooks: NotebookService,
		private readonly organize: OrganizeService,
		private readonly getSettings: () => AiNotebookSettings,
	) {}

	async ensureStructure(): Promise<void> {
		const s = this.getSettings();
		await this.vault.ensureFolder(inboxRoot(s));
		await this.vault.ensureFolder(inboxPendingDir(s));
		await this.vault.ensureFolder(inboxProcessedDir(s));
		await this.vault.ensureFolder(inboxVoiceDir(s));
		await this.vault.ensureFolder(inboxFilesDir(s));

		const readme = joinPath(inboxRoot(s), "如何用手机投递.md");
		if (!(await this.vault.exists(readme))) {
			await this.vault.write(
				readme,
				[
					"# 手机如何把信息送进 AI 记录本",
					"",
					"## 链路",
					"",
					"```",
					"手机 Obsidian → 写入「AI Inbox/pending」→ 同步到电脑 → 插件 AI 整理 → 对应记录本 items/",
					"```",
					"",
					"## 步骤",
					"",
					"1. **同一 Vault**：手机与电脑打开同一个库（Obsidian Sync / iCloud / Syncthing / Git 等）。",
					"2. 在手机新建笔记，保存到文件夹 **`AI Inbox/pending/`**（名称可在插件设置改）。",
					"3. 随便写：聊天记录、链接、随手拍后的文字、待办… 越乱越好，交给 AI。",
					"4. 同步完成后，在任意端打开插件：",
					"   - 命令面板：`处理收件箱（AI 整理）`",
					"   - 或记录本视图 → **收件箱** 页签 → 处理",
					"5. 整理后的结构化条目进入目标记录本；原文可归档到 `AI Inbox/processed/`。",
					"",
					"## 语音",
					"",
					"- 手机/电脑插件内点 **语音录入** → 转写 →（可选）AI 按蓝图抽字段 → 写入记录本。",
					"- 转写原文也可落到 `AI Inbox/voice-raw/` 备查。",
					"",
					"## 提示",
					"",
					"- 不需要单独 App；手机只是 vault 的输入端。",
					"- API Key 每台设备在插件设置里各自配置（不同步密钥更安全）。",
					"",
				].join("\n"),
			);
		}
	}

	async listPending(): Promise<InboxListItem[]> {
		await this.ensureStructure();
		const dir = inboxPendingDir(this.getSettings());
		const files = this.vault
			.listFilesInFolder(dir)
			.filter((f) => f.extension === "md");
		const out: InboxListItem[] = [];
		for (const f of files) {
			// only direct children ideally; listFilesInFolder is recursive — skip processed paths
			if (f.path.includes("/processed/") || f.path.endsWith("如何用手机投递.md")) {
				continue;
			}
			if (!f.path.startsWith(dir + "/") && f.path !== dir) {
				// allow only under pending
			}
			try {
				const raw = await this.vault.read(f.path);
				const { frontmatter, body } = parseFrontmatter(raw);
				const name = f.path.slice(f.path.lastIndexOf("/") + 1);
				out.push({
					path: f.path,
					name,
					title:
						String(frontmatter.title ?? "") ||
						name.replace(/\.md$/i, "") ||
						"未命名",
					preview: body.trim().slice(0, 120),
					source: String(frontmatter.source ?? "unknown"),
					created: String(frontmatter.created ?? ""),
				});
			} catch {
				// skip
			}
		}
		return out.sort((a, b) => b.path.localeCompare(a.path));
	}

	/** Dump free text into pending inbox (from mobile command or paste). */
	async dumpRaw(input: {
		text: string;
		source?: "mobile" | "voice" | "paste" | "share" | "unknown";
		title?: string;
	}): Promise<string> {
		await this.ensureStructure();
		const s = this.getSettings();
		const id = shortId(createId(), 8);
		const title =
			input.title?.trim() ||
			input.text.trim().split(/\n/)[0]?.slice(0, 40) ||
			"手机速记";
		const fileName = `${todayDatePrefix()}-${id}.md`;
		const path = joinPath(inboxPendingDir(s), fileName);
		const content = serializeFrontmatter(
			{
				ai_inbox: true,
				source: input.source ?? "mobile",
				title,
				created: nowIso(),
				status: "pending",
			},
			input.text.endsWith("\n") ? input.text : `${input.text}\n`,
		);
		await this.vault.write(path, content);
		return path;
	}

		/** Save binary file under inbox/files and create a pending note with embed. */
	async dumpBinary(input: {
		fileName: string;
		data: ArrayBuffer;
		mime?: string;
		source?: "mobile" | "paste" | "share" | "unknown";
		title?: string;
		note?: string;
	}): Promise<{ notePath: string; filePath: string }> {
		await this.ensureStructure();
		const s = this.getSettings();
		const id = shortId(createId(), 8);
		const safeName = (input.fileName || "file.bin")
			.replace(/[\\/:*?"<>|]/g, "-")
			.trim() || "file.bin";
		const filePath = joinPath(inboxFilesDir(s), `${todayDatePrefix()}-${id}-${safeName}`);
		if (!this.vault.writeBinary) {
			throw new Error("当前存储不支持二进制写入");
		}
		await this.vault.writeBinary(filePath, input.data);
		const title =
			input.title?.trim() ||
			safeName.replace(/\.[^.]+$/, "") ||
			"手机文件";
		const notePath = joinPath(
			inboxPendingDir(s),
			`${todayDatePrefix()}-${id}.md`,
		);
		const mime = input.mime || "application/octet-stream";
		const body = [
			input.note?.trim() || "",
			`![[${filePath}]]`,
			"",
			`文件：\`${safeName}\``,
			`类型：${mime}`,
			`大小：${input.data.byteLength} 字节`,
			"",
			"> 收件箱已保存原文件，整理进记录本后可在条目中预览/播放。",
		]
			.filter((x) => x !== "")
			.join("\n");
		const content = serializeFrontmatter(
			{
				ai_inbox: true,
				source: input.source ?? "mobile",
				title,
				created: nowIso(),
				status: "pending",
				inbox_file: filePath,
				mime,
			},
			body.endsWith("\n") ? body : `${body}\n`,
		);
		await this.vault.write(notePath, content);
		return { notePath, filePath };
	}

async resolveTargetNotebook(): Promise<NotebookMeta | null> {
		const s = this.getSettings();
		const id =
			s.inbox.defaultNotebookId || s.ui.lastNotebookId || null;
		if (id) {
			const found = await this.notebooks.findById(id);
			if (found) return found;
		}
		const all = await this.notebooks.listNotebooks();
		return all[0] ?? null;
	}

	/**
	 * Process one pending file → structured notebook item via AI.
	 */
	async processOne(
		path: string,
		opts?: {
			notebook?: NotebookMeta;
			useAi?: boolean;
			/** Append into this existing item instead of creating a new one. */
			targetItemId?: string | null;
			/** Create new item when target missing (default true). */
			createIfMissing?: boolean;
		},
	): Promise<
		| {
				ok: true;
				itemPath: string;
				notebookName: string;
				organized: boolean;
				appended?: boolean;
				itemId?: string;
		  }
		| { ok: false; error: string }
	> {
		const meta = opts?.notebook ?? (await this.resolveTargetNotebook());
		if (!meta) {
			return {
				ok: false,
				error: "没有可用的记录本。请先新建一个 AI 记录本。",
			};
		}

		let raw: string;
		try {
			raw = await this.vault.read(path);
		} catch {
			return { ok: false, error: `读文件失败: ${path}` };
		}
		const { frontmatter, body } = parseFrontmatter(raw);
		const text = [frontmatter.title ? String(frontmatter.title) : "", body]
			.filter(Boolean)
			.join("\n\n")
			.trim();
		if (!text) return { ok: false, error: "收件内容为空" };

		const inboxFile =
			typeof frontmatter.inbox_file === "string"
				? frontmatter.inbox_file.trim()
				: "";
		const inboxFilesRoot = inboxFilesDir(this.getSettings()).replace(/\\/g, "/").replace(/\/+$/, "");
		const normalizedInboxFile = inboxFile.replace(/\\/g, "/").replace(/^\/+/, "");
		const safeInboxFile =
			Boolean(normalizedInboxFile) &&
			!normalizedInboxFile.split("/").includes("..") &&
			!normalizedInboxFile.startsWith("/") &&
			!normalizedInboxFile.toLowerCase().endsWith(".md") &&
			(normalizedInboxFile === inboxFilesRoot || normalizedInboxFile.startsWith(`${inboxFilesRoot}/`));
		const targetItemId = opts?.targetItemId?.trim() || null;
		let item: NotebookItem | null = null;
		let organized = false;
		let appended = false;

		if (targetItemId && this.items) {
			item = await this.items.findById(meta, targetItemId);
			if (!item && opts?.createIfMissing === false) {
				return { ok: false, error: "目标条目不存在" };
			}
		}

		if (item && this.items) {
			// Direct append into chosen item (optionally AI-polished body)
			let addition = text;
			if (opts?.useAi !== false) {
				const result = await this.organize.organizeText(meta, text, {
					sourceHint: "来自收件箱/手机投递",
				});
				if (result.ok) {
					addition = result.summary
						? `> ${result.summary}\n\n${result.body}`
						: result.body;
					organized = true;
				}
			}
			// keep embeds from original inbox note
			const embeds = text.match(/!\[\[[^\]]+\]\]/g) ?? [];
			for (const e of embeds) {
				if (!addition.includes(e)) {
					addition = `${addition.trimEnd()}\n\n${e}`;
				}
			}
			item = await this.items.appendToItem(item, {
				body: addition,
				heading: organized ? "收件箱整理" : "收件箱追加",
			});
			appended = true;
		} else {
			const captured = await this.organize.captureStructured(meta, text, {
				useAi: opts?.useAi !== false,
				source: String(frontmatter.source ?? "mobile"),
				inboxPath: path,
				sourceHint: "来自收件箱/手机投递",
				preserveEmbedsFrom: text,
			});
			item = captured.item;
			organized = captured.organized;
		}

		// Move inbox binary into attachment management for the item
		if (item && this.attachments && safeInboxFile) {
			try {
				const absorbed = await this.attachments.absorbVaultFile(meta, {
					vaultPath: normalizedInboxFile,
					item_id: item.frontmatter.item_id,
					itemName: itemDisplayName(item),
					kind: "backup",
					origin: "inbox-file",
					mime: String(frontmatter.mime ?? ""),
				});
				if (absorbed && this.items) {
					const rewritten = this.attachments.rewriteEmbedPaths(item.body, [
						{ from: absorbed.from, to: absorbed.to },
					]);
					// ensure embed present
					let body = rewritten;
					if (!body.includes(absorbed.to)) {
						body = `${body.trimEnd()}\n\n${buildAttachmentEmbedMarkdown(absorbed.record)}`;
					}
					if (body !== item.body) {
						item = await this.items.updateItem(item, { body });
					}
				}
			} catch {
				// keep inbox file if absorb fails
			}
		} else if (item && this.attachments && this.items) {
			// Absorb any other embeds referenced by the note
			try {
				const { item: next, rewrites } =
					await this.attachments.absorbEmbedsInItem(meta, item);
				if (rewrites.length && next.body !== item.body) {
					item = await this.items.updateItem(item, { body: next.body });
				}
			} catch {
				// ignore
			}
		}

		const s = this.getSettings();
		if (s.inbox.archiveAfterOrganize) {
			const base = path.slice(path.lastIndexOf("/") + 1);
			const dest = joinPath(
				inboxProcessedDir(s),
				`${todayDatePrefix()}-${base}`,
			);
			try {
				await this.vault.move(path, dest);
			} catch {
				// ignore archive failure
			}
		}

		return {
			ok: true,
			itemPath: item.path,
			notebookName: meta.name,
			organized,
			appended,
			itemId: item.frontmatter.item_id,
		};
	}

	async processAll(opts?: {
		useAi?: boolean;
	}): Promise<{ ok: number; fail: number; errors: string[] }> {
		const pending = await this.listPending();
		let ok = 0;
		let fail = 0;
		const errors: string[] = [];
		for (const p of pending) {
			const r = await this.processOne(p.path, { useAi: opts?.useAi });
			if (r.ok) ok++;
			else {
				fail++;
				errors.push(`${p.name}: ${r.error}`);
			}
		}
		return { ok, fail, errors };
	}

	/** Save voice transcript copy under voice-raw for audit. */
	async saveVoiceRaw(transcript: string): Promise<string> {
		await this.ensureStructure();
		const s = this.getSettings();
		const path = joinPath(
			inboxVoiceDir(s),
			`${todayDatePrefix()}-${shortId(createId(), 6)}.md`,
		);
		await this.vault.write(
			path,
			serializeFrontmatter(
				{
					ai_inbox: true,
					source: "voice",
					created: nowIso(),
				},
				transcript.endsWith("\n") ? transcript : `${transcript}\n`,
			),
		);
		return path;
	}
}
