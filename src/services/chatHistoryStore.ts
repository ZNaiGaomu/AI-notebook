import type { App } from "obsidian";
import { createId, nowIso } from "../domain/ids";

export type ChatRole = "user" | "assistant" | "system";

/** Attachment archived with a chat message (open/download later). */
export type ChatMessageAttachment = {
	id: string;
	name: string;
	mime: string;
	size: number;
	/** Vault-relative path */
	vaultPath: string;
	kind: "image" | "video" | "audio" | "text" | "other";
};

export type ChatMessage = {
	id: string;
	role: ChatRole;
	content: string;
	createdAt: string;
	/** Present on user turns that included uploads */
	attachments?: ChatMessageAttachment[];
};

export type ChatThread = {
	id: string;
	mode: "assistant" | "feature";
	notebookId: string;
	/**
	 * Assistant threads are scoped to a notebook item.
	 * null = legacy / unscoped (shown under “未关联条目”).
	 * Feature threads always ignore itemId (notebook-level).
	 */
	itemId: string | null;
	/** Optional display title of the item at last write (UI convenience). */
	itemTitle?: string | null;
	title: string;
	messages: ChatMessage[];
	createdAt: string;
	updatedAt: string;
};

type StoreFile = {
	schemaVersion: 1;
	threads: ChatThread[];
};

const FILE = "ai-notebook-chat-history.json";
const MAX_THREADS = 120;
const MAX_MESSAGES = 200;

/**
 * Persist assistant / feature-edit chat threads outside plugin install folder.
 * Path: {vault}/.obsidian/ai-notebook-chat-history.json
 */
export class ChatHistoryStore {
	constructor(private readonly app: App) {}

	private path(): string {
		return `${this.app.vault.configDir}/${FILE}`;
	}

	async loadAll(): Promise<ChatThread[]> {
		try {
			const p = this.path();
			if (!(await this.app.vault.adapter.exists(p))) return [];
			const raw = await this.app.vault.adapter.read(p);
			const data = JSON.parse(raw) as StoreFile;
			const threads = Array.isArray(data.threads) ? data.threads : [];
			return threads.map(normalizeThread);
		} catch {
			return [];
		}
	}

	async saveAll(threads: ChatThread[]): Promise<void> {
		const trimmed = threads
			.map(normalizeThread)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.slice(0, MAX_THREADS)
			.map((t) => ({
				...t,
				messages: t.messages.slice(-MAX_MESSAGES),
			}));
		const payload: StoreFile = { schemaVersion: 1, threads: trimmed };
		await this.app.vault.adapter.write(
			this.path(),
			`${JSON.stringify(payload, null, 2)}\n`,
		);
	}

