import {
	ItemView,
	Notice,
	Setting,
	WorkspaceLeaf,
} from "obsidian";
import type {
	Blueprint,
	BlueprintField,
	NotebookItem,
	NotebookMeta,
} from "../domain/types";
import { formatDateTimeLocal } from "../domain/ids";
import { projectItem } from "../services/schemaMigrator";
import {
	filterItems,
	groupItemsByField,
	sortItemsByBlueprint,
	type ListFilterState,
} from "../runtime/listQuery";
import type AiNotebookPlugin from "../main";
import { VersionHistoryModal } from "./versionModal";
import { DiffConfirmModal } from "./diffConfirmModal";
import { assertBlueprint } from "../domain/blueprintSchema";
import { VoiceRecordModal } from "./voiceRecordModal";
import { ChatHistoryModal } from "./chatHistoryModal";
import { PickNotebookModal } from "./pickNotebookModal";
import { CreateNotebookModal } from "./createNotebookModal";
import type { ChatThread } from "../services/chatHistoryStore";
import { AddCabinetLinkModal } from "./addCabinetLinkModal";
import {
	VaultFileSuggestModal,
	pickLocalFiles,
} from "./vaultFilePickers";

export const VIEW_TYPE_AI_NOTEBOOK = "ai-notebook-view";

export class NotebookView extends ItemView {
	plugin: AiNotebookPlugin;
	private notebookId: string | null = null;
	private meta: NotebookMeta | null = null;
	private blueprint: Blueprint | null = null;
	private items: NotebookItem[] = [];
	private activeItem: NotebookItem | null = null;
	private chatMode: "assistant" | "feature" = "assistant";
	private leftTab: "items" | "cabinet" | "inbox" = "items";
	/** list | table | board — from blueprint.views, user-switchable */
	private itemViewMode: "list" | "table" | "board" = "list";
	private listFilters: ListFilterState = {};
	private viewModeInitialized = false;
	private assistantThread: ChatThread | null = null;
	private featureThread: ChatThread | null = null;
	private chatBusy = false;

	constructor(leaf: WorkspaceLeaf, plugin: AiNotebookPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_AI_NOTEBOOK;
	}

	getDisplayText(): string {
		return this.meta?.name ?? "AI 记录本";
	}

	getIcon(): string {
		return "notebook-pen";
	}

	async setNotebookId(id: string): Promise<void> {
		this.notebookId = id;
		this.viewModeInitialized = false;
		this.listFilters = {};
		await this.reload();
	}

