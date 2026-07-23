import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	TextAreaComponent,
} from "obsidian";
import type AiNotebookPlugin from "../main";
import { redactSettingsForExport } from "../domain/settingsDefaults";
import {
	mergeImportedProviders,
	parseImportJson,
} from "../domain/providerImport";
import { AiGateway } from "../infra/aiGateway";
import { renderProviderSection } from "./providerSettings";

export class AiNotebookSettingTab extends PluginSettingTab {
	plugin: AiNotebookPlugin;
	private gateway = new AiGateway();

	constructor(app: App, plugin: AiNotebookPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "AI 记录本" });

		containerEl.createEl("h3", { text: "路径" });
		new Setting(containerEl)
			.setName("记录本根目录")
			.setDesc("Vault 内相对路径，默认 AI Notebooks")
			.addText((t) =>
				t
					.setValue(this.plugin.settings.paths.notebooksRoot)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							paths: {
								...this.plugin.settings.paths,
								notebooksRoot: v.trim() || "AI Notebooks",
							},
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("附件根目录")
			.setDesc("复制入库的附件根路径")
			.addText((t) =>
				t
					.setValue(this.plugin.settings.paths.attachmentsRoot)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							paths: {
								...this.plugin.settings.paths,
								attachmentsRoot: v.trim() || "attachments/ai-notebook",
							},
						};
						await this.plugin.saveSettings();
					}),
			);

		
		new Setting(containerEl)
			.setName("手机收件箱目录")
			.setDesc("手机写入杂乱信息的 vault 文件夹，默认 AI Inbox")
			.addText((t) =>
				t
					.setValue(this.plugin.settings.paths.inboxRoot)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							paths: {
								...this.plugin.settings.paths,
								inboxRoot: v.trim() || "AI Inbox",
							},
						};
						await this.plugin.saveSettings();

		void this.plugin.notebooks.listNotebooks().then((list) => {
			new Setting(containerEl)
				.setName("手机默认目标记录本")
				.setDesc("手机网页发送时的默认本；页面内也可临时切换。留空=上次打开的本")
				.addDropdown((d) => {
					d.addOption("", "（自动：上次打开 / 第一本）");
					for (const n of list) d.addOption(n.notebook_id, n.name);
					d.setValue(this.plugin.settings.inbox.defaultNotebookId || "");
					d.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							inbox: {
								...this.plugin.settings.inbox,
								defaultNotebookId: v || null,
							},
						};
						await this.plugin.saveSettings();
					});
				});
		});
					}),
			);

		containerEl.createEl("h3", { text: "收件箱 / 手机" });
		containerEl.createEl("p", {
			text: "手机与电脑使用同一 Vault 同步。手机笔记丢进收件箱 pending，插件用 AI 整理进记录本。",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("整理后归档原文")
			.setDesc("处理成功后把 pending 移到 processed")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.inbox.archiveAfterOrganize)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							inbox: {
								...this.plugin.settings.inbox,
								archiveAfterOrganize: v,
							},
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("语音后自动 AI 结构化")
			.setDesc("转写完成后按当前蓝图抽字段并分层正文")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.inbox.autoOrganizeVoice)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							inbox: {
								...this.plugin.settings.inbox,
								autoOrganizeVoice: v,
							},
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("初始化收件箱文件夹")
			.setDesc("创建 AI Inbox/pending、processed 与手机说明文档")
			.addButton((b) =>
				b.setButtonText("创建").onClick(async () => {
					await this.plugin.inbox.ensureStructure();
					new Notice("收件箱已就绪");
				}),
			);

		
		containerEl.createEl("h3", { text: "手机网页入口（局域网）" });
		containerEl.createEl("p", {
			text: "电脑生成链接，手机同一 Wi‑Fi 浏览器打开即可写字/录音，数据直达本机笔记并由 AI 整理。无需官方同步。",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("启用手机网页入口")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.bridge.enabled)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							bridge: { ...this.plugin.settings.bridge, enabled: v },
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("端口")
			.setDesc("默认 27124，冲突时可改")
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.bridge.port))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (!Number.isFinite(n) || n < 1 || n > 65535) return;
						this.plugin.settings = {
							...this.plugin.settings,
							bridge: { ...this.plugin.settings.bridge, port: n },
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("启动时自动打开入口")
			.setDesc("仅电脑端；会占用端口")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.bridge.autoStart)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							bridge: { ...this.plugin.settings.bridge, autoStart: v },
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("手机提交后自动 AI 整理")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.bridge.autoOrganize)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							bridge: { ...this.plugin.settings.bridge, autoOrganize: v },
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("优先生成任意网络链接")
			.setDesc("显示链接时尝试 Cloudflare 临时隧道（需安装 cloudflared）")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.bridge.preferPublicTunnel)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							bridge: {
								...this.plugin.settings.bridge,
								preferPublicTunnel: v,
							},
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("公网地址（手动）")
			.setDesc("ngrok/cloudflare 的 https 根地址，手机任意网络可打开")
			.addText((t) =>
				t
					.setPlaceholder("https://xxxx.trycloudflare.com")
					.setValue(this.plugin.settings.bridge.publicBaseUrl)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							bridge: {
								...this.plugin.settings.bridge,
								publicBaseUrl: v.trim().replace(/\/+$/, ""),
							},
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("cloudflared 路径")
			.setDesc("可选。不在 PATH 时填写 cloudflared.exe 完整路径")
			.addText((t) =>
				t
					.setPlaceholder("C:\path\to\cloudflared.exe")
					.setValue(this.plugin.settings.bridge.cloudflaredPath)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							bridge: {
								...this.plugin.settings.bridge,
								cloudflaredPath: v.trim(),
							},
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("显示 / 复制手机链接")
			.addButton((b) =>
				b.setButtonText("打开").setCta().onClick(() => {
					void this.plugin.showMobileBridgeLink();
				}),
			)
			.addButton((b) =>
				b.setButtonText("生成公网链接").onClick(() => {
					void this.plugin.createPublicMobileLink();
				}),
			);

		containerEl.createEl("h3", { text: "隐私" });
		new Setting(containerEl)
			.setName("附带本内 top-k 条目到 AI")
			.setDesc("默认关闭。开启后 worker/助手可附带检索片段。")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.privacy.attachTopKItems)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							privacy: {
								...this.plugin.settings.privacy,
								attachTopKItems: v,
							},
						};
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("允许附带当前笔记全文")
			.setDesc("默认关闭。")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.privacy.allowCurrentNoteContext)
					.onChange(async (v) => {
						this.plugin.settings = {
							...this.plugin.settings,
							privacy: {
								...this.plugin.settings.privacy,
								allowCurrentNoteContext: v,
							},
						};
						await this.plugin.saveSettings();
					}),
			);

		renderProviderSection(
			containerEl,
			this.plugin,
			this.gateway,
			() => this.display(),
		);


		containerEl.createEl("h3", { text: "导入 / 导出（脱敏）" });
		containerEl.createEl("p", {
			text: "导入会同步更新上方「AI 服务商与模型」列表：新增或合并服务商；名称为空时显示为「无」；空 API Key 保留原密钥。",
			cls: "setting-item-description",
		});
		new Setting(containerEl)
			.setName("导出配置（不含 API Key）")
			.addButton((b) =>
				b.setButtonText("复制 JSON").onClick(async () => {
					const payload = redactSettingsForExport(this.plugin.settings);
					const text = JSON.stringify(payload, null, 2);
					await navigator.clipboard.writeText(text);
					new Notice("已复制脱敏配置到剪贴板");
				}),
			);

		let importArea: TextAreaComponent | null = null;
		new Setting(containerEl)
			.setName("导入配置")
			.setDesc("粘贴完整 settings JSON，或仅 providers 数组 / 单个服务商对象")
			.addTextArea((t) => {
				importArea = t;
				t.setPlaceholder(
					'{ "providers": [ { "name": "无", "baseUrl": "https://.../v1", "apiKey": "sk-...", "models": ["whisper-1"] } ] }',
				);
				t.inputEl.rows = 6;
				t.inputEl.style.width = "100%";
			})
			.addButton((b) =>
				b.setButtonText("导入并刷新列表").setCta().onClick(async () => {
					const raw = importArea?.getValue() ?? "";
					if (!raw.trim()) {
						new Notice("请先粘贴 JSON");
						return;
					}
					try {
						const parsed = parseImportJson(raw);
						const result = mergeImportedProviders(
							this.plugin.settings,
							parsed,
						);
						if (result.warning && result.added === 0 && result.updated === 0) {
							new Notice(`导入未生效：${result.warning}`);
							return;
						}
						if (parsed && typeof parsed === "object") {
							const o = parsed as Record<string, unknown>;
							if (o.paths && typeof o.paths === "object") {
								result.settings = {
									...result.settings,
									paths: {
										...result.settings.paths,
										...(o.paths as AiNotebookPlugin["settings"]["paths"]),
									},
								};
							}
							if (o.privacy && typeof o.privacy === "object") {
								result.settings = {
									...result.settings,
									privacy: {
										...result.settings.privacy,
										...(o.privacy as AiNotebookPlugin["settings"]["privacy"]),
									},
								};
							}
						}
						this.plugin.settings = result.settings;
						await this.plugin.saveSettings();
						new Notice(
							`导入成功：服务商共 ${result.total} 个（新增 ${result.added}，更新 ${result.updated}）`,
						);
						this.display();
					} catch (e) {
						new Notice(
							`导入失败: ${e instanceof Error ? e.message : String(e)}`,
						);
					}
				}),
			);
	}
}
