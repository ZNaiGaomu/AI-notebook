import {
	MarkdownRenderChild,
	Notice,
	Platform,
	Plugin,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import type { AiNotebookSettings, NotebookMeta } from "./domain/types";
import {
	createDefaultSettings,
	normalizeSettings,
} from "./domain/settingsDefaults";
import { VaultIo } from "./infra/vaultIo";
import { AiGateway } from "./infra/aiGateway";
import { VersionService } from "./services/versionService";
import { NotebookService } from "./services/notebookService";
import { ItemService } from "./services/itemService";
import { FeatureOrchestrator } from "./services/featureOrchestrator";
import {
	resolveProvider,
	resolveProviderChain,
} from "./services/providerResolver";
import { CabinetService } from "./services/cabinetService";
import { AttachmentService } from "./services/attachmentService";
import { VoiceService } from "./services/voiceService";
import { VoicePipeline } from "./services/voicePipeline";
import {
	retranscribeVaultAudio,
	extractAudioVaultPath,
} from "./services/voiceRetranscribe";
import { VoiceDiagnostics } from "./services/voiceDiagnostics";
import { OrganizeService } from "./services/organizeService";
import { InboxService } from "./services/inboxService";
import { MobileBridgeServer } from "./bridge/mobileBridgeServer";
import { PublicTunnel } from "./bridge/publicTunnel";
import { CapabilityRuntime } from "./runtime/capabilityRuntime";
import { HookRunner } from "./services/hookRunner";
import { AiNotebookSettingTab } from "./ui/settingsTab";
import {
	NotebookView,
	VIEW_TYPE_AI_NOTEBOOK,
} from "./ui/notebookView";
import { CreateNotebookModal } from "./ui/createNotebookModal";
import { PickNotebookModal } from "./ui/pickNotebookModal";
import { BridgeLinkModal } from "./ui/bridgeLinkModal";
import { UserConfigStore } from "./infra/userConfigStore";
import { ChatHistoryStore } from "./services/chatHistoryStore";
import {
	itemDisplayName,
	itemDisplayNameFromPath,
} from "./services/itemDisplayName";
import { syncPluginHistoryOnLoad } from "./services/pluginHistoryStore";
import { PluginPackageArchive } from "./services/pluginPackageArchive";

export default class AiNotebookPlugin extends Plugin {
	settings: AiNotebookSettings = createDefaultSettings();

	vaultIo!: VaultIo;
	versions!: VersionService;
	notebooks!: NotebookService;
	items!: ItemService;
	runtime!: CapabilityRuntime;
	gateway!: AiGateway;
	features!: FeatureOrchestrator;
	hooks!: HookRunner;
	cabinet!: CabinetService;
	attachments!: AttachmentService;
	voice!: VoiceService;
	voicePipeline!: VoicePipeline;
	organize!: OrganizeService;
	inbox!: InboxService;
	bridge!: MobileBridgeServer;
	publicTunnel!: PublicTunnel;
	userConfig!: UserConfigStore;
	chatHistory!: ChatHistoryStore;
	packageArchive!: PluginPackageArchive;

	async onload(): Promise<void> {
		this.userConfig = new UserConfigStore(this.app);
		this.chatHistory = new ChatHistoryStore(this.app);
		await this.loadSettings();
		{
			const synced = syncPluginHistoryOnLoad(this.settings);
			this.settings = synced.settings;
			await this.saveSettings();
		}

		this.packageArchive = new PluginPackageArchive(this);
		// Auto-backup only when this version has no local snapshot yet (avoid redundant rewrites).
		void this.packageArchive.archiveCurrentPackageIfNeeded().catch(() => undefined);

		this.vaultIo = new VaultIo(this.app);
		this.versions = new VersionService(this.vaultIo, () => this.settings);
		this.notebooks = new NotebookService(
			this.vaultIo,
			this.versions,
			() => this.settings,
		);
		this.items = new ItemService(
			this.vaultIo,
			this.versions,
			() => this.settings,
		);
		this.cabinet = new CabinetService(this.vaultIo, () => this.settings);
		this.attachments = new AttachmentService(this.vaultIo, () => this.settings);
		this.voice = new VoiceService();
		this.runtime = new CapabilityRuntime();
		this.gateway = new AiGateway();
		this.voicePipeline = new VoicePipeline(
			this.vaultIo,
			this.voice,
			this.gateway,
			() => this.settings,
			(purpose, notebook) =>
				resolveProviderChain(this.settings, purpose, notebook),
		);
		this.features = new FeatureOrchestrator(
			this.gateway,
			this.versions,
			() => this.settings,
			(purpose) => resolveProvider(this.settings, purpose, null),
		);
		this.organize = new OrganizeService(
			this.gateway,
			this.versions,
			this.items,
			() => this.settings,
			(notebook) => resolveProvider(this.settings, "worker", notebook),
		);
		this.hooks = new HookRunner({
			cabinet: this.cabinet,
			items: this.items,
			organize: this.organize,
			notify: (message) => new Notice(message),
		});
		// Avoid circular ctor: hooks uses organize; organize optionally runs hooks after create.
		this.organize.hooks = this.hooks;
		this.inbox = new InboxService(
			this.vaultIo,
			this.notebooks,
			this.organize,
			() => this.settings,
		);
		this.inbox.attachments = this.attachments;
		this.inbox.items = this.items;
		this.bridge = new MobileBridgeServer({
			getSettings: () => this.settings,
			saveSettings: async (s) => {
				this.settings = s;
				await this.saveSettings();
			},
			resolveTargetNotebook: () => this.inbox.resolveTargetNotebook(),
			listNotebooks: () => this.notebooks.listNotebooks(),
			findNotebookById: (id) => this.notebooks.findById(id),
			createNotebook: async ({ name, templateId }) => {
				const meta = await this.notebooks.createNotebook({ name, templateId });
				this.settings = {
					...this.settings,
					inbox: {
						...this.settings.inbox,
						defaultNotebookId: meta.notebook_id,
					},
					ui: {
						...this.settings.ui,
						lastNotebookId: meta.notebook_id,
					},
				};
				await this.saveSettings();
				new Notice(`手机新建记录本：${meta.name}`);
				const leaves = this.app.workspace.getLeavesOfType(
					VIEW_TYPE_AI_NOTEBOOK,
				);
				const view = leaves[0]?.view;
				if (view instanceof NotebookView) {
					void view.reload();
				}
				return meta;
			},
			resolveNotebookById: async (id) => {
				if (id) {
					const found = await this.notebooks.findById(id);
					if (found) return found;
				}
				return this.inbox.resolveTargetNotebook();
			},
			setDefaultNotebookId: async (id) => {
				this.settings = {
					...this.settings,
					inbox: {
						...this.settings.inbox,
						defaultNotebookId: id,
					},
					ui: {
						...this.settings.ui,
						lastNotebookId: id ?? this.settings.ui.lastNotebookId,
					},
				};
				await this.saveSettings();
			},
			resolveVoice: (notebook) =>
					resolveProvider(this.settings, "voice", notebook, { stt: true }),
				resolveVoiceChain: (notebook) =>
					resolveProviderChain(this.settings, "voice", notebook, {
						stt: true,
					}).map((r) => ({
						profile: r.profile,
						model: r.model,
						slotIndex: r.slotIndex,
					})),
				voicePipeline: this.voicePipeline,
				inbox: this.inbox,
			organize: this.organize,
			voice: this.voice,
			items: this.items,
			cabinet: this.cabinet,
			attachments: this.attachments,
			onNoteWritten: (info) => {
				new Notice(`手机写入：${info.title}`);
				const leaves = this.app.workspace.getLeavesOfType(
					VIEW_TYPE_AI_NOTEBOOK,
				);
				const view = leaves[0]?.view;
				if (view instanceof NotebookView) {
					void view.reload();
				}
			},
		});
		this.publicTunnel = new PublicTunnel();

		this.registerAttachmentPasteWatcher();
			this.registerVoiceRetranscribeInReadingView();

		this.registerView(
			VIEW_TYPE_AI_NOTEBOOK,
			(leaf) => new NotebookView(leaf, this),
		);

		this.addRibbonIcon("notebook-pen", "AI 记录本", () => {
			void this.openLastOrPick();
		});

		this.addCommand({
			id: "open-ai-notebook",
			name: "打开 AI 记录本",
			callback: () => {
				void this.openLastOrPick();
			},
		});

		this.addCommand({
			id: "create-ai-notebook",
			name: "新建记录本",
			callback: () => {
				new CreateNotebookModal(this.app, this, () => undefined).open();
			},
		});

		this.addCommand({
			id: "pick-ai-notebook",
			name: "选择并打开记录本",
			callback: () => {
				void new PickNotebookModal(this.app, this).openAndLoad();
			},
		});

		this.addCommand({
			id: "modify-features-by-description",
			name: "用语言改功能",
			callback: () => {
				void this.runFeatureEditCommand();
			},
		});

		this.addCommand({
			id: "mobile-dump-inbox",
			name: "手机速记（写入收件箱）",
			callback: () => {
				void this.mobileDumpInbox();
			},
		});

		this.addCommand({
			id: "process-inbox-ai",
			name: "处理收件箱（AI 整理）",
			callback: () => {
				void this.processInboxAll();
			},
		});

		this.addCommand({
			id: "ensure-inbox-folders",
			name: "初始化手机收件箱文件夹",
			callback: () => {
				void this.inbox.ensureStructure().then(() => {
					new Notice("收件箱已创建：AI Inbox/pending");
				});
			},
		});

		this.addCommand({
			id: "ai-organize-current-item",
			name: "AI 整理当前条目",
			callback: () => {
				void this.organizeActiveItem();
			},
		});

		this.addCommand({
			id: "voice-capture-ai-notebook",
			name: "语音录入到记录本",
			callback: () => {
				void this.voiceCaptureCommand();
			},
		});

		this.addCommand({
			id: "diagnose-voice-transcription",
			name: "诊断语音转写能力",
			callback: () => {
				void this.diagnoseVoice();
			},
		});


		this.addCommand({
			id: "show-mobile-web-link",
			name: "显示手机网页入口链接",
			callback: () => {
				void this.showMobileBridgeLink();
			},
		});

		this.addCommand({
			id: "start-mobile-web-bridge",
			name: "启动手机网页入口",
			callback: () => {
				void this.startMobileBridge();
			},
		});

		this.addCommand({
			id: "stop-mobile-web-bridge",
			name: "停止手机网页入口",
			callback: () => {
				void this.stopMobileBridgeAll().then(() =>
					new Notice("手机网页入口已停止"),
				);
			},
		});

		this.addCommand({
			id: "create-public-mobile-link",
			name: "生成任意网络可打开的手机链接",
			callback: () => {
				void this.createPublicMobileLink();
			},
		});


		// Keep notebook display name in sync when user renames folder in file explorer
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				void this.onVaultPathRenamed(file.path, oldPath);
			}),
		);