	async onOpen(): Promise<void> {
		await this.reload();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	async reload(): Promise<void> {
		if (!this.notebookId) {
			this.renderEmpty("未选择记录本");
			return;
		}
		try {
			const meta = await this.plugin.notebooks.findById(this.notebookId);
			if (!meta) {
				this.renderEmpty("找不到该记录本");
				return;
			}
			this.meta = meta;
			const { blueprint } = await this.plugin.versions.loadCurrentBlueprint(
				meta.folderName,
			);
			this.blueprint = blueprint;
			this.plugin.runtime.load(blueprint);
			if (!this.viewModeInitialized) {
				this.itemViewMode = this.plugin.runtime.defaultItemViewMode();
				this.viewModeInitialized = true;
			}
			this.items = await this.plugin.items.listItems(meta);
			if (this.activeItem) {
				this.activeItem =
					this.items.find(
						(i) => i.frontmatter.item_id === this.activeItem?.frontmatter.item_id,
					) ?? null;
			}
			this.render();
		} catch (e) {
			this.renderEmpty(
				`加载失败: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	private renderEmpty(msg: string): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("ai-notebook-view");
		el.createDiv({ cls: "ai-notebook-empty", text: msg });
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("ai-notebook-view");
		if (!this.meta || !this.blueprint) return;

		const toolbar = el.createDiv({ cls: "ai-notebook-toolbar" });
		toolbar.createEl("h2", { text: this.meta.name });
		toolbar.createSpan({
			cls: "ai-notebook-mode-badge",
			text: `功能 v${this.meta.current_blueprint}`,
		});


		const switchBtn = toolbar.createEl("button", { text: "切换记录本" });
		switchBtn.addEventListener("click", () => {
			void new PickNotebookModal(this.app, this.plugin).openAndLoad();
		});

		const newNbBtn = toolbar.createEl("button", { text: "新建记录本" });
		newNbBtn.addEventListener("click", () => {
			new CreateNotebookModal(this.app, this.plugin, () => undefined).open();
		});

		const captureBtn = toolbar.createEl("button", { text: "快速捕获" });
		captureBtn.addEventListener("click", () => void this.quickCapture());

		const refreshBtn = toolbar.createEl("button", { text: "刷新" });
		refreshBtn.addEventListener("click", () => void this.reload());

		const versionBtn = toolbar.createEl("button", { text: "历史版本" });
		versionBtn.addEventListener("click", () => void this.openVersions());

		const commitBtn = toolbar.createEl("button", { text: "另存蓝图版本" });
		commitBtn.addEventListener("click", () => void this.commitCurrentBlueprint());

		const voiceBtn = toolbar.createEl("button", { text: "语音录入" });
		voiceBtn.addEventListener("click", () => void this.voiceCapture());

		const organizeBtn = toolbar.createEl("button", { text: "AI整理条目" });
		organizeBtn.addEventListener("click", () => void this.reorganizeActiveItem());

		const inboxBtn = toolbar.createEl("button", { text: "处理收件箱" });
		inboxBtn.addEventListener("click", () => void this.processInbox());

		const body = el.createDiv({ cls: "ai-notebook-body" });
		const listPane = body.createDiv({ cls: "ai-notebook-list-pane" });
		const detailPane = body.createDiv({ cls: "ai-notebook-detail-pane" });

		const tabBar = listPane.createDiv({ cls: "ai-notebook-tab-bar" });
		const itemsTab = tabBar.createEl("button", { text: "条目" });
		const cabTab = tabBar.createEl("button", { text: "收藏柜" });
		const inboxTab = tabBar.createEl("button", { text: "收件箱" });
		itemsTab.toggleClass("mod-cta", this.leftTab === "items");
		cabTab.toggleClass("mod-cta", this.leftTab === "cabinet");
		inboxTab.toggleClass("mod-cta", this.leftTab === "inbox");
		itemsTab.addEventListener("click", () => {
			this.leftTab = "items";
			this.render();
		});
		cabTab.addEventListener("click", () => {
			this.leftTab = "cabinet";
			void this.renderCabinet(listPane, detailPane);
		});
		inboxTab.addEventListener("click", () => {
			this.leftTab = "inbox";
			void this.renderInbox(listPane, detailPane);
		});

		if (this.leftTab === "cabinet") {
			void this.renderCabinet(listPane, detailPane);
		} else if (this.leftTab === "inbox") {
			void this.renderInbox(listPane, detailPane);
		} else {
			this.renderItemsPane(listPane);
			this.renderDetail(detailPane);
		}


		const chat = el.createDiv({ cls: "ai-notebook-chat-panel" });
		const modeBar = chat.createDiv({ cls: "ai-notebook-chat-modebar" });
		const assistantBtn = modeBar.createEl("button", { text: "助手" });
		const featureBtn = modeBar.createEl("button", { text: "改功能" });
		const historyBtn = modeBar.createEl("button", { text: "历史" });
		const newChatBtn = modeBar.createEl("button", { text: "新对话" });

		const threadTitle = chat.createDiv({ cls: "ai-notebook-chat-thread-title" });
		const messagesEl = chat.createDiv({ cls: "ai-notebook-chat-messages" });
		const hint = chat.createDiv({ cls: "ai-notebook-chat-hint" });
		const inputRow = chat.createDiv({ cls: "ai-notebook-chat-input-row" });
		const ta = inputRow.createEl("textarea");
		ta.rows = 2;
		ta.placeholder =
			this.chatMode === "feature"
				? this.blueprint?.ui.featureEditPrompt ??
					"描述你想如何改这个记录本的功能…"
				: this.blueprint?.ui.homePrompt ?? "向助手提问…";
		const sendBtn = inputRow.createEl("button", { text: "发送" });
		sendBtn.addClass("mod-cta");

		const paintMessages = () => {
			const thread =
				this.chatMode === "feature"
					? this.featureThread
					: this.assistantThread;
			threadTitle.setText(
				thread
					? `对话：${thread.title}（${thread.messages.length} 条上下文）`
					: "对话：新会话（发送后自动创建并保留上下文）",
			);
			messagesEl.empty();
			if (!thread || thread.messages.length === 0) {
				messagesEl.createDiv({
					cls: "ai-notebook-empty",
					text:
						this.chatMode === "feature"
							? "改功能对话上下文会出现在这里。可打开「历史」继续旧会话。"
							: "助手对话上下文会出现在这里。支持多轮；「历史」可管理记录。",
				});
			} else {
				for (const m of thread.messages) {
					const bubble = messagesEl.createDiv({
						cls:
							m.role === "user"
								? "ai-notebook-chat-bubble user"
								: m.role === "assistant"
									? "ai-notebook-chat-bubble assistant"
									: "ai-notebook-chat-bubble system",
					});
					bubble.createDiv({
						cls: "ai-notebook-chat-bubble-role",
						text:
							m.role === "user"
								? "你"
								: m.role === "assistant"
									? "AI"
									: "系统",
					});
					bubble.createDiv({
						cls: "ai-notebook-chat-bubble-body",
						text: m.content,
					});
				}
				messagesEl.scrollTop = messagesEl.scrollHeight;
			}
		};

		const setMode = (mode: "assistant" | "feature") => {
			this.chatMode = mode;
			assistantBtn.toggleClass("mod-cta", mode === "assistant");
			featureBtn.toggleClass("mod-cta", mode === "feature");
			hint.setText(
				mode === "assistant"
					? "助手模式：多轮上下文会带给模型。需配置 Provider。"
					: "改功能模式：多轮上下文仅作参考；应用变更仍需 Diff 确认。",
			);
			ta.placeholder =
				mode === "feature"
					? this.blueprint?.ui.featureEditPrompt ??
						"描述你想如何改这个记录本的功能…"
					: this.blueprint?.ui.homePrompt ?? "向助手提问…";
			paintMessages();
		};

		sendBtn.addEventListener("click", () => {
			const text = ta.value.trim();
			if (!text || this.chatBusy) return;
			void this.handleChatSend(text).then(() => {
				ta.value = "";
				paintMessages();
			});
		});
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				sendBtn.click();
			}
		});
		assistantBtn.addEventListener("click", () => setMode("assistant"));
		featureBtn.addEventListener("click", () => setMode("feature"));
		historyBtn.addEventListener("click", () => {
			if (!this.meta) return;
			new ChatHistoryModal(
				this.app,
				this.plugin,
				this.meta.notebook_id,
				this.chatMode,
				{
					onPick: (t) => {
						if (this.chatMode === "feature") this.featureThread = t;
						else this.assistantThread = t;
						paintMessages();
					},
					onNew: () => {
						if (this.chatMode === "feature") this.featureThread = null;
						else this.assistantThread = null;
						paintMessages();
					},
				},
			).open();
		});
		newChatBtn.addEventListener("click", () => {
			if (this.chatMode === "feature") this.featureThread = null;
			else this.assistantThread = null;
			paintMessages();
			new Notice("已开始新对话");
		});
		setMode(this.chatMode);
	}


	async voiceCapturePublic(): Promise<void> {
		await this.voiceCapture();
	}

	private async voiceCapture(): Promise<void> {
		if (!this.meta) {
			new Notice("未打开记录本");
			return;
		}
		const resolved =
			this.plugin.resolveAi("voice", this.meta) ||
			this.plugin.resolveAi("worker", this.meta) ||
			this.plugin.resolveAi("planner", this.meta);
		if (!resolved) {
			new Notice("请先配置 AI Provider（语音转写需要 API）");
			return;
		}
		await this.recordAndTranscribe(resolved.profile, resolved.model);
	}


	private async recordAndTranscribe(
		profile: import("../domain/types").ProviderProfile,
		model: string,
	): Promise<void> {
		if (!this.meta) return;
		const modal = new VoiceRecordModal(this.app);
		const recorded = await modal.waitForResult();
		if (!recorded.ok) {
			if (recorded.cancelled) return;
			if (recorded.error.startsWith("TEXT_FALLBACK:")) {
				const text = recorded.error.slice("TEXT_FALLBACK:".length);
				await this.createFromTranscript(text, { sourceLabel: "文字补充" });
				return;
			}
			const text = window.prompt(
				`录音不可用：${recorded.error}\n\n可改为输入/粘贴文字：`,
			);
			if (!text?.trim()) return;
			await this.createFromTranscript(text.trim(), { sourceLabel: "文字补充" });
			return;
		}

		new Notice(
			`录音完成 ${Math.round(recorded.blob.size / 1024)}KB：先存音频文件，再转写…`,
		);

		// New pipeline: save file → whisper STT → chat model listens to audio
		const pipe = await this.plugin.voicePipeline.process(
			this.meta,
			recorded.blob,
			recorded.filename || "audio.wav",
		);

		if (pipe.ok && pipe.transcript.trim()) {
			const methodLabel =
				pipe.method === "whisper"
					? "Whisper 转写"
					: pipe.method === "chat-audio"
						? "对话模型听音频"
						: "转写";
			const body = `${pipe.transcript.trim()}${pipe.embedMarkdown}`;
			await this.createFromTranscript(body, {
				sourceLabel: "voice",
				title:
					pipe.transcript.trim().split(/\n/)[0]?.slice(0, 40) ||
					`语音 ${new Date().toLocaleString()}`,
			});
			new Notice(`已保存笔记（${methodLabel}）`);
			return;
		}

		// Failed STT but audio is on disk — still create note with player embed
		const draft = [
			"【语音已保存；自动转写未成功】",
			"",
			pipe.error || "未知错误",
			"",
			"说明：",
			"- 录音文件已写入附件目录，下方可直接播放。",
			"- 当前中转若无 whisper 渠道，可：①另配支持 /audio/transcriptions 的服务商并绑定「语音转写」；",
			"  ②或使用支持「听音频」的多模态对话模型（插件会把音频发给对话接口尝试转写）。",
			"",
			"（也可手动把听到的内容写在本段下方）",
			pipe.embedMarkdown,
		].join("\n");
		await this.createFromTranscript(draft, {
			title: `语音 ${new Date().toLocaleString()}`,
			skipAi: true,
			sourceLabel: "voice-audio-only",
		});
		new Notice(
			pipe.vaultPath
				? `音频已保存；转写失败：${(pipe.error || "").slice(0, 60)}`
				: `处理失败：${pipe.error}`,
		);
	}

	private async createFromTranscript(
		text: string,
		opts?: { title?: string; skipAi?: boolean; sourceLabel?: string },
	): Promise<void> {
		if (!this.meta) {
			new Notice("未打开记录本，无法保存");
			return;
		}
		if (!this.blueprint) {
			try {
				const { blueprint } = await this.plugin.versions.loadCurrentBlueprint(
					this.meta.folderName,
				);
				this.blueprint = blueprint;
				this.plugin.runtime.load(blueprint);
			} catch (e) {
				new Notice(
					`加载蓝图失败: ${e instanceof Error ? e.message : String(e)}`,
				);
				return;
			}
		}

		try {
			await this.plugin.inbox.saveVoiceRaw(text);
		} catch {
			// optional
		}

		const useAi =
			!opts?.skipAi && this.plugin.settings.inbox.autoOrganizeVoice;
		new Notice(useAi ? "转写完成，AI 整理并保存…" : "正在保存笔记…");

		try {
			const title =
				opts?.title ||
				text
					.trim()
					.split(/\n/)
					.find((l) => l.trim() && !l.startsWith("【"))
					?.slice(0, 40) ||
				`语音 ${new Date().toLocaleString()}`;

			const captured = await this.plugin.organize.captureStructured(
				this.meta,
				text,
				{
					useAi,
					source: opts?.sourceLabel || "voice",
					sourceHint: "语音转写",
					entityType: this.plugin.runtime.primaryEntityId() ?? undefined,
				},
			);

			if (opts?.title && captured.item.frontmatter.title !== opts.title) {
				this.activeItem = await this.plugin.items.updateItem(captured.item, {
					title: opts.title,
				});
			} else {
				this.activeItem = captured.item;
			}

			if (captured.error) {
				new Notice(`已保存笔记；AI 整理跳过/失败: ${captured.error}`);
			} else {
				new Notice(
					captured.organized ? "已转写并整理成笔记" : "已转写并保存为笔记",
				);
			}
			this.leftTab = "items";
			await this.reload();
		} catch (e) {
			try {
				const item = await this.plugin.items.createItem(this.meta, {
					title: opts?.title || "语音记录",
					body: text,
					entityType: this.plugin.runtime.primaryEntityId() ?? undefined,
					fields: { source: "voice" },
				});
				if (this.blueprint) {
					const hooked = await this.plugin.hooks.runOnCreate({
						meta: this.meta,
						item,
						blueprint: this.blueprint,
					});
					this.activeItem = hooked.item;
				} else {
					this.activeItem = item;
				}
				new Notice(
					`已强制保存笔记（整理异常: ${e instanceof Error ? e.message : String(e)}）`,
				);
				this.leftTab = "items";
				await this.reload();
			} catch (e2) {
				new Notice(
					`保存失败: ${e2 instanceof Error ? e2.message : String(e2)}`,
				);
			}
		}
	}

	async reorganizeActiveItem(): Promise<void> {
		if (!this.meta || !this.activeItem) {
			new Notice("请先选中一条目");
			return;
		}
		new Notice("AI 整理中…");
		const result = await this.plugin.organize.reorganizeItem(
			this.meta,
			this.activeItem,
		);
		if ("error" in result) {
			new Notice(`整理失败: ${result.error}`);
			return;
		}
		this.activeItem = result.item;
		new Notice("已重新结构化");
		await this.reload();
	}

	private async processInbox(): Promise<void> {
		new Notice("正在处理收件箱…");
		const result = await this.plugin.inbox.processAll({ useAi: true });
		if (result.ok === 0 && result.fail === 0) {
			new Notice("收件箱为空（可把手机笔记放到 AI Inbox/pending）");
			return;
		}
		new Notice(`收件箱：成功 ${result.ok}，失败 ${result.fail}`);
		this.leftTab = "items";
		await this.reload();
	}

	private async renderInbox(
		listPane: HTMLElement,
		detailPane: HTMLElement,
	): Promise<void> {
		const tabBar = listPane.querySelector(".ai-notebook-tab-bar");
		listPane.empty();
		if (tabBar) listPane.appendChild(tabBar);

		const actions = listPane.createDiv({ cls: "ai-notebook-settings-actions" });
		const dumpBtn = actions.createEl("button", { text: "写入一条速记" });
		dumpBtn.addEventListener("click", async () => {
			const text = window.prompt("杂乱信息（写入收件箱 pending）");
			if (!text?.trim()) return;
			await this.plugin.inbox.dumpRaw({ text: text.trim(), source: "paste" });
			new Notice("已写入收件箱");
			await this.renderInbox(listPane, detailPane);
		});
		const procBtn = actions.createEl("button", { text: "全部 AI 整理" });
		procBtn.addClass("mod-cta");
		procBtn.addEventListener("click", () => void this.processInbox());

		const pending = await this.plugin.inbox.listPending();
		if (pending.length === 0) {
			listPane.createDiv({
				cls: "ai-notebook-empty",
				text: "收件箱为空。手机请把笔记存到 AI Inbox/pending，或点「写入一条速记」。",
			});
		}
		for (const p of pending) {
			const row = listPane.createDiv({ cls: "ai-notebook-item-row" });
			row.createDiv({ cls: "ai-notebook-item-title", text: p.title });
			row.createDiv({
				cls: "ai-notebook-item-meta",
				text: `${p.source} · ${p.preview}`,
			});
			row.addEventListener("click", () => {
				this.renderInboxDetail(detailPane, p.path, p.title, p.preview);
			});
		}

		detailPane.empty();
		detailPane.createDiv({
			cls: "ai-notebook-empty",
			text: "选择收件项查看 / 单独处理。链路：手机 → pending → AI → 记录本。",
		});
	}

	private renderInboxDetail(
		pane: HTMLElement,
		path: string,
		title: string,
		preview: string,
	): void {
		pane.empty();
		pane.createEl("h3", { text: title });
		pane.createEl("p", { text: path, cls: "setting-item-description" });
		pane.createEl("pre", { text: preview });
		new Setting(pane).addButton((b) =>
			b.setButtonText("AI 整理到本记录本").setCta().onClick(async () => {
				if (!this.meta) return;
				new Notice("整理中…");
				const r = await this.plugin.inbox.processOne(path, {
					notebook: this.meta,
					useAi: true,
				});
				if (!r.ok) {
					new Notice(r.error);
					return;
				}
				new Notice(
					r.organized
						? `已结构化 → ${r.notebookName}`
						: `已入库（未结构化）→ ${r.notebookName}`,
				);
				this.leftTab = "items";
				await this.reload();
			}),
		);
	}

	/** Public: command palette entry for feature edit. */
	async runFeatureEditPrompt(): Promise<void> {
		this.chatMode = "feature";
		const text = window.prompt(
			"描述你想如何修改本记录本的功能：",
			"加一个状态字段，选项 to-read / reading / done",
		);
		if (text == null || !text.trim()) return;
		await this.handleChatSend(text.trim());
	}


	private async ensureThread(): Promise<ChatThread> {
		if (!this.meta) throw new Error("无记录本");
		if (this.chatMode === "feature") {
			if (!this.featureThread) {
				this.featureThread = await this.plugin.chatHistory.create(
					this.meta.notebook_id,
					"feature",
				);
			}
			return this.featureThread;
		}
		if (!this.assistantThread) {
			this.assistantThread = await this.plugin.chatHistory.create(
				this.meta.notebook_id,
				"assistant",
			);
		}
		return this.assistantThread;
	}

	private async handleChatSend(text: string): Promise<void> {
		if (this.chatBusy) return;
		this.chatBusy = true;
		try {
			if (this.chatMode === "feature") {
				await this.runFeatureEdit(text);
			} else {
				await this.runAssistantChat(text);
			}
		} finally {
			this.chatBusy = false;
			this.render();
		}
	}

	private async runFeatureEdit(instruction: string): Promise<void> {
		if (!this.meta) {
			new Notice("未打开记录本");
			return;
		}
		const thread = await this.ensureThread();
		await this.plugin.chatHistory.append(thread.id, "user", instruction);
		this.featureThread = (await this.plugin.chatHistory.get(thread.id)) ?? thread;

		new Notice("正在让 AI 生成功能变更方案…");
		const notebook = this.meta;
		const resolved = this.plugin.resolveAi("planner", notebook);
		if (!resolved) {
			const err = "请先在设置中配置 AI Provider（URL + Key + 模型）";
			await this.plugin.chatHistory.append(thread.id, "assistant", err);
			this.featureThread = await this.plugin.chatHistory.get(thread.id);
			new Notice(err);
			return;
		}
		const result = await this.plugin.features.propose(
			notebook.folderName,
			instruction,
		);
		if (!result.ok) {
			await this.plugin.chatHistory.append(
				thread.id,
				"assistant",
				`失败：${result.error}`,
			);
			this.featureThread = await this.plugin.chatHistory.get(thread.id);
			new Notice(result.error);
			return;
		}
		const { plan } = result;
		const summary = [
			`摘要：${plan.changeSummary}`,
			"",
			"变更 Diff：",
			...plan.diff.map((d) => `${d.kind}: ${d.text}`),
		].join("\n");
		await this.plugin.chatHistory.append(thread.id, "assistant", summary);
		this.featureThread = await this.plugin.chatHistory.get(thread.id);

		const lines = [
			{ kind: "info" as const, text: `摘要: ${plan.changeSummary}` },
			...plan.diff,
		];
		const modal = new DiffConfirmModal(
			this.app,
			"确认应用 AI 功能变更？",
			lines,
		);
		const ok = await modal.waitForConfirm();
		if (!ok) {
			await this.plugin.chatHistory.append(
				thread.id,
				"system",
				"用户取消了本次功能变更。",
			);
			this.featureThread = await this.plugin.chatHistory.get(thread.id);
			new Notice("已取消功能变更");
			return;
		}
		try {
			const { version } = await this.plugin.features.apply(
				notebook.folderName,
				notebook.notebook_id,
				plan,
				instruction,
			);
			this.meta = await this.plugin.notebooks.touchCurrentBlueprint(
				notebook,
				version,
			);
			await this.plugin.chatHistory.append(
				thread.id,
				"system",
				`已应用功能版本 v${version}`,
			);
			this.featureThread = await this.plugin.chatHistory.get(thread.id);
			new Notice(`功能已更新为 v${version}：${plan.changeSummary}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			await this.plugin.chatHistory.append(
				thread.id,
				"assistant",
				`应用失败：${msg}`,
			);
			this.featureThread = await this.plugin.chatHistory.get(thread.id);
			new Notice(`应用失败: ${msg}`);
		}
	}

	private async runAssistantChat(text: string): Promise<void> {
		if (!this.meta || !this.blueprint) {
			new Notice("未打开记录本");
			return;
		}
		const thread = await this.ensureThread();
		await this.plugin.chatHistory.append(thread.id, "user", text);
		this.assistantThread = (await this.plugin.chatHistory.get(thread.id)) ?? thread;

		const resolved = this.plugin.resolveAi("worker", this.meta);
		if (!resolved) {
			const err = "请先在设置中配置 AI Provider";
			await this.plugin.chatHistory.append(thread.id, "assistant", err);
			this.assistantThread = await this.plugin.chatHistory.get(thread.id);
			new Notice(err);
			return;
		}

		const ctxItem = this.activeItem
			? JSON.stringify(
					{
						title: this.activeItem.frontmatter.title,
						fields: this.activeItem.frontmatter,
						body: this.activeItem.body.slice(0, 2000),
					},
					null,
					2,
				)
			: "(无选中条目)";

		const system = [
			this.blueprint.aiBehaviors.systemHints,
			"你是记录本助手。简洁中文回答。不要输出可执行代码去改系统。",
			`记录本: ${this.meta.name}`,
			`实体字段定义: ${JSON.stringify(this.blueprint.entityTypes)}`,
			`当前选中条目: ${ctxItem}`,
		].join("\n");

		const history = this.plugin.chatHistory.toApiMessages(
			this.assistantThread!,
			system,
			20,
		);
		new Notice("助手思考中…");
		const result = await this.plugin.gateway.chat(
			resolved.profile,
			resolved.model,
			history,
			{ maxTokens: 1024, temperature: 0.4 },
		);
		if (!result.ok) {
			const err = `助手失败: ${result.error}`;
			await this.plugin.chatHistory.append(thread.id, "assistant", err);
			this.assistantThread = await this.plugin.chatHistory.get(thread.id);
			new Notice(err);
			return;
		}
		await this.plugin.chatHistory.append(thread.id, "assistant", result.content);
		this.assistantThread = await this.plugin.chatHistory.get(thread.id);
		new Notice("助手已回复（见下方对话区）");
	}

	private renderDetail(pane: HTMLElement): void {
		pane.empty();
		if (!this.activeItem || !this.blueprint || !this.meta) {
			pane.createDiv({
				cls: "ai-notebook-empty",
				text: "选择左侧条目查看详情",
			});
			return;
		}

		const item = this.activeItem;
		const projected = projectItem(item.frontmatter, this.blueprint);
		const fields = projected.fields;

		pane.createEl("h3", { text: "详情" });

		// title
		this.renderFieldEditor(pane, {
			id: "title",
			label: "标题",
			type: "text",
			required: true,
		}, String(item.frontmatter.title ?? ""), (v) => {
			void this.saveField({ title: String(v) });
		});

		for (const field of fields) {
			if (field.id === "title") continue;
			if (field.type === "markdown" && field.id === "body") {
				this.renderFieldEditor(
					pane,
					field,
					item.body,
					(v) => void this.saveField({ body: String(v) }),
				);
				continue;
			}
			if (field.type === "markdown" && field.id === "notes") {
				// prefer body if notes empty? keep in fm for literature template
			}
			const value = item.frontmatter[field.id];
			if (field.type === "markdown") {
				this.renderFieldEditor(
					pane,
					field,
					value != null ? String(value) : "",
					(v) => void this.saveField({ fields: { [field.id]: String(v) } }),
				);
			} else {
				this.renderFieldEditor(
					pane,
					field,
					value,
					(v) => void this.saveField({ fields: { [field.id]: v } }),
				);
			}
		}

		// body always editable as note content if no body field
		const hasBodyField = fields.some((f) => f.id === "body");
		if (!hasBodyField) {
			this.renderFieldEditor(
				pane,
				{ id: "_body", label: "正文", type: "markdown" },
				item.body,
				(v) => void this.saveField({ body: String(v) }),
			);
		}

		if (Object.keys(projected.unmapped).length > 0) {
			const details = pane.createEl("details", { cls: "ai-notebook-unmapped" });
			details.createEl("summary", { text: "扩展 / 未映射字段（回滚后仍保留）" });
			const pre = details.createEl("pre");
			pre.textContent = JSON.stringify(projected.unmapped, null, 2);
		}

		new Setting(pane).addButton((b) =>
			b.setButtonText("删除（进回收站）").setWarning().onClick(async () => {
				if (!this.meta || !this.activeItem) return;
				const ok = confirm("确认软删除该条目？可在 .trash 中找回文件。");
				if (!ok) return;
				await this.plugin.items.softDelete(this.meta, this.activeItem);
				this.activeItem = null;
				new Notice("已移入回收站");
				await this.reload();
			}),
		);
	}

	private renderFieldEditor(
		parent: HTMLElement,
		field: BlueprintField,
		value: unknown,
		onCommit: (value: unknown) => void,
	): void {
		const wrap = parent.createDiv({ cls: "ai-notebook-field" });
		wrap.createEl("label", { text: field.label });

		if (field.type === "select" && field.options) {
			const sel = wrap.createEl("select");
			for (const opt of field.options) {
				const o = sel.createEl("option", { text: opt, value: opt });
				if (String(value ?? "") === opt) o.selected = true;
			}
			if (!field.options.includes(String(value ?? "")) && value != null && value !== "") {
				sel.createEl("option", {
					text: String(value),
					value: String(value),
					attr: { selected: "true" },
				});
			}
			sel.addEventListener("change", () => onCommit(sel.value));
			return;
		}

		if (field.type === "checkbox") {
			const input = wrap.createEl("input", { type: "checkbox" });
			input.checked = Boolean(value);
			input.addEventListener("change", () => onCommit(input.checked));
			return;
		}

		if (field.type === "markdown") {
			const ta = wrap.createEl("textarea");
			ta.value = value != null ? String(value) : "";
			ta.addEventListener("blur", () => onCommit(ta.value));
			return;
		}

		if (field.type === "tags" || field.type === "multi-select") {
			const input = wrap.createEl("input", { type: "text" });
			input.placeholder = "逗号分隔";
			input.value = Array.isArray(value)
				? value.join(", ")
				: value != null
					? String(value)
					: "";
			input.addEventListener("blur", () => {
				const arr = input.value
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				onCommit(arr);
			});
			return;
		}

		const input = wrap.createEl("input", {
			type: field.type === "number" ? "number" : field.type === "date" ? "date" : "text",
		});
		input.value = value != null ? String(value) : "";
		input.addEventListener("blur", () => {
			if (field.type === "number") {
				onCommit(input.value === "" ? 0 : Number(input.value));
			} else {
				onCommit(input.value);
			}
		});
	}

	private async saveField(patch: {
		title?: string;
		fields?: Record<string, unknown>;
		body?: string;
	}): Promise<void> {
		if (!this.activeItem) return;
		try {
			this.activeItem = await this.plugin.items.updateItem(
				this.activeItem,
				patch,
			);
			// refresh list titles without full flicker when possible
			await this.reload();
		} catch (e) {
			new Notice(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private visibleItems(): NotebookItem[] {
		if (!this.blueprint) return this.items;
		const entityId =
			this.plugin.runtime.primaryEntityId() ??
			this.items[0]?.frontmatter.entity_type;
		const sorted = sortItemsByBlueprint(
			this.items,
			this.blueprint,
			entityId ?? undefined,
		);
		return filterItems(
			sorted,
			this.blueprint,
			entityId ?? undefined,
			this.listFilters,
		);
	}

	private renderItemsPane(listPane: HTMLElement): void {
		if (!this.blueprint) return;
		const entityId = this.plugin.runtime.primaryEntityId() ?? undefined;
		const modes = this.plugin.runtime.availableItemViewModes();

		const controls = listPane.createDiv({ cls: "ai-notebook-list-controls" });
		const modeBar = controls.createDiv({ cls: "ai-notebook-view-mode-bar" });
		const labels: Record<"list" | "table" | "board", string> = {
			list: "列表",
			table: "表格",
			board: "看板",
		};
		for (const mode of modes) {
			const btn = modeBar.createEl("button", { text: labels[mode] });
			btn.toggleClass("mod-cta", this.itemViewMode === mode);
			btn.addEventListener("click", () => {
				this.itemViewMode = mode;
				this.render();
			});
		}

		const filterFields = this.plugin.runtime.filterFields(entityId);
		if (filterFields.length > 0) {
			const filterRow = controls.createDiv({ cls: "ai-notebook-filter-row" });
			for (const field of filterFields) {
				const wrap = filterRow.createDiv({ cls: "ai-notebook-filter-field" });
				wrap.createEl("label", { text: field.label });
				if (field.type === "select" && field.options?.length) {
					const sel = wrap.createEl("select");
					sel.createEl("option", { text: "全部", value: "" });
					for (const opt of field.options) {
						const o = sel.createEl("option", { text: opt, value: opt });
						if ((this.listFilters[field.id] ?? "") === opt) o.selected = true;
					}
					sel.addEventListener("change", () => {
						this.listFilters = {
							...this.listFilters,
							[field.id]: sel.value,
						};
						this.render();
					});
				} else {
					const input = wrap.createEl("input", { type: "text" });
					input.placeholder = "筛选…";
					input.value = this.listFilters[field.id] ?? "";
					input.addEventListener("change", () => {
						this.listFilters = {
							...this.listFilters,
							[field.id]: input.value.trim(),
						};
						this.render();
					});
				}
			}
			const clearBtn = filterRow.createEl("button", { text: "清除筛选" });
			clearBtn.addEventListener("click", () => {
				this.listFilters = {};
				this.render();
			});
		}

		const visible = this.visibleItems();
		if (this.items.length === 0) {
			listPane.createDiv({
				cls: "ai-notebook-empty",
				text: "暂无条目，点击「快速捕获」开始。",
			});
			return;
		}
		if (visible.length === 0) {
			listPane.createDiv({
				cls: "ai-notebook-empty",
				text: "无匹配条目（试试清除筛选）。",
			});
			return;
		}

		if (this.itemViewMode === "table") {
			this.renderTableView(listPane, visible, entityId);
			return;
		}
		if (this.itemViewMode === "board") {
			this.renderBoardView(listPane, visible, entityId);
			return;
		}
		this.renderListView(listPane, visible);
	}

	private renderListView(listPane: HTMLElement, items: NotebookItem[]): void {
		for (const item of items) {
			const row = listPane.createDiv({ cls: "ai-notebook-item-row" });
			if (this.activeItem?.frontmatter.item_id === item.frontmatter.item_id) {
				row.addClass("is-active");
			}
			row.createDiv({
				cls: "ai-notebook-item-title",
				text: item.frontmatter.title || "未命名",
			});
			const cols = this.plugin.runtime.listColumns(item.frontmatter.entity_type);
			const extras = cols
				.filter((f) => f.id !== "title")
				.map((f) => `${f.label}: ${formatCell(item.frontmatter[f.id])}`)
				.slice(0, 2)
				.join(" · ");
			const timeLabel = formatItemTime(item);
			row.createDiv({
				cls: "ai-notebook-item-meta",
				text: [timeLabel, extras].filter(Boolean).join(" · "),
			});
			row.addEventListener("click", () => {
				this.activeItem = item;
				this.render();
			});
		}
	}

	private renderTableView(
		listPane: HTMLElement,
		items: NotebookItem[],
		entityId?: string,
	): void {
		const cols = this.plugin.runtime.listColumns(entityId);
		const table = listPane.createEl("table", { cls: "ai-notebook-table" });
		const thead = table.createEl("thead");
		const hr = thead.createEl("tr");
		hr.createEl("th", { text: "时间" });
		hr.createEl("th", { text: "标题" });
		for (const f of cols) {
			if (f.id === "title") continue;
			hr.createEl("th", { text: f.label });
		}
		const tbody = table.createEl("tbody");
		for (const item of items) {
			const tr = tbody.createEl("tr");
			if (this.activeItem?.frontmatter.item_id === item.frontmatter.item_id) {
				tr.addClass("is-active");
			}
			tr.createEl("td", { text: formatItemTime(item) });
			tr.createEl("td", { text: item.frontmatter.title || "未命名" });
			for (const f of cols) {
				if (f.id === "title") continue;
				tr.createEl("td", { text: formatCell(item.frontmatter[f.id]) });
			}
			tr.addEventListener("click", () => {
				this.activeItem = item;
				this.render();
			});
		}
	}

	private renderBoardView(
		listPane: HTMLElement,
		items: NotebookItem[],
		entityId?: string,
	): void {
		const colField = this.plugin.runtime.boardColumn(entityId);
		if (!colField) {
			listPane.createDiv({
				cls: "ai-notebook-empty",
				text: "当前蓝图无 select 字段，看板不可用；请切换列表/表格。",
			});
			this.renderListView(listPane, items);
			return;
		}
		const board = listPane.createDiv({ cls: "ai-notebook-board" });
		const groups = groupItemsByField(items, colField.id, colField.options);
		for (const g of groups) {
			const col = board.createDiv({ cls: "ai-notebook-board-col" });
			col.createDiv({
				cls: "ai-notebook-board-col-title",
				text: `${g.label} (${g.items.length})`,
			});
			for (const item of g.items) {
				const card = col.createDiv({ cls: "ai-notebook-board-card" });
				if (this.activeItem?.frontmatter.item_id === item.frontmatter.item_id) {
					card.addClass("is-active");
				}
				card.createDiv({
					cls: "ai-notebook-item-title",
					text: item.frontmatter.title || "未命名",
				});
				card.createDiv({
					cls: "ai-notebook-item-meta",
					text: formatItemTime(item),
				});
				card.addEventListener("click", () => {
					this.activeItem = item;
					this.render();
				});
			}
		}
	}

	async quickCapture(): Promise<void> {
		if (!this.meta || !this.blueprint) return;
		const title = window.prompt("条目标题", "未命名");
		if (title == null) return;
		try {
			const entityType = this.plugin.runtime.primaryEntityId() ?? undefined;
			const item = await this.plugin.items.createItem(this.meta, {
				title,
				entityType,
			});
			const hooked = await this.plugin.hooks.runOnCreate({
				meta: this.meta,
				item,
				blueprint: this.blueprint,
			});
			this.activeItem = hooked.item;
			const failed = hooked.steps.filter((s) => !s.ok);
			if (failed.length) {
				new Notice(
					`已创建；部分钩子失败: ${failed.map((f) => f.type).join(", ")}`,
				);
			} else if (!hooked.steps.some((s) => s.type === "notify")) {
				new Notice("已创建条目");
			}
			await this.reload();
		} catch (e) {
			new Notice(`创建失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async renderCabinet(
		listPane: HTMLElement,
		detailPane: HTMLElement,
	): Promise<void> {
		// keep tab bar; clear rest of list pane children except first tab bar
		const tabBar = listPane.querySelector(".ai-notebook-tab-bar");
		listPane.empty();
		if (tabBar) listPane.appendChild(tabBar);
		else {
			const bar = listPane.createDiv({ cls: "ai-notebook-tab-bar" });
			const itemsTab = bar.createEl("button", { text: "条目" });
			const cabTab = bar.createEl("button", { text: "收藏柜" });
			const inboxTab = bar.createEl("button", { text: "收件箱" });
			cabTab.addClass("mod-cta");
			itemsTab.addEventListener("click", () => {
				this.leftTab = "items";
				this.render();
			});
			inboxTab.addEventListener("click", () => {
				this.leftTab = "inbox";
				void this.renderInbox(listPane, detailPane);
			});
		}

		if (!this.meta) return;
		const meta = this.meta;
		const addRow = listPane.createDiv({ cls: "ai-notebook-settings-actions" });

		const addLinkBtn = addRow.createEl("button", { text: "添加链接" });
		addLinkBtn.addClass("mod-cta");
		addLinkBtn.addEventListener("click", () => {
			void this.addCabinetLink(listPane, detailPane);
		});

		const pickVaultBtn = addRow.createEl("button", { text: "从库选择文件" });
		pickVaultBtn.addEventListener("click", () => {
			void this.addCabinetFileFromVault(listPane, detailPane);
		});

		const importBtn = addRow.createEl("button", { text: "从电脑导入" });
		importBtn.addEventListener("click", () => {
			void this.addCabinetFileFromComputer(listPane, detailPane);
		});

		const hint = listPane.createDiv({
			cls: "ai-notebook-empty",
			text: "链接：点「添加链接」。文件：「从库选择」登记 vault 内文件，或「从电脑导入」复制到本记录本附件目录。",
		});
		hint.style.padding = "8px 4px";
		hint.style.textAlign = "left";
		hint.style.fontSize = "0.8em";

		const links = await this.plugin.cabinet.listLinks(meta);
		const files = await this.plugin.cabinet.listFiles(meta);

		listPane.createEl("h4", { text: "链接" });
		if (links.length === 0) {
			listPane.createDiv({
				cls: "ai-notebook-empty",
				text: "暂无链接 — 点上方「添加链接」粘贴 URL",
			});
		}
		for (const link of links) {
			const row = listPane.createDiv({ cls: "ai-notebook-item-row" });
			row.createDiv({
				cls: "ai-notebook-item-title",
				text: link.title || link.url,
			});
			row.createDiv({ cls: "ai-notebook-item-meta", text: link.url });
			row.addEventListener("click", () => {
				this.renderCabinetDetail(detailPane, { kind: "link", link });
			});
		}

		listPane.createEl("h4", { text: "文件" });
		if (files.length === 0) {
			listPane.createDiv({
				cls: "ai-notebook-empty",
				text: "暂无文件 — 点「从库选择文件」或「从电脑导入」",
			});
		}
		for (const file of files) {
			const row = listPane.createDiv({ cls: "ai-notebook-item-row" });
			row.createDiv({
				cls: "ai-notebook-item-title",
				text: file.displayName,
			});
			row.createDiv({ cls: "ai-notebook-item-meta", text: file.vaultPath });
			row.addEventListener("click", () => {
				this.renderCabinetDetail(detailPane, { kind: "file", file });
			});
		}

		detailPane.empty();
		detailPane.createDiv({
			cls: "ai-notebook-empty",
			text: "选择收藏柜中的项目查看操作",
		});
	}

	private async addCabinetLink(
		listPane: HTMLElement,
		detailPane: HTMLElement,
	): Promise<void> {
		if (!this.meta) return;
		const modal = new AddCabinetLinkModal(this.app);
		const result = await modal.waitForResult();
		if (!result) return;
		try {
			const link = await this.plugin.cabinet.addLink(this.meta, {
				url: result.url,
				title: result.title || undefined,
				note: result.note || undefined,
			});
			new Notice(`已添加链接：${link.title || link.url}`);
			await this.renderCabinet(listPane, detailPane);
			this.renderCabinetDetail(detailPane, { kind: "link", link });
		} catch (e) {
			new Notice(`添加失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async addCabinetFileFromVault(
		listPane: HTMLElement,
		detailPane: HTMLElement,
	): Promise<void> {
		if (!this.meta) return;
		const meta = this.meta;
		await new Promise<void>((resolve) => {
			const modal = new VaultFileSuggestModal(this.app, (file) => {
				void (async () => {
					try {
						const registered = await this.plugin.cabinet.registerVaultFile(
							meta,
							{
								displayName: file.name,
								vaultPath: file.path,
								size: file.stat.size,
							},
						);
						new Notice(`已登记：${registered.displayName}`);
						await this.renderCabinet(listPane, detailPane);
						this.renderCabinetDetail(detailPane, {
							kind: "file",
							file: registered,
						});
					} catch (e) {
						new Notice(
							`登记失败: ${e instanceof Error ? e.message : String(e)}`,
						);
					} finally {
						resolve();
					}
				})();
			});
			// if user closes without pick, still resolve eventually
			const origClose = modal.onClose.bind(modal);
			modal.onClose = () => {
				origClose();
				resolve();
			};
			modal.open();
		});
	}

	private async addCabinetFileFromComputer(
		listPane: HTMLElement,
		detailPane: HTMLElement,
	): Promise<void> {
		if (!this.meta) return;
		const files = await pickLocalFiles({ multiple: true });
		if (files.length === 0) {
			new Notice("未选择文件（若已取消可忽略）");
			return;
		}
		let ok = 0;
		let last: import("../services/cabinetService").CabinetFile | null = null;
		for (const f of files) {
			try {
				const data = await f.arrayBuffer();
				const registered = await this.plugin.cabinet.importBinary(this.meta, {
					displayName: f.name,
					data,
					mime: f.type || undefined,
				});
				ok++;
				last = registered;
			} catch (e) {
				new Notice(
					`导入 ${f.name} 失败: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
		if (ok > 0) {
			new Notice(`已导入 ${ok} 个文件到附件目录并登记`);
			await this.renderCabinet(listPane, detailPane);
			if (last) {
				this.renderCabinetDetail(detailPane, { kind: "file", file: last });
			}
		}
	}

	private renderCabinetDetail(
		pane: HTMLElement,
		target:
			| { kind: "link"; link: import("../services/cabinetService").CabinetLink }
			| { kind: "file"; file: import("../services/cabinetService").CabinetFile },
	): void {
		pane.empty();
		if (!this.meta) return;
		const meta = this.meta;
		if (target.kind === "link") {
			const { link } = target;
			pane.createEl("h3", { text: link.title || "链接" });
			pane.createEl("p", { text: link.url });
			new Setting(pane).addButton((b) =>
				b.setButtonText("解析标题").onClick(async () => {
					const updated = await this.plugin.cabinet.parseLinkTitle(
						meta,
						link.id,
					);
					new Notice(`标题: ${updated.title}`);
					this.renderCabinetDetail(pane, { kind: "link", link: updated });
				}),
			);
			new Setting(pane).addButton((b) =>
				b.setButtonText("删除").setWarning().onClick(async () => {
					if (!confirm("删除该链接？")) return;
					await this.plugin.cabinet.removeLink(meta, link.id);
					new Notice("已删除");
					this.leftTab = "cabinet";
					await this.reload();
					this.leftTab = "cabinet";
					this.render();
				}),
			);
			return;
		}
		const { file } = target;
		pane.createEl("h3", { text: file.displayName });
		pane.createEl("p", { text: file.vaultPath });
		if (file.mime) {
			pane.createEl("p", {
				cls: "setting-item-description",
				text: `类型: ${file.mime} · 大小: ${file.size || "?"} 字节`,
			});
		}
		new Setting(pane).addButton((b) =>
			b.setButtonText("在库中打开").onClick(async () => {
				const af = this.app.vault.getAbstractFileByPath(file.vaultPath);
				if (af) {
					await this.app.workspace.getLeaf(true).openFile(af as import("obsidian").TFile);
				} else {
					new Notice("文件不在 vault 中（可能已移动）");
				}
			}),
		);
		new Setting(pane).addButton((b) =>
			b.setButtonText("删除文件记录").setWarning().onClick(async () => {
				if (!confirm("删除该文件记录（并尝试删除 vault 文件）？")) return;
				await this.plugin.cabinet.removeFile(meta, file.id);
				new Notice("已删除");
				this.leftTab = "cabinet";
				this.render();
			}),
		);
	}

	private async openVersions(): Promise<void> {
		if (!this.meta) return;
		try {
			const index = await this.plugin.versions.loadIndex(this.meta.folderName);
			new VersionHistoryModal(
				this.app,
				this.plugin,
				this.meta,
				index,
				() => void this.reload(),
			).open();
		} catch (e) {
			new Notice(`无法打开版本: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** P1: re-commit current blueprint file as new version after user confirms (no-op if same). For manual edits to vN.json workflow we reload disk then commit. */
	private async commitCurrentBlueprint(): Promise<void> {
		if (!this.meta) return;
		try {
			const { index, blueprint } = await this.plugin.versions.loadCurrentBlueprint(
				this.meta.folderName,
			);
			// Allow user to paste/edit: re-read raw current file (already loaded)
			assertBlueprint(blueprint);
			const next = {
				...blueprint,
				description: `${blueprint.description}`.trim(),
			};
			const lines = this.plugin.versions.diffBlueprints(blueprint, next);
			// Offer bump by reloading from disk in case user edited file externally
			const fromDisk = await this.plugin.versions.loadBlueprint(
				this.meta.folderName,
				index.current,
			);
			const diff = this.plugin.versions.diffBlueprints(blueprint, fromDisk);
			const modal = new DiffConfirmModal(
				this.app,
				"确认提交当前蓝图为新版本？",
				diff.length ? diff : lines,
			);
			const ok = await modal.waitForConfirm();
			if (!ok) return;
			const { version } = await this.plugin.versions.commit(
				this.meta.folderName,
				this.meta.notebook_id,
				fromDisk,
				{
					author: "user",
					changeSummary:
						diff.length > 0
							? `手动提交：${diff
									.slice(0, 3)
									.map((d) => d.text)
									.join("；")}`
							: "手动提交当前蓝图（无结构性差异）",
					changeDetails: this.plugin.versions.humanizeDiff(
						diff.length ? diff : lines,
					),
				},
			);
			this.meta = await this.plugin.notebooks.touchCurrentBlueprint(
				this.meta,
				version,
			);
			new Notice(`已提交功能版本 v${version}`);
			await this.reload();
		} catch (e) {
			new Notice(`提交失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

function formatItemTime(item: NotebookItem): string {
	const raw =
		item.frontmatter.updated ||
		item.frontmatter.created ||
		"";
	const label = formatDateTimeLocal(String(raw));
	return label ? `更新 ${label}` : "";
}

function formatCell(value: unknown): string {
	if (value == null) return "";
	if (Array.isArray(value)) return value.join(", ");
	return String(value);
}