	/**
	 * List threads for notebook + mode.
	 * - feature: all for notebook (itemId ignored)
	 * - assistant: if itemId === undefined → all assistant threads in notebook
	 *              if itemId is string|null → filter that item (null = unscoped)
	 */
	async list(
		notebookId: string,
		mode: "assistant" | "feature",
		itemId?: string | null,
	): Promise<ChatThread[]> {
		const all = await this.loadAll();
		return all
			.filter((t) => {
				if (t.notebookId !== notebookId || t.mode !== mode) return false;
				if (mode === "feature") return true;
				if (itemId === undefined) return true;
				return (t.itemId ?? null) === (itemId ?? null);
			})
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async get(threadId: string): Promise<ChatThread | null> {
		const all = await this.loadAll();
		return all.find((t) => t.id === threadId) ?? null;
	}

	async create(
		notebookId: string,
		mode: "assistant" | "feature",
		opts?: {
			title?: string;
			itemId?: string | null;
			itemTitle?: string | null;
		},
	): Promise<ChatThread> {
		const now = nowIso();
		const itemId =
			mode === "feature" ? null : (opts?.itemId ?? null);
		const thread: ChatThread = {
			id: createId(),
			mode,
			notebookId,
			itemId,
			itemTitle: mode === "feature" ? null : (opts?.itemTitle ?? null),
			title:
				opts?.title?.trim() ||
				(mode === "feature" ? "改功能对话" : "新对话"),
			messages: [],
			createdAt: now,
			updatedAt: now,
		};
		const all = await this.loadAll();
		await this.saveAll([thread, ...all]);
		return thread;
	}

	async append(
		threadId: string,
		role: ChatRole,
		content: string,
		attachments?: ChatMessageAttachment[],
	): Promise<ChatThread | null> {
		const all = await this.loadAll();
		const idx = all.findIndex((t) => t.id === threadId);
		if (idx < 0) return null;
		const t = all[idx]!;
		const msg: ChatMessage = {
			id: createId(),
			role,
			content,
			createdAt: nowIso(),
			attachments:
				attachments && attachments.length > 0
					? attachments.map((a) => ({ ...a }))
					: undefined,
		};
		let title = t.title;
		if (
			role === "user" &&
			(t.messages.length === 0 ||
				t.title === "新对话" ||
				t.title === "改功能对话")
		) {
			title = content.trim().slice(0, 36) || t.title;
		}
		const next: ChatThread = {
			...t,
			title,
			messages: [...t.messages, msg],
			updatedAt: nowIso(),
		};
		const rest = all.filter((_, i) => i !== idx);
		await this.saveAll([next, ...rest]);
		return next;
	}

	async delete(threadId: string): Promise<void> {
		const all = await this.loadAll();
		await this.saveAll(all.filter((t) => t.id !== threadId));
	}

	/**
	 * Clear history.
	 * - feature / assistant without itemId filter: whole notebook+mode
	 * - assistant with itemId: only that item (null = unscoped only)
	 */
	async clearMode(
		notebookId: string,
		mode: "assistant" | "feature",
		itemId?: string | null,
	): Promise<void> {
		const all = await this.loadAll();
		await this.saveAll(
			all.filter((t) => {
				if (t.notebookId !== notebookId || t.mode !== mode) return true;
				if (mode === "feature" || itemId === undefined) return false;
				return (t.itemId ?? null) !== (itemId ?? null);
			}),
		);
	}

	/** Messages for API (role/content only, skip empty system). */
	toApiMessages(
		thread: ChatThread,
		systemPrompt?: string,
		maxTurns = 24,
	): Array<{ role: "system" | "user" | "assistant"; content: string }> {
		const out: Array<{
			role: "system" | "user" | "assistant";
			content: string;
		}> = [];
		if (systemPrompt?.trim()) {
			out.push({ role: "system", content: systemPrompt.trim() });
		}
		const recent = thread.messages
			.filter((m) => m.role === "user" || m.role === "assistant")
			.slice(-maxTurns);
		for (const m of recent) {
			out.push({
				role: m.role as "user" | "assistant",
				content: m.content,
			});
		}
		return out;
	}
}

function normalizeThread(raw: ChatThread | Record<string, unknown>): ChatThread {
	const t = raw as ChatThread;
	const messages = Array.isArray(t.messages)
		? t.messages.map((m) => {
				const att = Array.isArray(m.attachments)
					? m.attachments
							.filter((a) => a && typeof a === "object")
							.map((a) => ({
								id: String(a.id ?? ""),
								name: String(a.name ?? "file"),
								mime: String(a.mime ?? "application/octet-stream"),
								size: Number(a.size ?? 0),
								vaultPath: String(a.vaultPath ?? ""),
								kind: (["image", "video", "audio", "text", "other"].includes(
									String(a.kind),
								)
									? a.kind
									: "other") as ChatMessageAttachment["kind"],
							}))
							.filter((a) => a.vaultPath)
					: undefined;
				return {
					id: String(m.id ?? ""),
					role: m.role,
					content: String(m.content ?? ""),
					createdAt: String(m.createdAt ?? ""),
					attachments: att && att.length ? att : undefined,
				};
			})
		: [];
	return {
		id: String(t.id ?? ""),
		mode: t.mode === "feature" ? "feature" : "assistant",
		notebookId: String(t.notebookId ?? ""),
		itemId:
			t.itemId == null || t.itemId === ""
				? null
				: String(t.itemId),
		itemTitle:
			t.itemTitle == null || t.itemTitle === ""
				? null
				: String(t.itemTitle),
		title: String(t.title ?? "新对话"),
		messages,
		createdAt: String(t.createdAt ?? ""),
		updatedAt: String(t.updatedAt ?? ""),
	};
}
