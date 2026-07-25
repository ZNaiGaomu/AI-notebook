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
import { createId, formatDateTimeLocal } from "../domain/ids";
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
import {
	AssistantActionRunner,
	assistantToolSystemAppendix,
	maybeInferEmbedActions,
	parseAssistantResponse,
	type PendingChatFile,
} from "../services/assistantActions";
import {
	persistChatUpload,
	toChatMessageAttachments,
} from "../services/chatUploadStore";
import {
	isVisionCapabilityError,
	resolveProviderChain,
} from "../services/providerResolver";
import type { ChatContentPart, ChatMessage } from "../infra/aiGateway";
import {
	ChatFloatPanel,
	type QueuedSend,
	type SendFollowMode,
} from "./chatFloatPanel";
import {
	ChatPickItemModal,
	ChatPickNotebookModal,
} from "./chatContextPickers";

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
	private chatThinking = false;
	/** Files staged for the next assistant send (reference-only by default). */
	private pendingChatFiles: PendingChatFile[] = [];
	/** Files for embed_in_body within current item session (option A). */
	private sessionChatFiles: PendingChatFile[] = [];
	private sessionFilesItemKey: string | null = null;
	/** Keep float expanded across remounts when user is chatting. */
	private chatFloatWantOpen = false;
	/**
	 * User clicked「新对话」: next ensureThread must create, not restore latest.
	 * Cleared after a new thread is created or user opens an old history thread.
	 */
	private forceNewAssistantThread = false;
	private sendFollowMode: SendFollowMode = "queue";
	private sendQueue: QueuedSend[] = [];
	/** Guide lines appended into the in-flight assistant turn. */
	private guideBuffer: string[] = [];
	private chatFloat: ChatFloatPanel | null = null;

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
		this.activeItem = null;
		this.assistantThread = null;
		this.featureThread = null;
		this.sessionChatFiles = [];
		this.sessionFilesItemKey = null;
		this.chatFloatWantOpen = false;
		this.forceNewAssistantThread = false;
		await this.reload();
	}

	async onOpen(): Promise<void> {
		await this.reload();
	}

	async onClose(): Promise<void> {
		this.chatFloat?.destroy();
		this.chatFloat = null;
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


		// Floating chat — remount preserves expand via chatFloatWantOpen
		const wasOpen = this.chatFloat
			? !this.chatFloat.isCollapsed()
			: this.chatFloatWantOpen;
		this.chatFloatWantOpen = wasOpen;
		this.chatFloat?.destroy();
		this.chatFloat = new ChatFloatPanel(el, {
				getChatMode: () => this.chatMode,
				setChatMode: (mode) => {
					this.chatMode = mode;
					this.chatFloat?.paint();
				},
				getFollowMode: () => this.sendFollowMode,
				setFollowMode: (m) => {
					this.sendFollowMode = m;
				},
				getAssistantThread: () => this.assistantThread,
				getFeatureThread: () => this.featureThread,
				getPendingFiles: () => this.pendingChatFiles,
				setPendingFiles: (files) => {
					this.pendingChatFiles = files;
				},
				getBusy: () => this.chatBusy,
				getThinking: () => this.chatThinking,
				getQueueLength: () => this.sendQueue.length,
				getPlaceholder: (mode) =>
					mode === "feature"
						? this.blueprint?.ui.featureEditPrompt ??
							"描述你想如何改这个记录本的功能…"
						: this.blueprint?.ui.homePrompt ?? "向助手提问…",
				getNotebookLabel: () => this.meta?.name ?? "未选择记录本",
				getItemLabel: () =>
					this.activeItem?.frontmatter.title?.trim() ||
					(this.activeItem
						? this.activeItem.frontmatter.item_id.slice(0, 8)
						: "未选中条目"),
				onPickNotebook: () => {
					void new ChatPickNotebookModal(
						this.app,
						this.plugin,
						(meta) => {
							void this.plugin.openNotebook(meta.notebook_id);
						},
					).openAndLoad();
				},
				onPickItem: () => {
					if (!this.meta) {
						new Notice("请先选择记录本");
						return;
					}
					if (this.items.length === 0) {
						new Notice("当前记录本没有条目");
						return;
					}
					new ChatPickItemModal(this.app, this.items, (item) => {
						void this.selectItem(item);
					}).open();
				},
				onPickFiles: async () => {
						await this.pickChatAttachments();
					},
					onIngestFiles: async (files) => {
						await this.ingestBrowserFiles(files);
					},
				onOpenHistory: () => {
					this.openChatHistoryModal();
				},
				onNewChat: () => {
					if (this.chatMode === "feature") this.featureThread = null;
					else {
						this.assistantThread = null;
						this.sessionChatFiles = [];
						this.forceNewAssistantThread = true;
					}
					new Notice("已开始新对话");
					this.chatFloat?.paint();
				},
				onSubmit: (text, files) => {
					void this.enqueueOrSend(text, files);
				},
				onExpanded: () => {
					this.chatFloatWantOpen = true;
				},
			});
		this.chatFloat.mount({ startCollapsed: !this.chatFloatWantOpen });
		}

		private openChatHistoryModal(): void {
			if (!this.meta) return;
			const itemId =
				this.chatMode === "assistant"
					? (this.activeItem?.frontmatter.item_id ?? null)
					: null;
			const itemTitle =
				this.chatMode === "assistant"
					? (this.activeItem?.frontmatter.title ?? null)
					: null;
			new ChatHistoryModal(
				this.app,
				this.plugin,
				this.meta.notebook_id,
				this.chatMode,
				{
					onPick: (t) => {
						if (this.chatMode === "feature") {
							this.featureThread = t;
						} else {
							this.forceNewAssistantThread = false;
							this.assistantThread = t;
							if (t.itemId) {
								const found = this.items.find(
									(it) => it.frontmatter.item_id === t.itemId,
								);
								if (found) void this.selectItem(found, false);
							}
						}
						this.chatFloat?.paint();
					},
					onNew: () => {
							if (this.chatMode === "feature") this.featureThread = null;
							else {
								this.assistantThread = null;
								this.sessionChatFiles = [];
								this.forceNewAssistantThread = true;
							}
							this.chatFloat?.paint();
						},
					onSwitchItem:
						this.chatMode === "assistant"
							? () => {
									if (!this.meta || this.items.length === 0) {
										new Notice("没有可选条目");
										return;
									}
									new ChatPickItemModal(
										this.app,
										this.items,
										(item) => {
											void this.selectItem(item).then(() =>
												this.openChatHistoryModal(),
											);
										},
									).open();
								}
							: undefined,
				},
				{ itemId, itemTitle },
			).open();
		}

		private async selectItem(
			item: NotebookItem,
			resetAssistantThread = true,
		): Promise<void> {
			if (this.chatFloat && !this.chatFloat.isCollapsed()) {
				this.chatFloatWantOpen = true;
			}
			this.activeItem = item;
			this.leftTab = "items";
			this.ensureSessionFilesScope();
			if (resetAssistantThread) {
				// Switching items: drop "new chat" flag and restore that item's latest
				this.forceNewAssistantThread = false;
				await this.restoreLatestAssistantThread();
			}
			this.render();
			if (this.chatFloatWantOpen && this.chatFloat?.isCollapsed()) {
				this.chatFloat.setCollapsed(false);
			}
			this.chatFloat?.paint();
		}

		private sessionFilesKey(): string {
			const nb = this.meta?.notebook_id ?? "";
			const it = this.activeItem?.frontmatter.item_id ?? "__none__";
			return `${nb}::${it}`;
		}

		private ensureSessionFilesScope(): void {
			const key = this.sessionFilesKey();
			if (this.sessionFilesItemKey !== key) {
				this.sessionFilesItemKey = key;
				this.sessionChatFiles = [];
			}
		}

		private rememberSessionFiles(files: PendingChatFile[]): void {
			this.ensureSessionFilesScope();
			if (!files.length) return;
			const byId = new Map(this.sessionChatFiles.map((f) => [f.id, f]));
			for (const f of files) byId.set(f.id, f);
			this.sessionChatFiles = [...byId.values()];
		}

		/** Model / UI: only this turn's files (never mix previous uploads). */
		private filesForThisTurn(sendFiles: PendingChatFile[]): PendingChatFile[] {
			return [...sendFiles];
		}

		/**
		 * embed_in_body lookup: this-turn first, then session cache (same item).
		 * Index "0" always means first of THIS turn when present.
		 */
		private filesForEmbedActions(
			sendFiles: PendingChatFile[],
		): PendingChatFile[] {
			this.ensureSessionFilesScope();
			const ordered: PendingChatFile[] = [];
			const seen = new Set<string>();
			for (const f of sendFiles) {
				if (seen.has(f.id)) continue;
				seen.add(f.id);
				ordered.push(f);
			}
			for (const f of this.sessionChatFiles) {
				if (seen.has(f.id)) continue;
				seen.add(f.id);
				ordered.push(f);
			}
			return ordered;
		}

		private dropSessionFiles(ids: string[]): void {
			if (!ids.length) return;
			const drop = new Set(ids);
			this.sessionChatFiles = this.sessionChatFiles.filter((f) => !drop.has(f.id));
		}

		/** Load most recent assistant thread for current item, or null. */
		private async restoreLatestAssistantThread(): Promise<void> {
			if (this.forceNewAssistantThread) {
				this.assistantThread = null;
				return;
			}
			this.assistantThread = null;
			if (!this.meta) return;
			const itemId = this.activeItem?.frontmatter.item_id ?? null;
			try {
				const list = await this.plugin.chatHistory.list(
					this.meta.notebook_id,
					"assistant",
					itemId,
				);
				this.assistantThread = list[0] ?? null;
			} catch {
				this.assistantThread = null;
			}
		}


	async voiceCapturePublic(): Promise<void> {
		await this.voiceCapture();
	}

	private async voiceCapture(): Promise<void> {
		if (!this.meta) {
			new Notice("未打开记录本");
			return;
		}
		// 无 AI 也可录音：至少保存可播放的音频笔记
		await this.recordAndTranscribe();
	}

	private async recordAndTranscribe(): Promise<void> {
		if (!this.meta) return;
		const modal = new VoiceRecordModal(
			this.app,
			this.plugin.settings.voice?.recordFormat ?? "auto",
		);
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

		const kb = Math.round(recorded.blob.size / 1024);
		const title = `语音 ${new Date().toLocaleString()}`;
		const chip = this.showVoiceProgressChip(`录音 ${kb}KB · 保存中…`);

		let vaultPath: string;
		let arrayBuffer: ArrayBuffer;
		let embedMarkdown: string;
		try {
			const saved = await this.plugin.voicePipeline.saveAudioFile(
				this.meta,
				recorded.blob,
				recorded.filename || "audio.wav",
			);
			vaultPath = saved.vaultPath;
			arrayBuffer = saved.arrayBuffer;
			const { buildEmbedMarkdown } = await import(
				"../services/voicePipeline"
			);
			embedMarkdown = buildEmbedMarkdown(vaultPath);
		} catch (e) {
			chip.done(
				`保存失败：${e instanceof Error ? e.message : String(e)}`,
				false,
			);
			return;
		}

		// Keep note body stable — progress only in corner chip
		const pendingBody = [
			"## 转写",
			"",
			"> ⏳ 转写处理中…（进度见进度浮条）",
			"",
			embedMarkdown,
		].join("\n");

		let pendingItem: import("../domain/types").NotebookItem | null = null;
		try {
			if (!this.blueprint) {
				const { blueprint } = await this.plugin.versions.loadCurrentBlueprint(
					this.meta.folderName,
				);
				this.blueprint = blueprint;
				this.plugin.runtime.load(blueprint);
			}
			pendingItem = await this.plugin.items.createItem(this.meta, {
				title,
				body: pendingBody,
				entityType: this.plugin.runtime.primaryEntityId() ?? undefined,
				fields: {
					source: "voice",
					transcribe_status: "pending",
					audio_path: vaultPath,
				},
			});
			this.activeItem = pendingItem;
			this.leftTab = "items";
			await this.reload();
			chip.set("已写入笔记 · 转写中…");
		} catch (e) {
			chip.done(
				`笔记创建失败（音频已在附件）：${e instanceof Error ? e.message : String(e)}`,
				false,
			);
		}

		let lastChip = "";
		const pipe = await this.plugin.voicePipeline.process(
			this.meta,
			recorded.blob,
			recorded.filename || "audio.wav",
			{
				existing: { vaultPath, arrayBuffer },
				onProgress: (msg) => {
					if (msg !== lastChip) {
						lastChip = msg;
						chip.set(msg);
					}
				},
			},
		);

		if (pipe.ok && pipe.transcript.trim()) {
			const methodLabel =
				pipe.method === "whisper"
					? "STT"
					: pipe.method === "chat-audio"
						? "听音频"
						: "转写";
			const raw = pipe.transcript.trim();
			const polished = (pipe.polished || "").trim();
			const parts = ["## 转写", "", raw];
			if (polished && polished !== raw) {
				parts.push("", "## 润色", "", polished);
			}
			parts.push(pipe.embedMarkdown || embedMarkdown);
			const body = parts.join("\n");
			const titleSrc = polished || raw;
			const titleLine =
				titleSrc
					.split("\n")
					.find((l) => l.trim() && !l.startsWith("#"))
					?.slice(0, 40) || title;
			try {
				if (pendingItem) {
					const updated = await this.plugin.items.updateItem(pendingItem, {
						title: titleLine,
						body,
						fields: {
							source: "voice",
							transcribe_status: "done",
							audio_path: vaultPath,
						},
					});
					this.activeItem = updated;
					await this.reload();
				} else {
					await this.createFromTranscript(body, {
						sourceLabel: "voice",
						title: titleLine,
						preserveEmbedsFrom: body,
					});
				}
			} catch (e) {
				chip.done(
					`写回失败：${e instanceof Error ? e.message : String(e)}`,
					false,
				);
				return;
			}
			chip.done(
				polished && polished !== raw
					? `完成 · ${methodLabel}+润色`
					: `完成 · ${methodLabel}`,
				true,
			);
			return;
		}

		const draft = [
			"## 转写",
			"",
			pipe.error
				? `> 自动转写未成功：${pipe.error}`
				: "> 自动转写未成功。",
			pipe.errorDetail
				? `\n> 详情：${pipe.errorDetail.replace(/\n/g, " · ").slice(0, 280)}\n`
				: "",
			"",
			"下方可直接播放录音；也可手动把听到的内容写在本段下方。",
			pipe.embedMarkdown || embedMarkdown,
		]
			.filter((line) => line !== "")
			.join("\n");
		try {
			if (pendingItem) {
				const updated = await this.plugin.items.updateItem(pendingItem, {
					body: draft,
					fields: {
						source: "voice",
						transcribe_status: "failed",
						audio_path: vaultPath,
					},
				});
				this.activeItem = updated;
				await this.reload();
			} else {
				await this.createFromTranscript(draft, {
					title,
					skipAi: true,
					sourceLabel: "voice-audio-only",
					preserveEmbedsFrom: draft,
				});
			}
		} catch {
			/* ignore */
		}
		const detail = (pipe.errorDetail || pipe.error || "").slice(0, 90);
		chip.done(`失败 · ${detail || "见笔记"}`, false);
	}

	/** Draggable voice progress chip; position saved in settings. */
	private showVoiceProgressChip(initial: string): {
		set: (msg: string) => void;
		done: (msg: string, ok: boolean) => void;
	} {
		document.querySelector(".ai-notebook-voice-chip")?.remove();
		const el = document.body.createDiv({
			cls: "ai-notebook-voice-chip is-busy",
		});
		el.createSpan({ cls: "ai-notebook-voice-chip-dot" });
		const text = el.createSpan({
			cls: "ai-notebook-voice-chip-text",
			text: initial,
		});
		
		const saved = this.plugin.settings.voice?.chipPosition;
		const place = () => {
			const w = el.offsetWidth || 200;
			const h = el.offsetHeight || 36;
			const maxL = Math.max(8, window.innerWidth - w - 8);
			const maxT = Math.max(8, window.innerHeight - h - 8);
			if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
				el.style.left = Math.min(maxL, Math.max(8, saved.left)) + "px";
				el.style.top = Math.min(maxT, Math.max(8, saved.top)) + "px";
				el.style.right = "auto";
				el.style.bottom = "auto";
			} else {
				el.style.right = "16px";
				el.style.bottom = "18px";
				el.style.left = "auto";
				el.style.top = "auto";
			}
		};
		place();
		
		let dragging = false;
		let moved = false;
		let startX = 0;
		let startY = 0;
		let origL = 0;
		let origT = 0;
		
		const onDown = (clientX: number, clientY: number) => {
			dragging = true;
			moved = false;
			const rect = el.getBoundingClientRect();
			origL = rect.left;
			origT = rect.top;
			startX = clientX;
			startY = clientY;
			el.style.left = origL + "px";
			el.style.top = origT + "px";
			el.style.right = "auto";
			el.style.bottom = "auto";
			el.addClass("is-dragging");
		};
		const onMove = (clientX: number, clientY: number) => {
			if (!dragging) return;
			const dx = clientX - startX;
			const dy = clientY - startY;
			if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
			const w = el.offsetWidth;
			const h = el.offsetHeight;
			const left = Math.min(Math.max(8, origL + dx), Math.max(8, window.innerWidth - w - 8));
			const top = Math.min(Math.max(8, origT + dy), Math.max(8, window.innerHeight - h - 8));
			el.style.left = left + "px";
			el.style.top = top + "px";
		};
		const onUp = () => {
			if (!dragging) return;
			dragging = false;
			el.removeClass("is-dragging");
			if (!moved) return;
			const rect = el.getBoundingClientRect();
			const pos = { left: Math.round(rect.left), top: Math.round(rect.top) };
			this.plugin.settings = {
				...this.plugin.settings,
				voice: {
					...this.plugin.settings.voice,
					chipPosition: pos,
				},
			};
			void this.plugin.saveSettings();
		};
		
		el.addEventListener("pointerdown", (ev) => {
			if (ev.button != null && ev.button !== 0) return;
			ev.preventDefault();
			el.setPointerCapture(ev.pointerId);
			onDown(ev.clientX, ev.clientY);
		});
		el.addEventListener("pointermove", (ev) => {
			onMove(ev.clientX, ev.clientY);
		});
		el.addEventListener("pointerup", () => onUp());
		el.addEventListener("pointercancel", () => onUp());
		
		return {
			set: (msg: string) => {
				text.setText(msg);
				el.removeClass("is-ok");
				el.removeClass("is-err");
				el.addClass("is-busy");
			},
			done: (msg: string, ok: boolean) => {
				text.setText(msg);
				el.removeClass("is-busy");
				el.addClass(ok ? "is-ok" : "is-err");
				window.setTimeout(() => el.remove(), ok ? 2800 : 5600);
			},
		};
	}

	private async createFromTranscript(
		text: string,
		opts?: {
			title?: string;
			skipAi?: boolean;
			sourceLabel?: string;
			preserveEmbedsFrom?: string;
		},
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
					preserveEmbedsFrom: opts?.preserveEmbedsFrom || text,
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
		await this.enqueueOrSend(text.trim(), []);
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
		const itemId = this.activeItem?.frontmatter.item_id ?? null;
		const itemTitle = this.activeItem?.frontmatter.title ?? null;
		if (
			this.assistantThread &&
			(this.assistantThread.itemId ?? null) !== itemId
		) {
			this.assistantThread = null;
		}
		// 「新对话」: never re-attach latest history; always create once
		if (this.forceNewAssistantThread) {
			if (!this.assistantThread) {
				this.assistantThread = await this.plugin.chatHistory.create(
					this.meta.notebook_id,
					"assistant",
					{ itemId, itemTitle },
				);
			}
			this.forceNewAssistantThread = false;
			return this.assistantThread;
		}
		if (!this.assistantThread) {
			try {
				const list = await this.plugin.chatHistory.list(
					this.meta.notebook_id,
					"assistant",
					itemId,
				);
				if (list[0]) {
					this.assistantThread = list[0];
				}
			} catch {
				/* ignore */
			}
		}
		if (!this.assistantThread) {
			this.assistantThread = await this.plugin.chatHistory.create(
				this.meta.notebook_id,
				"assistant",
				{ itemId, itemTitle },
			);
		}
		return this.assistantThread;
	}

	/**
	 * Instant UX: message already cleared in UI. If busy → queue or guide.
	 * Otherwise start processing immediately (thinking indicator).
	 */
	private async enqueueOrSend(
		text: string,
		files: PendingChatFile[],
	): Promise<void> {
		const mode = this.chatMode;
		if (this.chatBusy) {
			if (this.sendFollowMode === "guide" && mode === "assistant") {
				this.guideBuffer = [...this.guideBuffer, text];
				// show guide as a system-ish user note in history quickly
				try {
					const thread = await this.ensureThread();
					await this.plugin.chatHistory.append(
						thread.id,
						"user",
						`【引导补充】${text}`,
					);
					this.assistantThread =
						(await this.plugin.chatHistory.get(thread.id)) ?? thread;
				} catch {
					/* ignore */
				}
				new Notice("已作为引导附加到当前请求");
				this.chatFloat?.paint();
				return;
			}
			this.sendQueue = [
				...this.sendQueue,
				{
					id: createId(),
					mode,
					text,
					files,
					follow: "queue",
				},
			];
			new Notice(`已加入队列（第 ${this.sendQueue.length} 条）`);
			this.chatFloat?.paint();
			return;
		}
		await this.processSend(mode, text, files);
	}

	private async processSend(
		mode: "assistant" | "feature",
		text: string,
		files: PendingChatFile[],
	): Promise<void> {
		if (this.chatBusy) return;
		this.chatMode = mode;
		this.chatBusy = true;
		this.chatThinking = true;
		this.chatFloatWantOpen = true;
		if (this.chatFloat?.isCollapsed()) this.chatFloat.setCollapsed(false);
		this.chatFloat?.paint();
		try {
			if (mode === "feature") {
				await this.runFeatureEdit(text);
			} else {
				await this.runAssistantChat(text, files);
			}
		} finally {
			this.chatThinking = false;
			this.chatBusy = false;
			if (this.meta) {
				try {
					this.items = await this.plugin.items.listItems(this.meta);
					if (this.activeItem) {
						const fresh = this.items.find(
							(it) =>
								it.frontmatter.item_id ===
								this.activeItem!.frontmatter.item_id,
						);
						if (fresh) this.activeItem = fresh;
					}
				} catch {
					/* ignore */
				}
				// Refresh main UI without dropping chat float size/session mid-flight:
				// full render remounts float (always collapsed) — do it after paint.
				this.render();
			}
			this.chatFloat?.paint();
			await this.drainSendQueue();
		}
	}

	private async drainSendQueue(): Promise<void> {
		if (this.chatBusy || this.sendQueue.length === 0) return;
		const [next, ...rest] = this.sendQueue;
		this.sendQueue = rest;
		if (!next) return;
		await this.processSend(next.mode, next.text, next.files);
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

	private async runAssistantChat(
		text: string,
		files: PendingChatFile[],
	): Promise<void> {
		if (!this.meta || !this.blueprint) {
			new Notice("未打开记录本");
			return;
		}
		const thread = await this.ensureThread();
		this.rememberSessionFiles(files);
		// Model sees ONLY this turn — never previous session uploads
		const pending = this.filesForThisTurn(files);
		const embedPool = this.filesForEmbedActions(files);
		const attachNote =
			pending.length > 0
				? `\n\n[本轮附件 ${pending.length} 个：${pending.map((f) => f.name).join("、")}]`
				: "";
		await this.plugin.chatHistory.append(
			thread.id,
			"user",
			text + attachNote,
			toChatMessageAttachments(pending),
		);
		this.assistantThread =
			(await this.plugin.chatHistory.get(thread.id)) ?? thread;
		this.chatFloat?.paint();

		// absorb any guide lines that arrived after we started
		const guides = [...this.guideBuffer];
		this.guideBuffer = [];
		const guideBlock =
			guides.length > 0
				? `\n\n【用户引导补充】\n${guides.map((g, i) => `${i + 1}. ${g}`).join("\n")}`
				: "";

		const needVision = pending.some((f) => f.kind === "image" && f.dataUrl);
		const chain = resolveProviderChain(
			this.plugin.settings,
			"worker",
			this.meta,
			{ vision: needVision },
		);
		if (chain.length === 0) {
			const err = "请先在设置中配置 AI Provider（用途：整理/助手 的顺序链）";
			await this.plugin.chatHistory.append(thread.id, "assistant", err);
			this.assistantThread = await this.plugin.chatHistory.get(thread.id);
			new Notice(err);
			return;
		}

		const ctxItem = this.activeItem
			? JSON.stringify(
					{
						item_id: this.activeItem.frontmatter.item_id,
						title: this.activeItem.frontmatter.title,
						fields: this.activeItem.frontmatter,
						body: this.activeItem.body.slice(0, 4000),
					},
					null,
					2,
				)
			: "(无选中条目 — update_item / embed_in_body 前请先选中，或 create_item)";

		const system = [
			this.blueprint.aiBehaviors.systemHints,
			assistantToolSystemAppendix(pending),
			`记录本: ${this.meta.name}`,
			`实体字段定义: ${JSON.stringify(this.blueprint.entityTypes)}`,
			`当前选中条目: ${ctxItem}`,
		].join("\n");

		const historyBase = this.plugin.chatHistory.toApiMessages(
			this.assistantThread!,
			system,
			20,
		);
		// inject guide into last user message if any
		if (guideBlock && historyBase.length) {
			const last = historyBase[historyBase.length - 1];
			if (last && last.role === "user" && typeof last.content === "string") {
				historyBase[historyBase.length - 1] = {
					...last,
					content: last.content + guideBlock,
				};
			}
		}

		const messages = this.buildAssistantMessages(historyBase, pending);

		let result: { ok: true; content: string } | { ok: false; error: string } =
			{ ok: false, error: "无可用模型" };
		const tried: string[] = [];

		for (const cand of chain) {
			const label = `${cand.profile.name}/${cand.model}`;
			tried.push(label);
			const r = await this.plugin.gateway.chat(
				cand.profile,
				cand.model,
				messages,
				{ maxTokens: 2048, temperature: 0.35 },
			);
			if (r.ok) {
				result = r;
				if (tried.length > 1) {
					new Notice(`已用模型：${label}`);
				}
				break;
			}
			result = r;
		}

		if (!result.ok) {
			const err = `助手失败: ${result.error}${tried.length ? `（已试：${tried.join(" → ")}）` : ""}`;
			await this.plugin.chatHistory.append(thread.id, "assistant", err);
			this.assistantThread = await this.plugin.chatHistory.get(thread.id);
			new Notice(err);
			return;
		}

		const parsed = parseAssistantResponse(result.content);
		const actions = maybeInferEmbedActions(text, parsed.actions, pending);
		let reply = parsed.reply || result.content;
		if (actions.length && /```|embed_in_body|"actions"\s*:/.test(reply)) {
			const cleaned = reply
				.replace(/```(?:json)?\s*[\s\S]*?```/gi, "")
				.replace(/^\s*[\]}]\s*$/gm, "")
				.trim();
			if (cleaned) reply = cleaned;
		}

		if (actions.length > 0) {
			const needsItem = actions.some(
				(a) => a.type === "embed_in_body" || a.type === "update_item",
			);
			if (needsItem && !this.activeItem) {
				const warn =
					"未选中条目，无法写入正文。请先在左侧或对话窗口选择条目。";
				reply = `${reply}\n\n——\n${warn}`;
				new Notice(warn);
			} else {
				const runner = new AssistantActionRunner(
					this.plugin.items,
					this.plugin.cabinet,
					this.plugin.vaultIo,
					() => this.plugin.settings,
				);
				const apply = await runner.apply(
					this.meta,
					this.blueprint,
					this.activeItem,
					[...this.items],
					actions,
					embedPool,
				);
				if (apply.messages.length) {
					reply = `${reply}\n\n——\n${apply.messages.join("\n")}`;
				}
				if (apply.updatedItem) {
					this.activeItem = apply.updatedItem;
				}
				if (apply.createdItem) {
					this.activeItem = apply.createdItem;
				}
				this.items = await this.plugin.items.listItems(this.meta);
				if (this.activeItem) {
					const fresh = this.items.find(
						(it) =>
							it.frontmatter.item_id ===
							this.activeItem!.frontmatter.item_id,
					);
					if (fresh) this.activeItem = fresh;
				}
				const ok = apply.messages.some(
					(m) =>
						m.includes("已将") ||
						m.includes("已更新") ||
						m.includes("已新建"),
				);
				new Notice(
					ok
						? "助手已写入笔记"
						: "助手已回复（部分动作可能失败，见对话摘要）",
				);
			}
		} else {
			new Notice("助手已回复");
		}

		await this.plugin.chatHistory.append(thread.id, "assistant", reply);
		this.assistantThread = await this.plugin.chatHistory.get(thread.id);
		this.chatFloat?.paint();
	}

	/**
	 * If last user message should include image parts, rebuild messages for gateway.
	 */
	private buildAssistantMessages(
		history: ChatMessage[],
		pending: PendingChatFile[],
	): ChatMessage[] {
		const images = pending.filter((f) => f.kind === "image" && f.dataUrl);
		const textExtras = pending
			.filter((f) => f.kind !== "image" || !f.dataUrl)
			.map((f) => {
				const head = `【附件 ${f.name} | ${f.kind} | ${f.mime}】`;
				if (f.textPreview) return `${head}\n${f.textPreview.slice(0, 8000)}`;
				return `${head}\n（二进制未直接内嵌；说「放进正文」用 embed_in_body，说「收藏柜」用 attach_chat_file）`;
			});

		if (images.length === 0 && textExtras.length === 0) {
			return history;
		}

		const out = history.map((m) => ({ ...m }));
		// find last user message
		for (let i = out.length - 1; i >= 0; i--) {
			const m = out[i]!;
			if (m.role !== "user") continue;
			const baseText =
				typeof m.content === "string"
					? m.content
					: m.content
							.filter((p): p is { type: "text"; text: string } => p.type === "text")
							.map((p) => p.text)
							.join("\n");
			const parts: ChatContentPart[] = [
				{
					type: "text",
					text: [baseText, ...textExtras].filter(Boolean).join("\n\n"),
				},
			];
			for (const img of images) {
				parts.push({
					type: "image_url",
					image_url: { url: img.dataUrl!, detail: "auto" },
				});
			}
			out[i] = { role: "user", content: parts };
			break;
		}
		return out;
	}

	private async pickChatAttachments(): Promise<void> {
		const files = await pickLocalFiles({
			multiple: true,
			accept: "image/*,video/*,audio/*,.pdf,.txt,.md,.json,.csv,.doc,.docx",
		});
		if (!files.length) return;
		await this.ingestBrowserFiles(files);
	}

	/** Button / drag / paste entry: read File[], stage chips, persist to vault. */
	private async ingestBrowserFiles(files: File[]): Promise<void> {
		if (!files.length) return;
		if (!this.meta) {
			new Notice("请先打开记录本再上传");
			return;
		}
		const MAX_IMAGE_INLINE = 4 * 1024 * 1024;
		const MAX_TEXT_READ = 512 * 1024;
		const added: PendingChatFile[] = [];

		for (const file of files) {
			const data = await file.arrayBuffer();
			const mime = file.type || guessMimeFromName(file.name);
			const kind = classifyMime(mime, file.name);
			const id = createId();
			let dataUrl: string | undefined;
			let textPreview: string | undefined;

			if (kind === "image" && data.byteLength <= MAX_IMAGE_INLINE) {
				dataUrl = await arrayBufferToDataUrl(data, mime || "image/png");
			}
			if (
				kind === "text" ||
				/\.(txt|md|json|csv|log|xml|html?)$/i.test(file.name)
			) {
				if (data.byteLength <= MAX_TEXT_READ) {
					textPreview = new TextDecoder("utf-8", {
						fatal: false,
					}).decode(data);
				}
			}

			let pending: PendingChatFile = {
				id,
				name: file.name || `paste-${id.slice(0, 6)}.png`,
				mime: mime || "application/octet-stream",
				size: data.byteLength,
				data,
				dataUrl,
				kind,
				textPreview,
			};
			try {
				pending = await persistChatUpload(
					this.plugin.vaultIo,
					this.plugin.settings,
					this.meta.notebook_id,
					this.activeItem?.frontmatter.item_id ?? null,
					pending,
				);
			} catch (e) {
				console.warn("[ai-notebook] persist chat upload", e);
			}
			added.push(pending);
		}

		this.pendingChatFiles = [...this.pendingChatFiles, ...added];
		this.rememberSessionFiles(added);
		this.chatFloat?.paint();
		new Notice(`已添加 ${added.length} 个附件（默认仅参考；已存入对话附件目录）`);
	}

	/** Clipboard image paste (e.g. screenshot). */
	async ingestClipboardImage(file: File): Promise<void> {
		await this.ingestBrowserFiles([file]);
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
			ta.rows = 8;
			ta.addEventListener("blur", () => onCommit(ta.value));
			const preview = wrap.createDiv({
				cls: "ai-notebook-body-media-preview",
			});
			const paintPreview = (src: string) => {
				preview.empty();
				const embeds = extractMediaPaths(src);
				if (!embeds.length) return;
				for (const emb of embeds) {
					const block = preview.createDiv({
						cls: "ai-notebook-media-block",
					});
					if (emb.kind === "image") {
						const img = block.createEl("img");
						img.src = this.vaultResourceUrl(emb.path);
						img.alt = emb.path;
					} else if (emb.kind === "video") {
						const v = block.createEl("video");
						v.src = this.vaultResourceUrl(emb.path);
						v.controls = true;
						(v as HTMLVideoElement).playsInline = true;
					} else if (emb.kind === "audio") {
						const a = block.createEl("audio");
						a.src = this.vaultResourceUrl(emb.path);
						a.controls = true;
					}
				}
			};
			paintPreview(ta.value);
			ta.addEventListener("input", () => paintPreview(ta.value));
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
		// Only show mode switch when multiple views exist; a lone「列表」label is noise.
		if (modes.length > 1) {
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
				text: "暂无条目。可用「语音录入」、浮层助手或手机入口创建。",
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
				void this.selectItem(item);
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
				void this.selectItem(item);
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
					void this.selectItem(item);
				});
			}
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

	private vaultResourceUrl(vaultPath: string): string {
		const p = vaultPath.replace(/\\/g, "/");
		try {
			const adapter = this.app.vault.adapter as {
				getResourcePath?: (path: string) => string;
			};
			if (typeof adapter.getResourcePath === "function") {
				return adapter.getResourcePath(p);
			}
		} catch {
			/* ignore */
		}
		return p;
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

function classifyMime(
	mime: string,
	name: string,
): PendingChatFile["kind"] {
	const m = (mime || "").toLowerCase();
	const n = name.toLowerCase();
	if (m.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n)) {
		return "image";
	}
	if (m.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(n)) {
		return "video";
	}
	if (m.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac)$/i.test(n)) {
		return "audio";
	}
	if (
		m.startsWith("text/") ||
		/\.(txt|md|json|csv|log|xml|html?)$/i.test(n)
	) {
		return "text";
	}
	return "other";
}

function guessMimeFromName(name: string): string {
	const n = name.toLowerCase();
	if (/\.png$/i.test(n)) return "image/png";
	if (/\.jpe?g$/i.test(n)) return "image/jpeg";
	if (/\.gif$/i.test(n)) return "image/gif";
	if (/\.webp$/i.test(n)) return "image/webp";
	if (/\.mp4$/i.test(n)) return "video/mp4";
	if (/\.webm$/i.test(n)) return "video/webm";
	if (/\.mp3$/i.test(n)) return "audio/mpeg";
	if (/\.wav$/i.test(n)) return "audio/wav";
	if (/\.pdf$/i.test(n)) return "application/pdf";
	if (/\.json$/i.test(n)) return "application/json";
	if (/\.md$/i.test(n)) return "text/markdown";
	if (/\.txt$/i.test(n)) return "text/plain";
	return "application/octet-stream";
}

function arrayBufferToDataUrl(
	data: ArrayBuffer,
	mime: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const blob = new Blob([data], { type: mime });
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ""));
		reader.onerror = () =>
			reject(reader.error ?? new Error("read dataUrl failed"));
		reader.readAsDataURL(blob);
	});
}

function extractMediaPaths(
	src: string,
): Array<{ path: string; kind: "image" | "video" | "audio" | "other" }> {
	const out: Array<{
		path: string;
		kind: "image" | "video" | "audio" | "other";
	}> = [];
	const seen = new Set<string>();
	const push = (path: string) => {
		const p = path.trim().replace(/\\/g, "/");
		if (!p || seen.has(p)) return;
		seen.add(p);
		out.push({ path: p, kind: mediaKindFromPath(p) });
	};
	// ![[path]]
	for (const m of src.matchAll(/!\[\[([^\]]+)\]\]/g)) {
		push(m[1]!.split("|")[0]!.trim());
	}
	// ![alt](path)
	for (const m of src.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
		push(m[1]!.trim());
	}
	// <video src="..."> / <audio src="...">
	for (const m of src.matchAll(/<(?:video|audio)[^>]+src=["']([^"']+)["']/gi)) {
		push(m[1]!.trim());
	}
	return out;
}

function mediaKindFromPath(
	path: string,
): "image" | "video" | "audio" | "other" {
	const n = path.toLowerCase();
	if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n)) return "image";
	if (/\.(mp4|webm|mov|mkv|avi)$/i.test(n)) return "video";
	if (/\.(mp3|wav|m4a|ogg|flac)$/i.test(n)) return "audio";
	return "other";
}

