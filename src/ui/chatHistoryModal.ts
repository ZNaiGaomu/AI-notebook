import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type {
	ChatMessageAttachment,
	ChatThread,
} from "../services/chatHistoryStore";
import type AiNotebookPlugin from "../main";
import { isAbsoluteFsPath } from "../infra/folderPick";
import { readStoredBinary } from "../services/chatUploadStore";

export class ChatHistoryModal extends Modal {
	private plugin: AiNotebookPlugin;
	private notebookId: string;
	private mode: "assistant" | "feature";
	private itemId: string | null;
	private itemTitle: string | null;
	private onPick: (thread: ChatThread) => void;
	private onNew: () => void;
	private onSwitchItem?: () => void;

	constructor(
		app: App,
		plugin: AiNotebookPlugin,
		notebookId: string,
		mode: "assistant" | "feature",
		handlers: {
			onPick: (thread: ChatThread) => void;
			onNew: () => void;
			onSwitchItem?: () => void;
		},
		opts?: {
			itemId?: string | null;
			itemTitle?: string | null;
		},
	) {
		super(app);
		this.plugin = plugin;
		this.notebookId = notebookId;
		this.mode = mode;
		this.onPick = handlers.onPick;
		this.onNew = handlers.onNew;
		this.onSwitchItem = handlers.onSwitchItem;
		this.itemId = mode === "feature" ? null : (opts?.itemId ?? null);
		this.itemTitle =
			mode === "feature" ? null : (opts?.itemTitle ?? null);
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
			text:
				this.mode === "feature"
					? "改功能 · 历史对话"
					: "助手 · 历史对话",
		});

		if (this.mode === "assistant") {
			const scope = contentEl.createDiv({
				cls: "ai-notebook-chat-history-scope",
			});
			const label =
				this.itemId == null
					? "当前范围：未关联条目的对话（可切换条目）"
					: `当前条目：${this.itemTitle || this.itemId}`;
			scope.createDiv({
				cls: "setting-item-description",
				text: label,
			});
			if (this.onSwitchItem) {
				new Setting(scope).addButton((b) =>
					b.setButtonText("切换条目…").onClick(() => {
						this.close();
						this.onSwitchItem?.();
					}),
				);
			}
			contentEl.createEl("p", {
				text: "每条为时间线上的一次会话。「打开」进入对话；「附件…」查看该会话全部上传文件（可多选打开/下载）。",
				cls: "setting-item-description",
			});
		} else {
			contentEl.createEl("p", {
				text: "改功能历史按记录本保存（不按条目）。",
				cls: "setting-item-description",
			});
		}

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("新建对话")
					.setCta()
					.onClick(() => {
						this.onNew();
						this.close();
					}),
			)
			.addButton((b) =>
				b
					.setButtonText(
						this.mode === "assistant" && this.itemId != null
							? "清空本条目历史"
							: "清空本模式历史",
					)
					.setWarning()
					.onClick(async () => {
						const msg =
							this.mode === "assistant" && this.itemId != null
								? "确认清空该条目下的助手历史？"
								: "确认清空该模式下相关历史？";
						if (!confirm(msg)) return;
						if (this.mode === "assistant") {
							await this.plugin.chatHistory.clearMode(
								this.notebookId,
								"assistant",
								this.itemId,
							);
						} else {
							await this.plugin.chatHistory.clearMode(
								this.notebookId,
								"feature",
							);
						}
						new Notice("已清空");
						await this.render();
					}),
			);

		const threads =
			this.mode === "feature"
				? await this.plugin.chatHistory.list(this.notebookId, "feature")
				: await this.plugin.chatHistory.list(
						this.notebookId,
						"assistant",
						this.itemId,
					);

		if (threads.length === 0) {
			contentEl.createDiv({
				cls: "ai-notebook-empty",
				text:
					this.mode === "assistant"
						? "该条目下暂无历史。发送一条消息后会出现在这里。"
						: "暂无历史。发送一条消息后会出现在这里。",
			});
			return;
		}

		for (const t of threads) {
			const row = contentEl.createDiv({
				cls: "ai-notebook-chat-history-row",
			});
			row.createDiv({
				cls: "ai-notebook-item-title",
				text: t.title || "未命名",
			});
			const atts = collectThreadAttachments(t);
			const metaBits = [
				`${t.messages.length} 条消息`,
				atts.length ? `${atts.length} 个附件` : null,
				t.updatedAt.slice(0, 19).replace("T", " "),
			].filter(Boolean) as string[];
			if (this.mode === "assistant" && t.itemTitle) {
				metaBits.unshift(t.itemTitle);
			}
			row.createDiv({
				cls: "ai-notebook-item-meta",
				text: metaBits.join(" · "),
			});

			const actions = row.createDiv({
				cls: "ai-notebook-settings-actions",
			});
			const openBtn = actions.createEl("button", { text: "打开" });
			openBtn.addClass("mod-cta");
			openBtn.title = "进入该时间节点的对话";
			openBtn.addEventListener("click", () => {
				this.onPick(t);
				this.close();
			});

			const attBtn = actions.createEl("button", {
				text: atts.length ? `附件… (${atts.length})` : "附件…",
			});
			attBtn.disabled = atts.length === 0;
			attBtn.title =
				atts.length === 0
					? "该会话没有已存档的上传文件"
					: "查看/多选打开或下载该会话全部上传文件";
			attBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				if (!atts.length) {
					new Notice("该会话没有已存档附件");
					return;
				}
				new ThreadAttachmentsModal(this.app, this.plugin, t, atts).open();
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

/** Multi-select open / download for one chat session's uploads. */
class ThreadAttachmentsModal extends Modal {
	private selected = new Set<string>();

	constructor(
		app: App,
		private readonly plugin: AiNotebookPlugin,
		private readonly thread: ChatThread,
		private readonly attachments: ChatMessageAttachment[],
	) {
		super(app);
		// default: select all
		for (const a of attachments) {
			this.selected.add(a.vaultPath || a.id);
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "会话附件" });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `对话：${this.thread.title || "未命名"} · 共 ${this.attachments.length} 个文件。可单选/多选后打开或下载。`,
		});

		const list = contentEl.createDiv({
			cls: "ai-notebook-thread-att-list",
		});
		for (const a of this.attachments) {
			const key = a.vaultPath || a.id;
			const row = list.createDiv({
				cls: "ai-notebook-thread-att-item",
			});
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = this.selected.has(key);
			cb.addEventListener("change", () => {
				if (cb.checked) this.selected.add(key);
				else this.selected.delete(key);
			});
			const info = row.createDiv({ cls: "ai-notebook-thread-att-info" });
			info.createDiv({ text: a.name, cls: "ai-notebook-item-title" });
			info.createDiv({
				cls: "ai-notebook-item-meta",
				text: `${a.kind} · ${formatSize(a.size)} · ${a.vaultPath}`,
			});
		}

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("全选").onClick(() => {
					for (const a of this.attachments) {
						this.selected.add(a.vaultPath || a.id);
					}
					this.onOpen();
				}),
			)
			.addButton((b) =>
				b.setButtonText("全不选").onClick(() => {
					this.selected.clear();
					this.onOpen();
				}),
			)
			.addButton((b) =>
				b.setButtonText("打开所选").setCta().onClick(() => {
					void this.openSelected();
				}),
			)
			.addButton((b) =>
				b.setButtonText("下载所选").onClick(() => {
					void this.downloadSelected();
				}),
			)
			.addButton((b) =>
				b.setButtonText("关闭").onClick(() => this.close()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private chosen(): ChatMessageAttachment[] {
		return this.attachments.filter((a) =>
			this.selected.has(a.vaultPath || a.id),
		);
	}

	private async openSelected(): Promise<void> {
		const list = this.chosen();
		if (!list.length) {
			new Notice("请先勾选文件");
			return;
		}
		let n = 0;
		for (const a of list) {
			const ok = await openAttachment(this.app, this.plugin, a);
			if (ok) n++;
		}
		new Notice(n ? `已打开 ${n} 个文件` : "未能打开所选文件");
	}

	private async downloadSelected(): Promise<void> {
		const list = this.chosen();
		if (!list.length) {
			new Notice("请先勾选文件");
			return;
		}
		let n = 0;
		for (const a of list) {
			const ok = await downloadAttachment(this.app, this.plugin, a);
			if (ok) n++;
		}
		new Notice(n ? `已触发下载 ${n} 个文件` : "下载失败");
	}
}

export function collectThreadAttachments(
	t: ChatThread,
): ChatMessageAttachment[] {
	const out: ChatMessageAttachment[] = [];
	const seen = new Set<string>();
	for (const m of t.messages) {
		if (!m.attachments?.length) continue;
		for (const a of m.attachments) {
			const key = (a.vaultPath || a.id || "").replace(/\\/g, "/");
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push({ ...a, vaultPath: key });
		}
	}
	return out;
}

async function openAttachment(
	app: App,
	plugin: AiNotebookPlugin,
	a: ChatMessageAttachment,
): Promise<boolean> {
	const path = a.vaultPath.replace(/\\/g, "/");
	if (!isAbsoluteFsPath(path)) {
		const af = app.vault.getAbstractFileByPath(path);
		if (af instanceof TFile) {
			await app.workspace.getLeaf(true).openFile(af);
			return true;
		}
		// try show in file explorer
		new Notice(`库内未找到：${path}`);
		return false;
	}
	// absolute: open via shell
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { shell } = require("electron") as {
			shell: { openPath: (p: string) => Promise<string> };
		};
		const err = await shell.openPath(path.replace(/\//g, "\\"));
		if (err) {
			new Notice(`打开失败：${err}`);
			return false;
		}
		return true;
	} catch {
		// fallback download
		return downloadAttachment(app, plugin, a);
	}
}

async function downloadAttachment(
	app: App,
	plugin: AiNotebookPlugin,
	a: ChatMessageAttachment,
): Promise<boolean> {
	const path = a.vaultPath.replace(/\\/g, "/");
	try {
		let data: ArrayBuffer;
		if (isAbsoluteFsPath(path)) {
			data = await readStoredBinary(plugin.vaultIo, path);
		} else {
			data = await app.vault.adapter.readBinary(path);
		}
		const blob = new Blob([data], {
			type: a.mime || "application/octet-stream",
		});
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = a.name || "download";
		link.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 2000);
		return true;
	} catch {
		new Notice(`无法下载：${path}`);
		return false;
	}
}

function formatSize(n: number): string {
	if (!n || n < 0) return "—";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
