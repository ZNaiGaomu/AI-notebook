/**
 * Floating, draggable, resizable chat shell (assistant / feature).
 * Host (NotebookView) supplies data + send handlers via ChatFloatHost.
 */
import { Notice } from "obsidian";
import type { ChatThread } from "../services/chatHistoryStore";
import type { PendingChatFile } from "../services/assistantActions";

export type ChatFloatMode = "assistant" | "feature";
export type SendFollowMode = "queue" | "guide";

export type QueuedSend = {
	id: string;
	mode: ChatFloatMode;
	text: string;
	files: PendingChatFile[];
	follow: SendFollowMode;
};

export type ChatFloatHost = {
	getChatMode: () => ChatFloatMode;
	setChatMode: (mode: ChatFloatMode) => void;
	getFollowMode: () => SendFollowMode;
	setFollowMode: (m: SendFollowMode) => void;
	getAssistantThread: () => ChatThread | null;
	getFeatureThread: () => ChatThread | null;
	getPendingFiles: () => PendingChatFile[];
	setPendingFiles: (files: PendingChatFile[]) => void;
	getBusy: () => boolean;
	getThinking: () => boolean;
	getQueueLength: () => number;
	getPlaceholder: (mode: ChatFloatMode) => string;
	/** Current notebook display name */
	getNotebookLabel: () => string;
	/** Current item title or “未选中条目” */
	getItemLabel: () => string;
	onPickNotebook: () => void;
	onPickItem: () => void;
	onPickFiles: () => Promise<void>;
	/** Drag / paste files into the chat input area */
	onIngestFiles?: (files: File[]) => Promise<void>;
	onOpenHistory: () => void;
	onNewChat: () => void;
	/**
	 * Called after UI already cleared input / showed user bubble intent.
	 * Host should process send (or enqueue).
	 */
	onSubmit: (text: string, files: PendingChatFile[]) => void;
	/** User expanded float from FAB */
	onExpanded?: () => void;
};

const POS_KEY = "ai-notebook-chat-float-pos";

type PosState = {
	left: number;
	top: number;
	width: number;
	height: number;
};

/** Size/position only — collapse is NOT restored (always start collapsed). */
export class ChatFloatPanel {
	private root: HTMLElement | null = null;
	private messagesEl: HTMLElement | null = null;
	private threadTitleEl: HTMLElement | null = null;
	private contextEl: HTMLElement | null = null;
	private attachBar: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private ta: HTMLTextAreaElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private fab: HTMLElement | null = null;
	private collapsed = true;
	private dragging = false;
	private resizing = false;

	constructor(
		private readonly parent: HTMLElement,
		private readonly host: ChatFloatHost,
	) {}

