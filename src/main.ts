import { Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
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
import { resolveProvider } from "./services/providerResolver";
import { CabinetService } from "./services/cabinetService";
import { VoiceService } from "./services/voiceService";
import { VoicePipeline } from "./services/voicePipeline";
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
		// Keep a local copy of the running package for one-click switch later.
		void this.packageArchive.archiveCurrentPackage().catch(() => undefined);

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
		this.voice = new VoiceService();
		this.runtime = new CapabilityRuntime();
		this.gateway = new AiGateway();
		this.voicePipeline = new VoicePipeline(
			this.vaultIo,
			this.voice,
			this.gateway,
			() => this.settings,
			(purpose, notebook) => resolveProvider(this.settings, purpose, notebook),
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
		this.bridge = new MobileBridgeServer({
			getSettings: () => this.settings,
			saveSettings: async (s) => {
				this.settings = s;
				await this.saveSettings();
			},
			resolveTargetNotebook: () => this.inbox.resolveTargetNotebook(),
			listNotebooks: () => this.notebooks.listNotebooks(),
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
				this.resolveAi("voice", notebook) ||
				this.resolveAi("worker", notebook) ||
				this.resolveAi("planner", notebook),
			inbox: this.inbox,
			organize: this.organize,
			voice: this.voice,
			items: this.items,
			cabinet: this.cabinet,
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
			id: "quick-capture-ai-notebook",
			name: "快速捕获（当前记录本）",
			callback: () => {
				void this.quickCaptureInOpenView();
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

	/** Resolve provider with optional notebook overrides. */
	resolveAi(
		purpose: "planner" | "worker" | "voice",
		notebook?: NotebookMeta | null,
	) {
		return resolveProvider(this.settings, purpose, notebook);
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

		// Try public if preferred and none yet
		let status = this.bridge.getStatus(this.bridgeStatusExtra());
		if (
			this.settings.bridge.preferPublicTunnel &&
			status.publicUrls.length === 0
		) {
			new Notice("正在尝试生成任意网络可访问链接…");
			status = await this.ensurePublicBridge();
		}

		new BridgeLinkModal(this.app, status, this.bridgeModalHandlers()).open();
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

	private async quickCaptureInOpenView(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_NOTEBOOK);
		const view = leaves[0]?.view;
		if (view instanceof NotebookView) {
			await view.quickCapture();
			return;
		}
		new Notice("请先打开 AI 记录本视图");
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