this.addSettingTab(new AiNotebookSettingTab(this.app, this));

		// Ensure mobile drop folder exists on load (non-blocking)
		void this.inbox.ensureStructure().catch(() => undefined);

		if (
			Platform.isDesktopApp &&
			this.settings.bridge.enabled &&
			this.settings.bridge.autoStart
		) {
			void this.startMobileBridge().catch(() => undefined);
		}
	}

	private async onVaultPathRenamed(
		newPath: string,
		oldPath: string,
	): Promise<void> {
		const rootRaw = this.settings.paths.notebooksRoot || "AI Notebooks";
		const root = rootRaw.replace(/\\/g, "/").replace(/\/+$/, "");
		const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
		const op = norm(oldPath);
		const np = norm(newPath);
		const prefix = root + "/";
		if (!op.startsWith(prefix) || !np.startsWith(prefix)) return;
		const oldParts = op.slice(prefix.length).split("/").filter(Boolean);
		const newParts = np.slice(prefix.length).split("/").filter(Boolean);
		const oldFolder = oldParts[0] || "";
		const newFolder = newParts[0] || "";
		if (!oldFolder || !newFolder) return;

		// Same notebook: handle items/*.md renames so managed attachments follow.
		if (oldFolder === newFolder) {
			const isItemMarkdownRename =
				oldParts[1] === "items" &&
				newParts[1] === "items" &&
				oldParts.length === 3 &&
				newParts.length === 3 &&
				Boolean(oldParts[2]?.toLowerCase().endsWith(".md")) &&
				Boolean(newParts[2]?.toLowerCase().endsWith(".md")) &&
				oldParts[2] !== newParts[2];
			if (isItemMarkdownRename) {
				await this.syncAfterItemFileRename(newFolder, np, op);
			}
			return;
		}

		// Notebook folder rename: top-level segment under notebooks root changed
		const meta = await this.notebooks.syncAfterFolderRename(
			oldFolder,
			newFolder,
		);
		if (!meta) {
			await this.notebooks.alignNameToFolder(newFolder);
		}
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_NOTEBOOK);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof NotebookView) {
				await view.reload();
			}
		}
	}

	/** Move managed attachments and rewrite embeds when an items/*.md file is renamed. */
	private async syncAfterItemFileRename(
		notebookFolder: string,
		itemPath: string,
		oldItemPath: string,
	): Promise<void> {
		try {
			const notebooks = await this.notebooks.listNotebooks();
			const meta =
				notebooks.find((n) => n.folderName === notebookFolder) ??
				(await this.notebooks.readMeta(notebookFolder).catch(() => null));
			if (!meta) return;
			const items = await this.items.listItems(meta);
			const item = items.find((it) => {
				const a = it.path.replace(/\\/g, "/");
				const b = itemPath.replace(/\\/g, "/");
				return a === b;
			});
			if (!item) return;
			const oldItemLabel = itemDisplayNameFromPath(oldItemPath);
			const { syncAllItemFolderLayouts, applyPathRewrites } = await import(
				"./services/itemFolderSync"
			);
			const { rewrites } = await syncAllItemFolderLayouts({
				vault: this.vaultIo,
				settings: this.settings,
				meta,
				item,
				oldItemLabel,
				attachments: this.attachments,
				cabinet: this.cabinet,
			});
			if (rewrites.length) {
				const body = applyPathRewrites(
					this.attachments.rewriteEmbedPaths(item.body, rewrites),
					rewrites,
				);
				const currentAudioPath = String(item.frontmatter.audio_path ?? "");
				const rewrittenAudioPath = rewrites.reduce(
					(path, rewrite) => (path === rewrite.from ? rewrite.to : path),
					currentAudioPath,
				);
				if (body !== item.body || rewrittenAudioPath !== currentAudioPath) {
					await this.items.updateItem(item, {
						body,
						...(rewrittenAudioPath !== currentAudioPath
							? { fields: { audio_path: rewrittenAudioPath } }
							: {}),
					});
				}
				// Chat history attachment paths (assistant uploads under chat-uploads).
				try {
					const threads = await this.chatHistory.loadAll();
					let changed = false;
					const next = threads.map((t) => {
						if (t.notebookId !== meta.notebook_id) return t;
						const messages = t.messages.map((m) => {
							if (!m.attachments?.length) return m;
							const attachments = m.attachments.map((a) => {
								const vaultPath = applyPathRewrites(a.vaultPath, rewrites);
								if (vaultPath !== a.vaultPath) changed = true;
								return vaultPath === a.vaultPath ? a : { ...a, vaultPath };
							});
							return { ...m, attachments };
						});
						const itemTitle =
							t.itemId === item.frontmatter.item_id
								? itemDisplayName(item)
								: t.itemTitle;
						if (itemTitle !== t.itemTitle) changed = true;
						return { ...t, messages, itemTitle };
					});
					if (changed) await this.chatHistory.saveAll(next);
				} catch {
					/* best-effort */
				}
			}
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_NOTEBOOK);
			for (const leaf of leaves) {
				const view = leaf.view;
				if (view instanceof NotebookView) {
					await view.reload();
				}
			}
		} catch {
			// Best-effort; do not block Obsidian rename UX.
		}
	}

	/** Resolve provider with optional notebook overrides. */
	resolveAi(
		purpose: "planner" | "worker" | "voice",
		notebook?: NotebookMeta | null,
	) {
		return resolveProvider(this.settings, purpose, notebook);
	}


	/**
	 * Reading view enhancer. Scoped to each Markdown render root and idempotent by
	 * normalized audio path. No document-wide polling.
	 */
	private registerVoiceRetranscribeInReadingView(): void {
		// Remove leftovers from the old polling implementation on plugin reload.
		document
			.querySelectorAll(".ai-notebook-voice-actions")
			.forEach((node) => node.remove());

		this.registerMarkdownPostProcessor((el, ctx) => {
			const child = new MarkdownRenderChild(el);
			ctx.addChild(child);
			let frame = 0;
			let stopped = false;

			const schedule = () => {
				if (stopped || frame) return;
				frame = window.requestAnimationFrame(() => {
					frame = 0;
					this.decorateVoiceRetranscribeRoot(el);
				});
			};

			const observer = new MutationObserver(() => schedule());
			observer.observe(el, { childList: true, subtree: true });
			child.register(() => {
				stopped = true;
				observer.disconnect();
				if (frame) window.cancelAnimationFrame(frame);
			});
			schedule();
		});
	}

	private decorateVoiceRetranscribeRoot(root: HTMLElement): void {
		// Delete leftovers created by the previous polling version in this root.
		root
			.querySelectorAll(
				".ai-notebook-voice-actions:not(.ai-notebook-retranscribe-control)",
			)
			.forEach((node) => node.remove());

		const seen = new Set<string>();
		for (const audio of Array.from(root.querySelectorAll("audio"))) {
			const path = extractAudioVaultPath(audio as HTMLElement);
			if (!path || seen.has(path)) continue;
			seen.add(path);

			const escapedPath = this.escapeCssAttribute(path);
			const existing = Array.from(
				root.querySelectorAll<HTMLElement>(
					`.ai-notebook-retranscribe-control[data-audio-path="${escapedPath}"]`,
				),
			);
			if (existing.length > 0) {
				// Self-heal duplicates, preserving the first control.
				existing.slice(1).forEach((node) => node.remove());
				continue;
			}

			const control = document.createElement("div");
			control.className =
				"ai-notebook-voice-actions ai-notebook-retranscribe-control";
			control.dataset.audioPath = path;
			const button = document.createElement("button");
			button.type = "button";
			button.className = "ai-notebook-retranscribe-btn";
			button.textContent = "再转写";
			const status = document.createElement("span");
			status.className = "ai-notebook-retranscribe-status";
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (button.disabled) return;
				button.disabled = true;
				control.classList.add("is-busy");
				button.textContent = "转写中…";
				status.textContent = "正在读取录音";
				void retranscribeVaultAudio(
					{
						app: this.app,
						voicePipeline: this.voicePipeline,
						items: this.items,
						notebooks: this.notebooks,
						onProgress: (message) => {
							status.textContent = message.replace(/^再转写\s*·\s*/, "");
						},
						onDone: (ok, message) => {
							status.textContent = message;
							control.classList.toggle("is-success", ok);
							control.classList.toggle("is-error", !ok);
						},
					},
					{ vaultPath: path },
				).finally(() => {
					button.disabled = false;
					control.classList.remove("is-busy");
					button.textContent = "再转写";
				});
			});
			control.append(button, status);

			const anchor =
				(audio.closest(
					".internal-embed, .media-embed, span.internal-embed",
				) as HTMLElement | null) || audio;
			anchor.insertAdjacentElement("afterend", control);
		}

		// Remove controls whose corresponding audio no longer exists in this root.
		for (const control of Array.from(
			root.querySelectorAll<HTMLElement>(
				".ai-notebook-retranscribe-control[data-audio-path]",
			),
		)) {
			const path = control.dataset.audioPath || "";
			if (!seen.has(path)) control.remove();
		}
	}

	private escapeCssAttribute(value: string): string {
		if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
			return CSS.escape(value);
		}
		return value.replace(/["\\]/g, "\\$&");
	}

	onunload(): void {
		void this.stopMobileBridgeAll();
		this.runtime.clear();
	}

	private bridgeStatusExtra() {
		const live = this.publicTunnel.getPublicBaseUrl();
		const manual = this.settings.bridge.publicBaseUrl || "";
		return {
			publicBaseUrl: live || manual || null,
		};
	}

	async stopMobileBridgeAll(): Promise<void> {
		await this.publicTunnel.stop();
		await this.bridge.stop();
	}

	async startMobileBridge(): Promise<void> {
		if (!Platform.isDesktopApp) {
			new Notice("手机网页入口仅在电脑端 Obsidian 提供");
			return;
		}
		if (!this.settings.bridge.enabled) {
			new Notice("请先在设置中启用「手机网页入口」");
			return;
		}
		try {
			const status = await this.bridge.start();
			const full = this.bridge.getStatus(this.bridgeStatusExtra());
			const best =
				full.publicUrls[0] ||
				full.urls.find((u) => !u.includes("127.0.0.1")) ||
				`端口 ${status.port}`;
			new Notice(`手机入口已开：${best}`);
		} catch (e) {
			new Notice(
				`启动失败: ${e instanceof Error ? e.message : String(e)}（端口可能被占用）`,
			);
		}
	}

	async createPublicMobileLink(): Promise<void> {
		if (!Platform.isDesktopApp) {
			new Notice("请在电脑端操作");
			return;
		}
		new Notice("正在生成任意网络可访问链接…");
		const status = await this.ensurePublicBridge();
		if (status.publicUrls[0]) {
			await navigator.clipboard.writeText(status.publicUrls[0]);
			new Notice(`已复制公网链接：${status.publicUrls[0]}`);
		} else {
			new Notice(
				status.tunnelHint ||
					"未能生成公网链接，请安装 cloudflared 或配置 ngrok",
			);
		}
		new BridgeLinkModal(this.app, status, this.bridgeModalHandlers()).open();
	}

	private bridgeModalHandlers() {
		return {
			onStartLocal: async () => {
				await this.bridge.start();
				return this.bridge.getStatus(this.bridgeStatusExtra());
			},
			onStartPublic: async () => this.ensurePublicBridge(),
			onStop: async () => {
				await this.stopMobileBridgeAll();
				return this.bridge.getStatus(this.bridgeStatusExtra());
			},
			onRefresh: () => this.bridge.getStatus(this.bridgeStatusExtra()),
			onSavePublicBase: async (url: string) => {
				const result = this.publicTunnel.setManualPublicBase(url);
				if (!result.ok) {
					new Notice(result.error);
					return this.bridge.getStatus(this.bridgeStatusExtra());
				}
				this.settings = {
					...this.settings,
					bridge: {
						...this.settings.bridge,
						publicBaseUrl: result.publicBaseUrl,
					},
				};
				await this.saveSettings();
				if (!this.bridge.isRunning()) {
					await this.bridge.start();
				}
				return this.bridge.getStatus({
					publicBaseUrl: result.publicBaseUrl,
				});
			},
		};
	}

	/**
	 * Local HTTP + public tunnel (cloudflared) or saved publicBaseUrl.
	 */
	async ensurePublicBridge(): Promise<
		ReturnType<MobileBridgeServer["getStatus"]>
	> {
		await this.bridge.start();
		const port = this.settings.bridge.port || 27124;

		// Already have live tunnel
		const existing = this.publicTunnel.getPublicBaseUrl();
		if (existing) {
			return this.bridge.getStatus({ publicBaseUrl: existing });
		}

		// Manual URL saved in settings
		if (this.settings.bridge.publicBaseUrl.trim()) {
			return this.bridge.getStatus({
				publicBaseUrl: this.settings.bridge.publicBaseUrl.trim(),
			});
		}

		if (!this.settings.bridge.preferPublicTunnel) {
			return this.bridge.getStatus({
				tunnelHint:
					"已关闭自动公网隧道。请在设置填写「公网地址」，或开启 preferPublicTunnel。",
			});
		}

		const tun = await this.publicTunnel.startCloudflared(
			port,
			this.settings.bridge.cloudflaredPath || undefined,
		);
		if (tun.ok) {
			// persist last successful base for display (optional)
			this.settings = {
				...this.settings,
				bridge: {
					...this.settings.bridge,
					publicBaseUrl: tun.publicBaseUrl,
				},
			};
			await this.saveSettings();
			return this.bridge.getStatus({ publicBaseUrl: tun.publicBaseUrl });
		}
		return this.bridge.getStatus({
			tunnelHint: `${tun.error}\n\n${tun.hint || ""}`,
		});
	}

	async showMobileBridgeLink(): Promise<void> {
		if (!Platform.isDesktopApp) {
			new Notice("请在电脑端生成链接");
			return;
		}
		if (!this.bridge.isRunning()) {
			try {
				await this.bridge.start();
			} catch (e) {
				new Notice(
					`无法启动: ${e instanceof Error ? e.message : String(e)}`,
				);
				return;
			}
		}

		// Try public only when no Tailscale virtual LAN link is available.
		let status = this.bridge.getStatus(this.bridgeStatusExtra());
		if (
			this.settings.bridge.preferPublicTunnel &&
			status.publicUrls.length === 0 &&
			status.tailscaleUrls.length === 0
		) {
			new Notice("正在尝试生成任意网络可访问链接…");
			status = await this.ensurePublicBridge();
		}

		new BridgeLinkModal(this.app, status, this.bridgeModalHandlers()).open();
	}


	/**
	 * When user pastes/drags a file into an item markdown note, Obsidian drops it
	 * via default attachment rules. Absorb those embeds into the item attachment folder.
	 */
	private registerAttachmentPasteWatcher(): void {
		const absorbForFile = async (path: string) => {
			if (!path || !path.endsWith(".md")) return;
			const notebooks = await this.notebooks.listNotebooks();
			for (const meta of notebooks) {
				const items = await this.items.listItems(meta);
				const item = items.find((it) => it.path === path);
				if (!item) continue;
				try {
					const { item: next, rewrites } =
						await this.attachments.absorbEmbedsInItem(meta, item);
					if (rewrites.length && next.body !== item.body) {
						await this.items.updateItem(item, { body: next.body });
						const leaves = this.app.workspace.getLeavesOfType(
							VIEW_TYPE_AI_NOTEBOOK,
						);
						const view = leaves[0]?.view;
						if (view instanceof NotebookView) {
							void view.reload();
						}
					}
				} catch {
					// ignore
				}
				return;
			}
		};

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					void absorbForFile(file.path);
				}
			}),
		);
	}

	async loadSettings(): Promise<void> {
		const raw = await this.loadData();
		let settings = normalizeSettings(raw);

		// Providers live in vault `.obsidian/ai-notebook-user.json` so they
		// survive replacing the plugin folder (main.js / styles.css).
		const durable = await this.userConfig.load();
		if (durable && durable.providers.length > 0) {
			settings = this.userConfig.mergeIntoSettings(settings, durable);
		} else if (settings.providers.length > 0) {
			// Migrate once from old plugin data.json → durable file
			await this.userConfig.save(
				this.userConfig.extractFromSettings(settings),
			);
		}

		this.settings = settings;
	}

	async saveSettings(): Promise<void> {
		// UI / paths / bridge → plugin data.json (ok to overwrite on install)
		// Providers / routing → durable vault config (never wiped by plugin copy)
		await this.userConfig.save(
			this.userConfig.extractFromSettings(this.settings),
		);
		await this.saveData(this.settings);
	}

	async openLastOrPick(): Promise<void> {
		const last = this.settings.ui.lastNotebookId;
		if (last) {
			const found = await this.notebooks.findById(last);
			if (found) {
				await this.openNotebook(found.notebook_id);
				return;
			}
		}
		const all = await this.notebooks.listNotebooks();
		if (all.length === 1 && all[0]) {
			await this.openNotebook(all[0].notebook_id);
			return;
		}
		if (all.length === 0) {
			new CreateNotebookModal(this.app, this, () => undefined).open();
			return;
		}
		await new PickNotebookModal(this.app, this).openAndLoad();
	}

	async openNotebook(notebookId: string): Promise<void> {
		const meta = await this.notebooks.findById(notebookId);
		if (!meta) {
			new Notice("记录本不存在");
			return;
		}

		this.settings = {
			...this.settings,
			ui: { ...this.settings.ui, lastNotebookId: notebookId },
		};
		await this.saveSettings();

		const leaf = await this.revealNotebookLeaf();
		const view = leaf.view;
		if (view instanceof NotebookView) {
			await view.setNotebookId(notebookId);
		}
	}

	private async revealNotebookLeaf(): Promise<WorkspaceLeaf> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_NOTEBOOK);
		if (existing[0]) {
			await this.app.workspace.revealLeaf(existing[0]);
			return existing[0];
		}
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({
			type: VIEW_TYPE_AI_NOTEBOOK,
			active: true,
		});
		await this.app.workspace.revealLeaf(leaf);
		return leaf;
	}

	private async runFeatureEditCommand(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_NOTEBOOK);
		const view = leaves[0]?.view;
		if (view instanceof NotebookView) {
			await view.runFeatureEditPrompt();
			return;
		}
		new Notice("请先打开 AI 记录本视图");
	}

	private async mobileDumpInbox(): Promise<void> {
		const text = window.prompt(
			"粘贴或输入杂乱信息（将写入 AI Inbox/pending，同步后可 AI 整理）：",
		);
		if (text == null || !text.trim()) return;
		try {
			const path = await this.inbox.dumpRaw({
				text: text.trim(),
				source: "mobile",
			});
			new Notice(`已写入收件箱: ${path}`);
		} catch (e) {
			new Notice(`写入失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async processInboxAll(): Promise<void> {
		new Notice("正在处理收件箱…");
		const result = await this.inbox.processAll({ useAi: true });
		if (result.ok === 0 && result.fail === 0) {
			new Notice("收件箱为空");
			return;
		}
		new Notice(
			`收件箱处理完成：成功 ${result.ok}，失败 ${result.fail}` +
				(result.errors[0] ? `；例: ${result.errors[0]}` : ""),
		);
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_NOTEBOOK);
		const view = leaves[0]?.view;
		if (view instanceof NotebookView) {
			await view.reload();
		}
	}

	private async organizeActiveItem(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_NOTEBOOK);
		const view = leaves[0]?.view;
		if (view instanceof NotebookView) {
			await view.reorganizeActiveItem();
			return;
		}
		new Notice("请先打开记录本并选中条目");
	}

	private async diagnoseVoice(): Promise<void> {
		new Notice("正在诊断语音转写（不会显示 API Key）…");
		const diag = new VoiceDiagnostics(
			this.app,
			this.voice,
			this.gateway,
			() => this.settings,
			(purpose) => resolveProvider(this.settings, purpose, null),
			(purpose) => resolveProviderChain(this.settings, purpose, null),
		);
		const lines = await diag.run();
		const text = lines
			.map((l) => `${l.ok ? "✓" : "✗"} ${l.step}\n   ${l.detail}`)
			.join("\n\n");
		// Show in modal-like notice chain + console
		console.info("[ai-notebook voice diag]\n" + text);
		// Write to vault note for user to read (no API keys)
		try {
			await this.inbox.ensureStructure();
			const path = `${this.settings.paths.inboxRoot}/语音转写诊断.md`;
			const body = [
				"# 语音转写诊断",
				"",
				`时间：${new Date().toLocaleString()}`,
				"",
				"以下测试使用**合成 1 秒测试音**，不读取你的私人录音，**不打印 API Key**。",
				"",
				...lines.map(
					(l) =>
						`## ${l.ok ? "✅" : "❌"} ${l.step}\n\n${l.detail}\n`,
				),
				"",
				"## 如何解读",
				"",
				"- **测试 A 成功**：线路支持 Whisper 类 `POST /v1/audio/transcriptions`，语音应能转文字。",
				"- **仅测试 B 成功**：对话模型能听音频；插件会走 chat 回退。",
				"- **都失败**：录音/存文件正常，但当前模型/渠道**不能**转写（与「未提供音频」类回复一致）。请另配支持 `whisper-1` 的服务商，并在「用途→语音转写」中指定。",
				"",
			].join("\n");
			const exists = await this.app.vault.adapter.exists(path);
			if (exists) await this.app.vault.adapter.write(path, body);
			else await this.app.vault.create(path, body);
			new Notice("诊断完成：见笔记「语音转写诊断」");
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf(true).openFile(file);
			}
		} catch (e) {
			new Notice(
				`诊断完成（写笔记失败）: ${lines.map((l) => l.step + (l.ok ? "✓" : "✗")).join(" ")}`,
			);
			console.error(e);
		}
	}

	private async diagnoseAllVoiceModels(): Promise<void> {
		new Notice("开始全量体检（所有服务商×模型，可能较久）…", 5000);
		const diag = new VoiceDiagnostics(
			this.app,
			this.voice,
			this.gateway,
			() => this.settings,
			(purpose) => resolveProvider(this.settings, purpose, null),
			(purpose) => resolveProviderChain(this.settings, purpose, null),
		);
		const { lines, sttOk, chatOk } = await diag.runFullCatalog({
			onProgress: (msg) => {
				console.info("[ai-notebook voice full]", msg);
			},
		});
		const text = lines
			.map((l) => {
				const mark = l.ok ? "[OK] " : "[X] ";
				return mark + l.step + "\n   " + l.detail;
			})
			.join("\n\n");
		console.info("[ai-notebook voice full diag]\n" + text);
		try {
			await this.inbox.ensureStructure();
			const path = `${this.settings.paths.inboxRoot}/语音能力全量体检.md`;
			const sttList = sttOk.length
				? sttOk.map((s) => "- " + s).join("\n")
				: "- （无）";
			const chatList = chatOk.length
				? chatOk.map((s) => "- " + s).join("\n")
				: "- （无）";
			const body =
				"# 语音能力全量体检\n\n" +
				"时间：" +
				new Date().toLocaleString() +
				"\n\n## 摘要\n\n" +
				"- STT 可用 " +
				String(sttOk.length) +
				" 个\n" +
				"- 听音频可用 " +
				String(chatOk.length) +
				" 个\n\n" +
				"### STT 可用列表\n\n" +
				sttList +
				"\n\n### 听音频可用列表\n\n" +
				chatList +
				"\n\n## 明细\n\n" +
				text +
				"\n";
			await this.vaultIo.write(path, body);
			new Notice(
				"全量体检完成：STT " +
					String(sttOk.length) +
					" / 听音频 " +
					String(chatOk.length) +
					" · 见 AI Inbox/语音能力全量体检",
				8000,
			);
		} catch (e) {
			new Notice(
				"体检完成但写笔记失败：" +
					(e instanceof Error ? e.message : String(e)),
			);
		}
	}

	private async voiceCaptureCommand(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_NOTEBOOK);
		const view = leaves[0]?.view;
		if (view instanceof NotebookView) {
			await view.voiceCapturePublic();
			return;
		}
		// no view: dump transcript path via prompt after open
		await this.openLastOrPick();
		const again = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_NOTEBOOK)[0]
			?.view;
		if (again instanceof NotebookView) {
			await again.voiceCapturePublic();
		}
	}
}
