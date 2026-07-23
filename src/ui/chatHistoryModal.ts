import { App, Modal, Notice, Setting } from "obsidian";
import type { ChatThread } from "../services/chatHistoryStore";
import type AiNotebookPlugin from "../main";

export class ChatHistoryModal extends Modal {
	private plugin: AiNotebookPlugin;
	private notebookId: string;
	private mode: "assistant" | "feature";
	private onPick: (thread: ChatThread) => void;
	private onNew: () => void;

	constructor(
		app: App,
		plugin: AiNotebookPlugin,
		notebookId: string,
		mode: "assistant" | "feature",
		handlers: {
			onPick: (thread: ChatThread) => void;
			onNew: () => void;
		},
	) {
		super(app);
		this.plugin = plugin;
		this.notebookId = notebookId;
		this.mode = mode;
		this.onPick = handlers.onPick;
		this.onNew = handlers.onNew;
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", {
			text: this.mode === "feature" ? "改功能 · 历史对话" : "助手 · 历史对话",
		});
		contentEl.createEl("p", {
			text: "选择一条继续（带上下文），或新建对话。记录保存在库 .obsidian/ai-notebook-chat-history.json。",
			cls: "setting-item-description",
		});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("新建对话").setCta().onClick(() => {
					this.onNew();
					this.close();
				}),
			)
			.addButton((b) =>
				b.setButtonText("清空本模式历史").setWarning().onClick(async () => {
					if (!confirm("确认清空该模式下全部历史？")) return;
					await this.plugin.chatHistory.clearMode(this.notebookId, this.mode);
					new Notice("已清空");
					await this.render();
				}),
			);

		const threads = await this.plugin.chatHistory.list(
			this.notebookId,
			this.mode,
		);
		if (threads.length === 0) {
			contentEl.createDiv({
				cls: "ai-notebook-empty",
				text: "暂无历史。发送一条消息后会出现在这里。",
			});
			return;
		}

		for (const t of threads) {
			const row = contentEl.createDiv({ cls: "ai-notebook-chat-history-row" });
			row.createDiv({
				cls: "ai-notebook-item-title",
				text: t.title || "未命名",
			});
			row.createDiv({
				cls: "ai-notebook-item-meta",
				text: `${t.messages.length} 条 · ${t.updatedAt.slice(0, 19).replace("T", " ")}`,
			});
			const actions = row.createDiv({ cls: "ai-notebook-settings-actions" });
			const openBtn = actions.createEl("button", { text: "打开" });
			openBtn.addClass("mod-cta");
			openBtn.addEventListener("click", () => {
				this.onPick(t);
				this.close();
			});
			const delBtn = actions.createEl("button", { text: "删除" });
			delBtn.addEventListener("click", async () => {
				await this.plugin.chatHistory.delete(t.id);
				new Notice("已删除");
				await this.render();
			});
		}
	}
}