	/** True if panel DOM is already attached. */
	isMounted(): boolean {
		return this.root != null;
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	/**
	 * @param opts.startCollapsed — true: FAB only (first open of notebook).
	 *   false: keep panel expanded after remount (e.g. after picking an item).
	 *   omit: default true only when never mounted this instance.
	 */
	mount(opts?: { startCollapsed?: boolean }): void {
		if (this.root) return;
		const pos = loadPos();
		const startCollapsed = opts?.startCollapsed !== false;

		this.fab = this.parent.createDiv({ cls: "ai-notebook-chat-fab" });
		this.fab.createSpan({ text: "💬 助手" });
		this.fab.addEventListener("click", () => {
			this.setCollapsed(false);
			this.host.onExpanded?.();
		});

		this.root = this.parent.createDiv({ cls: "ai-notebook-chat-float" });
		this.root.style.left = `${pos.left}px`;
		this.root.style.top = `${pos.top}px`;
		this.root.style.width = `${pos.width}px`;
		this.root.style.height = `${pos.height}px`;

		// title bar
		const titleBar = this.root.createDiv({
			cls: "ai-notebook-chat-float-titlebar",
		});
		titleBar.createSpan({
			cls: "ai-notebook-chat-float-title",
			text: "AI 对话",
		});
		const titleActions = titleBar.createDiv({
			cls: "ai-notebook-chat-float-title-actions",
		});
		const minBtn = titleActions.createEl("button", { text: "—" });
		minBtn.title = "收起";
		minBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.setCollapsed(true);
		});
		const closeBtn = titleActions.createEl("button", { text: "×" });
		closeBtn.title = "收起为按钮";
		closeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.setCollapsed(true);
		});

		this.enableDrag(titleBar);

		// mode bar
		const modeBar = this.root.createDiv({ cls: "ai-notebook-chat-modebar" });
		const assistantBtn = modeBar.createEl("button", { text: "助手" });
		const featureBtn = modeBar.createEl("button", { text: "改功能" });
		const historyBtn = modeBar.createEl("button", { text: "历史" });
		const newChatBtn = modeBar.createEl("button", { text: "新对话" });
		assistantBtn.addEventListener("click", () => {
			this.host.setChatMode("assistant");
			this.paint();
		});
		featureBtn.addEventListener("click", () => {
			this.host.setChatMode("feature");
			this.paint();
		});
		historyBtn.addEventListener("click", () => this.host.onOpenHistory());
		newChatBtn.addEventListener("click", () => {
			this.host.onNewChat();
			this.paint();
		});

		this.contextEl = this.root.createDiv({
			cls: "ai-notebook-chat-context",
		});

		this.threadTitleEl = this.root.createDiv({
			cls: "ai-notebook-chat-thread-title",
		});
		this.messagesEl = this.root.createDiv({
			cls: "ai-notebook-chat-messages ai-notebook-chat-float-messages",
		});
		this.statusEl = this.root.createDiv({ cls: "ai-notebook-chat-status" });

		this.attachBar = this.root.createDiv({
			cls: "ai-notebook-chat-attach-bar",
		});

		const followRow = this.root.createDiv({
			cls: "ai-notebook-chat-follow-row",
		});
		followRow.createSpan({ text: "追加：" });
		const queueBtn = followRow.createEl("button", { text: "排队" });
		const guideBtn = followRow.createEl("button", { text: "引导" });
		queueBtn.addEventListener("click", () => {
			this.host.setFollowMode("queue");
			this.paintFollow(queueBtn, guideBtn);
		});
		guideBtn.addEventListener("click", () => {
			this.host.setFollowMode("guide");
			this.paintFollow(queueBtn, guideBtn);
		});
		this.paintFollow(queueBtn, guideBtn);

		const inputRow = this.root.createDiv({
			cls: "ai-notebook-chat-input-row",
		});
		const uploadBtn = inputRow.createEl("button", { text: "上传" });
		uploadBtn.title = "上传图片 / 视频 / 文件";
		uploadBtn.addEventListener("click", () => {
			void this.host.onPickFiles().then(() => this.paint());
		});
		this.ta = inputRow.createEl("textarea");
		this.ta.rows = 3;
		this.ta.placeholder =
			"写下你想记录的内容…（可拖入文件 / Ctrl+V 粘贴截图）";
		const sendBtn = inputRow.createEl("button", { text: "发送" });
		sendBtn.addClass("mod-cta");

		// Drag & drop files onto input row / textarea
		const dropTargets: HTMLElement[] = [inputRow, this.ta];
		for (const el of dropTargets) {
			el.addEventListener("dragover", (e) => {
				e.preventDefault();
				e.stopPropagation();
				inputRow.addClass("is-drop-target");
			});
			el.addEventListener("dragleave", () => {
				inputRow.removeClass("is-drop-target");
			});
			el.addEventListener("drop", (e) => {
				e.preventDefault();
				e.stopPropagation();
				inputRow.removeClass("is-drop-target");
				const list = e.dataTransfer?.files;
				if (!list?.length || !this.host.onIngestFiles) return;
				void this.host
					.onIngestFiles(Array.from(list))
					.then(() => this.paint());
			});
		}
		// Paste screenshot / clipboard image
		this.ta.addEventListener("paste", (e) => {
			const items = e.clipboardData?.items;
			if (!items || !this.host.onIngestFiles) return;
			const files: File[] = [];
			for (let i = 0; i < items.length; i++) {
				const it = items[i]!;
				if (it.kind === "file") {
					const f = it.getAsFile();
					if (f) files.push(f);
				}
			}
			if (!files.length) return;
			e.preventDefault();
			void this.host.onIngestFiles(files).then(() => this.paint());
		});

		const doSend = () => {
			if (!this.ta) return;
			const text = this.ta.value.trim();
			const files = this.host.getPendingFiles();
			const mode = this.host.getChatMode();
			if (!text && !(mode === "assistant" && files.length)) return;
			this.ta.value = "";
			const snapFiles = [...files];
			if (mode === "assistant") {
				this.host.setPendingFiles([]);
			}
			this.host.onSubmit(text || "（见上传附件）", snapFiles);
			this.paint();
		};
		sendBtn.addEventListener("click", doSend);
		this.ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				doSend();
			}
		});

		const resize = this.root.createDiv({
			cls: "ai-notebook-chat-float-resize",
		});
		this.enableResize(resize);

		(
			this.root as HTMLElement & {
				_assistantBtn?: HTMLButtonElement;
				_featureBtn?: HTMLButtonElement;
				_uploadBtn?: HTMLButtonElement;
			}
		)._assistantBtn = assistantBtn;
		(
			this.root as HTMLElement & { _featureBtn?: HTMLButtonElement }
		)._featureBtn = featureBtn;
		(
			this.root as HTMLElement & { _uploadBtn?: HTMLButtonElement }
		)._uploadBtn = uploadBtn;

		// First open of a notebook: collapsed. Remount after item pick: stay open.
		this.setCollapsed(startCollapsed);
		this.paint();
	}

	destroy(): void {
		this.persistPos();
		this.root?.remove();
		this.fab?.remove();
		this.root = null;
		this.fab = null;
	}

	paint(): void {
		if (!this.root || !this.messagesEl || !this.threadTitleEl || !this.ta) {
			return;
		}
		const mode = this.host.getChatMode();
		const r = this.root as HTMLElement & {
			_assistantBtn?: HTMLButtonElement;
			_featureBtn?: HTMLButtonElement;
			_uploadBtn?: HTMLButtonElement;
		};
		r._assistantBtn?.toggleClass("mod-cta", mode === "assistant");
		r._featureBtn?.toggleClass("mod-cta", mode === "feature");
		if (r._uploadBtn) {
			r._uploadBtn.style.display = mode === "assistant" ? "" : "none";
		}
		this.ta.placeholder = this.host.getPlaceholder(mode);

		// context row
		if (this.contextEl) {
			this.contextEl.empty();
			const nb = this.contextEl.createDiv({
				cls: "ai-notebook-chat-context-row",
			});
			nb.createSpan({
				cls: "ai-notebook-chat-context-label",
				text: "记录本",
			});
			const nbBtn = nb.createEl("button", {
				text: this.host.getNotebookLabel(),
			});
			nbBtn.title = "切换记录本（与主界面同步）";
			nbBtn.addEventListener("click", () => this.host.onPickNotebook());

			const it = this.contextEl.createDiv({
				cls: "ai-notebook-chat-context-row",
			});
			it.createSpan({
				cls: "ai-notebook-chat-context-label",
				text: mode === "feature" ? "范围" : "条目",
			});
			if (mode === "feature") {
				it.createSpan({
					cls: "ai-notebook-chat-context-value",
					text: "整个记录本（功能蓝图）",
				});
			} else {
				const itBtn = it.createEl("button", {
					text: this.host.getItemLabel(),
				});
				itBtn.title = "选择条目（与主界面同步）";
				itBtn.addEventListener("click", () => this.host.onPickItem());
			}
		}

		const thread =
			mode === "feature"
				? this.host.getFeatureThread()
				: this.host.getAssistantThread();
		this.threadTitleEl.setText(
			thread
				? `对话：${thread.title}（${thread.messages.length} 条）`
				: "对话：新会话",
		);

		this.messagesEl.empty();
		if (!thread || thread.messages.length === 0) {
			this.messagesEl.createDiv({
				cls: "ai-notebook-empty",
				text:
					mode === "feature"
						? "改功能对话会出现在这里。"
						: "助手对话会出现在这里。发送后立即显示，可继续排队或引导。",
			});
		} else {
			for (const m of thread.messages) {
				const bubble = this.messagesEl.createDiv({
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
		}

		if (this.host.getThinking()) {
			const think = this.messagesEl.createDiv({
				cls: "ai-notebook-chat-bubble system ai-notebook-chat-thinking",
			});
			think.createDiv({
				cls: "ai-notebook-chat-bubble-role",
				text: "AI",
			});
			think.createDiv({
				cls: "ai-notebook-chat-bubble-body",
				text: "思考中…",
			});
		}
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

		if (this.statusEl) {
			const q = this.host.getQueueLength();
			const busy = this.host.getBusy();
			const follow = this.host.getFollowMode();
			const parts: string[] = [];
			if (busy || this.host.getThinking()) parts.push("处理中");
			if (q > 0) parts.push(`队列 ${q} 条`);
			parts.push(follow === "queue" ? "追加=排队" : "追加=引导");
			this.statusEl.setText(parts.join(" · "));
		}

		// attachments
		if (this.attachBar) {
			this.attachBar.empty();
			if (mode !== "assistant") {
				this.attachBar.hide();
			} else {
				this.attachBar.show();
				const files = this.host.getPendingFiles();
				if (!files.length) {
					this.attachBar.createSpan({
						cls: "ai-notebook-chat-attach-empty",
						text: "附件：无（默认仅参考；说「进正文」才嵌入）",
					});
				} else {
					for (const f of files) {
						const chip = this.attachBar.createDiv({
							cls: "ai-notebook-chat-attach-chip",
						});
						chip.createSpan({
							text: `${f.kind === "image" ? "🖼" : f.kind === "video" ? "🎬" : "📎"} ${f.name}`,
						});
						const rm = chip.createEl("button", { text: "×" });
						rm.addEventListener("click", () => {
							this.host.setPendingFiles(
								this.host.getPendingFiles().filter((x) => x.id !== f.id),
							);
							this.paint();
						});
					}
				}
			}
		}
	}

	setCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
		if (this.root) {
			this.root.toggleClass("is-collapsed", collapsed);
			this.root.style.display = collapsed ? "none" : "flex";
		}
		if (this.fab) {
			this.fab.style.display = collapsed ? "flex" : "none";
		}
		this.persistPos();
	}

	private paintFollow(
		queueBtn: HTMLButtonElement,
		guideBtn: HTMLButtonElement,
	): void {
		const m = this.host.getFollowMode();
		queueBtn.toggleClass("mod-cta", m === "queue");
		guideBtn.toggleClass("mod-cta", m === "guide");
	}

	private enableDrag(handle: HTMLElement): void {
		let startX = 0;
		let startY = 0;
		let origL = 0;
		let origT = 0;
		handle.addEventListener("mousedown", (e) => {
			if (!this.root || (e.target as HTMLElement).tagName === "BUTTON") {
				return;
			}
			this.dragging = true;
			startX = e.clientX;
			startY = e.clientY;
			origL = this.root.offsetLeft;
			origT = this.root.offsetTop;
			e.preventDefault();
		});
		window.addEventListener("mousemove", (e) => {
			if (!this.dragging || !this.root) return;
			const nl = Math.max(0, origL + e.clientX - startX);
			const nt = Math.max(0, origT + e.clientY - startY);
			this.root.style.left = `${nl}px`;
			this.root.style.top = `${nt}px`;
		});
		window.addEventListener("mouseup", () => {
			if (this.dragging) {
				this.dragging = false;
				this.persistPos();
			}
		});
	}

	private enableResize(handle: HTMLElement): void {
		let startX = 0;
		let startY = 0;
		let origW = 0;
		let origH = 0;
		handle.addEventListener("mousedown", (e) => {
			if (!this.root) return;
			this.resizing = true;
			startX = e.clientX;
			startY = e.clientY;
			origW = this.root.offsetWidth;
			origH = this.root.offsetHeight;
			e.preventDefault();
			e.stopPropagation();
		});
		window.addEventListener("mousemove", (e) => {
			if (!this.resizing || !this.root) return;
			const nw = Math.max(320, origW + e.clientX - startX);
			const nh = Math.max(280, origH + e.clientY - startY);
			this.root.style.width = `${nw}px`;
			this.root.style.height = `${nh}px`;
		});
		window.addEventListener("mouseup", () => {
			if (this.resizing) {
				this.resizing = false;
				this.persistPos();
			}
		});
	}

	private persistPos(): void {
		if (!this.root) return;
		// When collapsed, root is display:none — offsetWidth/Height may be 0.
		// Prefer last saved size if current is invalid.
		const prev = loadPos();
		const w = this.root.offsetWidth;
		const h = this.root.offsetHeight;
		const state: PosState = {
			left: this.root.offsetLeft || prev.left,
			top: this.root.offsetTop || prev.top,
			width: w >= 320 ? w : prev.width,
			height: h >= 280 ? h : prev.height,
		};
		try {
			localStorage.setItem(POS_KEY, JSON.stringify(state));
		} catch {
			/* ignore */
		}
	}
}

function loadPos(): PosState {
	const def: PosState = {
		left: Math.max(40, window.innerWidth - 440),
		top: Math.max(40, window.innerHeight - 520),
		width: 420,
		height: 520,
	};
	try {
		const raw = localStorage.getItem(POS_KEY);
		if (!raw) return def;
		const o = JSON.parse(raw) as Partial<PosState> & { collapsed?: boolean };
		return {
			left: typeof o.left === "number" ? o.left : def.left,
			top: typeof o.top === "number" ? o.top : def.top,
			width:
				typeof o.width === "number" && o.width >= 320 ? o.width : def.width,
			height:
				typeof o.height === "number" && o.height >= 280
					? o.height
					: def.height,
		};
	} catch {
		return def;
	}
}

/** Avoid unused import lint in some setups */
void Notice;
