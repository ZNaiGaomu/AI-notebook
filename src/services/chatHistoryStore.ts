import type { App } from "obsidian";
import { createId, nowIso } from "../domain/ids";

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
	id: string;
	role: ChatRole;
	content: string;
	createdAt: string;
};

export type ChatThread = {
	id: string;
	mode: "assistant" | "feature";
	notebookId: string;
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
const MAX_THREADS = 80;
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
			return Array.isArray(data.threads) ? data.threads : [];
		} catch {
			return [];
		}
	}

	async saveAll(threads: ChatThread[]): Promise<void> {
		const trimmed = threads
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

	async list(
		notebookId: string,
		mode: "assistant" | "feature",
	): Promise<ChatThread[]> {
		const all = await this.loadAll();
		return all
			.filter((t) => t.notebookId === notebookId && t.mode === mode)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async get(threadId: string): Promise<ChatThread | null> {
		const all = await this.loadAll();
		return all.find((t) => t.id === threadId) ?? null;
	}

	async create(
		notebookId: string,
		mode: "assistant" | "feature",
		title?: string,
	): Promise<ChatThread> {
		const now = nowIso();
		const thread: ChatThread = {
			id: createId(),
			mode,
			notebookId,
			title: title?.trim() || (mode === "feature" ? "改功能对话" : "新对话"),
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
		};
		let title = t.title;
		if (
			role === "user" &&
			(t.messages.length === 0 || t.title === "新对话" || t.title === "改功能对话")
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

	async clearMode(
		notebookId: string,
		mode: "assistant" | "feature",
	): Promise<void> {
		const all = await this.loadAll();
		await this.saveAll(
			all.filter((t) => !(t.notebookId === notebookId && t.mode === mode)),
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
