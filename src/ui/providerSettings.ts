import { Modal, Notice, Setting } from "obsidian";
import type AiNotebookPlugin from "../main";
import { createId } from "../domain/ids";
import type { ProviderProfile, VoiceRecordFormat } from "../domain/types";
import {
	DEFAULT_VOICE_POLISH_PROMPT,
	PURPOSE_ROUTE_CHAIN_LEN,
} from "../domain/types";
import { normalizeRouteChain } from "../domain/purposeRouting";
import { AiGateway } from "../infra/aiGateway";
import { USER_CONFIG_FILENAME } from "../infra/userConfigStore";

const PRESETS: Array<{
	name: string;
	baseUrl: string;
	models: string[];
	defaultModel: string;
}> = [
	{
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
		defaultModel: "gpt-4o-mini",
	},
	{
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		models: ["deepseek-chat", "deepseek-reasoner"],
		defaultModel: "deepseek-chat",
	},
	{
		name: "通义 / 兼容中转",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		models: ["qwen-plus", "qwen-turbo"],
		defaultModel: "qwen-plus",
	},
	{
		name: "自定义（OpenAI 兼容）",
		baseUrl: "https://api.example.com/v1",
		models: ["your-model-id"],
		defaultModel: "your-model-id",
	},
];

/**
 * Compact multi-vendor manager: one row per provider + modal detail editor.
 */
export function renderProviderSection(
	containerEl: HTMLElement,
	plugin: AiNotebookPlugin,
	gateway: AiGateway,
	redisplay: () => void,
): void {
	renderVoiceFeatureSettings(containerEl, plugin, redisplay);

	containerEl.createEl("h3", { text: "AI 服务商与模型" });
	containerEl.createEl("p", {
		text:
			`可添加多家服务商（OpenAI / DeepSeek / 中转站等）。` +
			`配置保存在库内 .obsidian/${USER_CONFIG_FILENAME}。` +
			`列表一行一个厂家，点「编辑」进入详细配置。`,
		cls: "setting-item-description",
	});

	const toolbar = containerEl.createDiv({
		cls: "ai-notebook-provider-toolbar",
	});
	const addWrap = toolbar.createDiv();
	new Setting(addWrap)
		.setName("添加服务商")
		.setDesc("选预设快速创建，再点编辑填 Key / 模型")
		.addDropdown((d) => {
			for (let i = 0; i < PRESETS.length; i++) {
				d.addOption(String(i), PRESETS[i]!.name);
			}
			d.setValue("0");
			(addWrap as HTMLElement & { _preset?: string })._preset = "0";
			d.onChange((v) => {
				(addWrap as HTMLElement & { _preset?: string })._preset = v;
			});
		})
		.addButton((b) =>
			b
				.setButtonText("添加")
				.setCta()
				.onClick(async () => {
					const idx = parseInt(
						(addWrap as HTMLElement & { _preset?: string })._preset || "0",
						10,
					);
					const preset = PRESETS[idx] ?? PRESETS[PRESETS.length - 1]!;
					const profile: ProviderProfile = {
						id: createId(),
						name: preset.name,
						baseUrl: preset.baseUrl,
						apiKey: "",
						models: [...preset.models],
						defaultModel: preset.defaultModel,
					};
					plugin.settings = {
						...plugin.settings,
						providers: [...plugin.settings.providers, profile],
						defaultProviderId:
							plugin.settings.defaultProviderId ?? profile.id,
					};
					await plugin.saveSettings();
					new Notice(`已添加：${profile.name}`);
					redisplay();
				}),
		);

	new Setting(containerEl)
		.setName("默认服务商")
		.setDesc("未单独指定用途时使用")
		.addDropdown((d) => {
			d.addOption("", "（未选择）");
			for (const p of plugin.settings.providers) {
				d.addOption(p.id, p.name || p.id.slice(0, 8));
			}
			d.setValue(plugin.settings.defaultProviderId ?? "");
			d.onChange(async (v) => {
				plugin.settings = {
					...plugin.settings,
					defaultProviderId: v || null,
				};
				await plugin.saveSettings();
			});
		});

	if (plugin.settings.providers.length === 0) {
		containerEl.createDiv({
			cls: "ai-notebook-empty",
			text: "还没有服务商。点上方「添加」开始配置。",
		});
	} else {
		const list = containerEl.createDiv({
			cls: "ai-notebook-provider-row-list",
		});
		for (const profile of plugin.settings.providers) {
			renderProviderRow(list, plugin, gateway, profile, redisplay);
		}
	}

	containerEl.createEl("h3", { text: "用途 → 服务商（有序回退）" });
	containerEl.createEl("p", {
		text:
			"顺序 1→2→3 为厂家回退。选「服务商默认模型」：无「本用途次序」时跟服务商编辑页优先级 1…N；若点了「本用途次序」并填了数字则用本用途次序。" +
			"显式选某一模型则只试该模型。语音请选 asr/whisper；勿放 tts。对话听音频默认开。",
		cls: "setting-item-description",
	});
	renderRouteChain(containerEl, plugin, "planner", "改功能 / 规划", redisplay);
	renderRouteChain(containerEl, plugin, "worker", "整理 / 助手", redisplay);
	renderRouteChain(containerEl, plugin, "voice", "语音转写", redisplay);
}

function renderVoiceFeatureSettings(
	containerEl: HTMLElement,
	plugin: AiNotebookPlugin,
	redisplay: () => void,
): void {
	const voice = plugin.settings.voice;
	containerEl.createEl("h3", { text: "语音录入与润色" });
	containerEl.createEl("p", {
		text: "录音格式、厂家内模型轮询数量、转写后润色（独立于蓝图「AI 结构化」）。",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("录音格式")
		.setDesc("auto 按浏览器能力协商；wav 最兼容多数 STT；webm/m4a 体积更小")
		.addDropdown((d) => {
			const opts: Array<[VoiceRecordFormat, string]> = [
				["auto", "自动"],
				["wav", "WAV"],
				["webm", "WebM / Opus"],
				["m4a", "M4A / MP4"],
				["mp3", "MP3（可能回退）"],
			];
			for (const [v, label] of opts) d.addOption(v, label);
			d.setValue(voice.recordFormat || "auto");
			d.onChange(async (v) => {
				plugin.settings = {
					...plugin.settings,
					voice: {
						...plugin.settings.voice,
						recordFormat: v as VoiceRecordFormat,
					},
				};
				await plugin.saveSettings();
			});
		});

	new Setting(containerEl)
		.setName("对话听音频回退")
		.setDesc("默认开。STT 失败后用聊天模型听音频（慢，易 NO_AUDIO）。仅当中转无 /audio/transcriptions 时再开。")
		.addToggle((tg) =>
			tg
				.setValue(voice.allowChatAudioFallback !== false)
				.onChange(async (v) => {
					plugin.settings = {
						...plugin.settings,
						voice: {
							...plugin.settings.voice,
							allowChatAudioFallback: v,
						},
					};
					await plugin.saveSettings();
				}),
		);

	new Setting(containerEl)
		.setName("转写前转 16k WAV")
		.setDesc("非 WAV 录音提交 STT 前尝试转码，提高兼容性")
		.addToggle((t) =>
			t.setValue(voice.transcodeWavForStt !== false).onChange(async (v) => {
				plugin.settings = {
					...plugin.settings,
					voice: { ...plugin.settings.voice, transcodeWavForStt: v },
				};
				await plugin.saveSettings();
			}),
		);

	new Setting(containerEl)
		.setName("默认模型轮询优先级数量")
		.setDesc(
			"用途选「服务商默认」时：只尝试该厂已设优先级 1…N 的模型（手填正整数，默认 6）。未填优先级的不参与轮询。",
		)
		.addText((txt) => {
			txt.inputEl.type = "number";
			txt.inputEl.min = "1";
			txt.inputEl.step = "1";
			txt.setValue(String(voice.modelFanout || 6));
			txt.onChange(async (v) => {
				const n = Math.max(1, Math.floor(Number(v) || 6));
				plugin.settings = {
					...plugin.settings,
					voice: { ...plugin.settings.voice, modelFanout: n },
				};
				await plugin.saveSettings();
			});
		});

	new Setting(containerEl)
		.setName("启用语音润色")
		.setDesc("转写成功后，用聊天模型重排润色（默认开）")
		.addToggle((t) =>
			t.setValue(voice.polish?.enabled !== false).onChange(async (v) => {
				plugin.settings = {
					...plugin.settings,
					voice: {
						...plugin.settings.voice,
						polish: { ...plugin.settings.voice.polish, enabled: v },
					},
				};
				await plugin.saveSettings();
				redisplay();
			}),
		);

	new Setting(containerEl)
		.setName("润色服务商")
		.setDesc("空 = 默认服务商")
		.addDropdown((d) => {
			d.addOption("", "（默认服务商）");
			for (const p of plugin.settings.providers) {
				d.addOption(p.id, p.name || p.id.slice(0, 8));
			}
			d.setValue(voice.polish?.providerId ?? "");
			d.onChange(async (v) => {
				plugin.settings = {
					...plugin.settings,
					voice: {
						...plugin.settings.voice,
						polish: {
							...plugin.settings.voice.polish,
							providerId: v || null,
							model: v ? plugin.settings.voice.polish.model : null,
						},
					},
				};
				await plugin.saveSettings();
				redisplay();
			});
		});

	new Setting(containerEl)
		.setName("润色模型")
		.setDesc("空 = 该服务商默认模型")
		.addDropdown((d) => {
			d.addOption("", "服务商默认模型");
			const pid = voice.polish?.providerId;
			const prof = pid
				? plugin.settings.providers.find((x) => x.id === pid)
				: plugin.settings.providers.find(
						(x) => x.id === plugin.settings.defaultProviderId,
					);
			if (prof) {
				for (const m of prof.models) d.addOption(m, m);
				if (
					voice.polish?.model &&
					!prof.models.includes(voice.polish.model)
				) {
					d.addOption(
						voice.polish.model,
						`${voice.polish.model}（自定义）`,
					);
				}
			}
			d.setValue(voice.polish?.model ?? "");
			d.onChange(async (v) => {
				plugin.settings = {
					...plugin.settings,
					voice: {
						...plugin.settings.voice,
						polish: {
							...plugin.settings.voice.polish,
							model: v || null,
						},
					},
				};
				await plugin.saveSettings();
			});
		});

	new Setting(containerEl)
		.setName("润色提示词")
		.setDesc("指导模型如何重排转写原文")
		.addTextArea((ta) => {
			ta.setPlaceholder(DEFAULT_VOICE_POLISH_PROMPT);
			ta.setValue(voice.polish?.prompt || DEFAULT_VOICE_POLISH_PROMPT);
			ta.inputEl.rows = 4;
			ta.inputEl.style.width = "100%";
			ta.onChange(async (v) => {
				plugin.settings = {
					...plugin.settings,
					voice: {
						...plugin.settings.voice,
						polish: {
							...plugin.settings.voice.polish,
							prompt: v.trim() || DEFAULT_VOICE_POLISH_PROMPT,
						},
					},
				};
				await plugin.saveSettings();
			});
		});
}

function renderProviderRow(
	listEl: HTMLElement,
	plugin: AiNotebookPlugin,
	gateway: AiGateway,
	profile: ProviderProfile,
	redisplay: () => void,
): void {
	const row = listEl.createDiv({ cls: "ai-notebook-provider-row" });
	const main = row.createDiv({ cls: "ai-notebook-provider-row-main" });
	const title = main.createDiv({ cls: "ai-notebook-provider-row-title" });
	title.setText(profile.name || "未命名");
	if (plugin.settings.defaultProviderId === profile.id) {
		title.createSpan({
			cls: "ai-notebook-provider-badge",
			text: "默认",
		});
	}
	main.createDiv({
		cls: "ai-notebook-provider-row-url",
		text: profile.baseUrl || "（未填 Base URL）",
	});
	main.createDiv({
		cls: "ai-notebook-provider-row-meta",
		text: `${profile.models.length} 个模型 · 默认 ${profile.defaultModel || "—"}`,
	});

	const actions = row.createDiv({ cls: "ai-notebook-provider-row-actions" });

	const testBtn = actions.createEl("button", { text: "测试" });
	testBtn.addEventListener("click", () => {
		void (async () => {
			new Notice("测试连通中…");
			const r = await gateway.testConnection(profile);
			new Notice(r.ok ? `连通 OK：${r.content}` : `失败：${r.error}`);
		})();
	});

	const defBtn = actions.createEl("button", { text: "设默认" });
	defBtn.addEventListener("click", () => {
		void (async () => {
			plugin.settings = {
				...plugin.settings,
				defaultProviderId: profile.id,
			};
			await plugin.saveSettings();
			redisplay();
		})();
	});

	const editBtn = actions.createEl("button", { text: "编辑" });
	editBtn.addClass("mod-cta");
	editBtn.addEventListener("click", () => {
		new ProviderEditModal(plugin, gateway, profile.id, redisplay).open();
	});

	const delBtn = actions.createEl("button", { text: "删除" });
	delBtn.addClass("mod-warning");
	delBtn.addEventListener("click", () => {
		void (async () => {
			if (!window.confirm(`删除服务商「${profile.name}」？`)) return;
			const providers = plugin.settings.providers.filter(
				(p) => p.id !== profile.id,
			);
			plugin.settings = {
				...plugin.settings,
				providers,
				defaultProviderId:
					plugin.settings.defaultProviderId === profile.id
						? (providers[0]?.id ?? null)
						: plugin.settings.defaultProviderId,
			};
			await plugin.saveSettings();
			redisplay();
		})();
	});
}

class ProviderEditModal extends Modal {
	constructor(
		private readonly plugin: AiNotebookPlugin,
		private readonly gateway: AiGateway,
		private readonly profileId: string,
		private readonly onDone: () => void,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.display();
	}

	private current(): ProviderProfile | null {
		return (
			this.plugin.settings.providers.find((p) => p.id === this.profileId) ??
			null
		);
	}

	private async update(
		patch: Partial<ProviderProfile>,
	): Promise<ProviderProfile | null> {
		const list = this.plugin.settings.providers.map((p) =>
			p.id === this.profileId ? { ...p, ...patch } : p,
		);
		this.plugin.settings = { ...this.plugin.settings, providers: list };
		await this.plugin.saveSettings();
		return list.find((p) => p.id === this.profileId) ?? null;
	}

	private display(): void {
		const { contentEl } = this;
		contentEl.empty();
		const profile = this.current();
		if (!profile) {
			contentEl.createEl("p", { text: "服务商不存在" });
			return;
		}
		contentEl.createEl("h2", { text: `编辑：${profile.name || "服务商"}` });

		new Setting(contentEl)
			.setName("显示名称")
			.addText((t) => {
				t.setValue(profile.name);
				// Save on blur only — onChange+redisplay steals focus every keystroke
				t.inputEl.addEventListener("blur", () => {
					void (async () => {
						const v = t.getValue();
						const cur = this.current();
						if (!cur || cur.name === v) return;
						await this.update({ name: v });
						// update title without full rebuild if possible
						const h = this.contentEl.querySelector("h2");
						if (h) h.setText(`编辑：${v || "服务商"}`);
					})();
				});
			});

		new Setting(contentEl)
			.setName("Base URL")
			.setDesc("OpenAI 兼容，一般以 /v1 结尾")
			.addText((t) => {
				t.setValue(profile.baseUrl);
				t.inputEl.style.width = "100%";
				t.onChange(async (v) => {
					await this.update({ baseUrl: v.trim() });
				});
			});

		new Setting(contentEl)
			.setName("API Key")
			.addText((t) => {
				t.setValue(profile.apiKey);
				t.inputEl.type = "password";
				t.inputEl.style.width = "100%";
				t.onChange(async (v) => {
					await this.update({ apiKey: v });
				});
			});

		const modelsBox = contentEl.createDiv({
			cls: "ai-notebook-provider-models",
		});
		modelsBox.createEl("h3", { text: "模型列表" });
		new Setting(modelsBox)
			.setName("从上游拉取")
			.addButton((b) =>
				b.setButtonText("GET /models").onClick(async () => {
					const latest = this.current();
					if (!latest) return;
					new Notice("拉取模型中…");
					const listed = await this.gateway.listModels(latest);
					if (!listed.ok) {
						new Notice(`失败：${listed.error}`);
						return;
					}
					const models = listed.models;
					const stt = models.filter((m) =>
						/whisper|transcrib|speech|asr|stt/i.test(m),
					);
					const ordered = [
						...stt,
						...models.filter((m) => !stt.includes(m)),
					];
					const defaultModel =
						(latest.defaultModel &&
						ordered.includes(latest.defaultModel)
							? latest.defaultModel
							: stt[0] || ordered[0]) || "";
					await this.update({ models: ordered, defaultModel });
					new Notice(`已获取 ${ordered.length} 个模型`);
					this.display();
				}),
			);

		modelsBox.createEl("p", {
			cls: "setting-item-description",
			text: "右侧「优先级」填唯一正整数 1、2、3…（不可重复）。空=不参与用途「服务商默认」轮询。N 限制最多用到优先级几。",
		});
		for (const model of profile.models) {
			const line = modelsBox.createDiv({
				cls: "ai-notebook-model-line",
			});
			line.createSpan({ text: model, cls: "ai-notebook-model-name" });
			const prioWrap = line.createDiv({ cls: "ai-notebook-model-prio" });
			prioWrap.createSpan({ text: "优先级" });
			const prioInput = prioWrap.createEl("input");
			prioInput.type = "number";
			prioInput.min = "1";
			prioInput.step = "1";
			prioInput.placeholder = "空";
			const curP =
				profile.modelPriority && profile.modelPriority[model] != null
					? String(profile.modelPriority[model])
					: "";
			prioInput.value = curP;
			prioInput.addEventListener("change", () => {
				void (async () => {
					const latest = this.current();
					if (!latest) return;
					const raw = prioInput.value.trim();
					const next: Record<string, number> = {
						...(latest.modelPriority ?? {}),
					};
					if (!raw) {
						delete next[model];
					} else {
						const n = Math.floor(Number(raw));
						if (!Number.isFinite(n) || n < 1) {
							new Notice("优先级须为正整数");
							prioInput.value = curP;
							return;
						}
						// unique: reject if another model has same priority
						const clash = Object.entries(next).find(
							([m, p]) => m !== model && p === n,
						);
						if (clash) {
							new Notice(`优先级 ${n} 已被 ${clash[0]} 占用，请换数字`);
							prioInput.value = curP;
							return;
						}
						next[model] = n;
					}
					await this.update({
						modelPriority: Object.keys(next).length ? next : undefined,
					});
					this.display();
				})();
			});
			if (model === profile.defaultModel) {
				line.createSpan({
					cls: "ai-notebook-provider-badge",
					text: "默认",
				});
			} else {
				const setDef = line.createEl("button", { text: "设为默认" });
				setDef.addEventListener("click", () => {
					void this.update({ defaultModel: model }).then(() =>
						this.display(),
					);
				});
			}
			const del = line.createEl("button", { text: "删除" });
			del.addEventListener("click", () => {
				void (async () => {
					const latest = this.current();
					if (!latest) return;
					const models = latest.models.filter((m) => m !== model);
					const mp = { ...(latest.modelPriority ?? {}) };
					delete mp[model];
					await this.update({
						models,
						defaultModel: models.includes(latest.defaultModel)
							? latest.defaultModel
							: (models[0] ?? ""),
						modelPriority: Object.keys(mp).length ? mp : undefined,
					});
					this.display();
				})();
			});
		}

		new Setting(modelsBox)
			.setName("手动添加模型 ID")
			.addText((t) => {
				t.setPlaceholder("例如 mimo-v2.5-asr");
				(modelsBox as HTMLElement & { _mid?: string })._mid = "";
				t.onChange((v) => {
					(modelsBox as HTMLElement & { _mid?: string })._mid = v;
				});
			})
			.addButton((b) =>
				b.setButtonText("添加").onClick(async () => {
					const id = (
						(modelsBox as HTMLElement & { _mid?: string })._mid || ""
					).trim();
					if (!id) return;
					const latest = this.current();
					if (!latest) return;
					if (latest.models.includes(id)) {
						new Notice("已存在");
						return;
					}
					await this.update({
						models: [...latest.models, id],
						defaultModel: latest.defaultModel || id,
					});
					this.display();
				}),
			);

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("完成").setCta().onClick(() => {
				this.close();
				this.onDone();
			}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function renderRouteChain(
	containerEl: HTMLElement,
	plugin: AiNotebookPlugin,
	key: "planner" | "worker" | "voice",
	label: string,
	redisplay: () => void,
): void {
	const chain = normalizeRouteChain(plugin.settings.purposeRouting[key]);
	const block = containerEl.createDiv({ cls: "ai-notebook-route-chain" });
	block.createEl("div", {
		cls: "ai-notebook-route-chain-title",
		text: label,
	});

	for (let i = 0; i < chain.length; i++) {
		const slot = chain[i] ?? { providerId: null, model: null };
		const row = new Setting(block).setName(
			"顺序 " + String(i + 1),
		);

		row.addDropdown((d) => {
			d.addOption("", "（空 / 跟随默认）");
			for (const p of plugin.settings.providers) {
				d.addOption(p.id, p.name || p.id.slice(0, 8));
			}
			d.setValue(slot.providerId ?? "");
			d.onChange(async (v) => {
				const nextChain = normalizeRouteChain(
					plugin.settings.purposeRouting[key],
				).map((s, idx) =>
					idx === i
						? {
								providerId: v || null,
								model: v ? s.model : null,
								modelPriority: undefined,
							}
						: s,
				);
				if (v) {
					const prof = plugin.settings.providers.find((p) => p.id === v);
					const cur = nextChain[i]!;
					if (
						cur.model &&
						prof &&
						!prof.models.includes(cur.model) &&
						cur.model !== prof.defaultModel
					) {
						nextChain[i] = { ...cur, model: null };
					}
				}
				plugin.settings = {
					...plugin.settings,
					purposeRouting: {
						...plugin.settings.purposeRouting,
						[key]: nextChain,
					},
				};
				await plugin.saveSettings();
				redisplay();
			});
		});

		row.addDropdown((d) => {
			d.addOption("", "服务商默认模型");
			const pid = slot.providerId;
			const prof = pid
				? plugin.settings.providers.find((p) => p.id === pid)
				: null;
			if (prof) {
				for (const m of prof.models) {
					d.addOption(m, m);
				}
				if (slot.model && !prof.models.includes(slot.model)) {
					d.addOption(slot.model, slot.model + "（自定义）");
				}
			}
			d.setValue(slot.model ?? "");
			d.setDisabled(!pid);
			d.onChange(async (v) => {
				const nextChain = normalizeRouteChain(
					plugin.settings.purposeRouting[key],
				).map((s, idx) => {
					if (idx !== i) return s;
					if (v) {
						return { ...s, model: v, modelPriority: undefined };
					}
					return { ...s, model: null };
				});
				plugin.settings = {
					...plugin.settings,
					purposeRouting: {
						...plugin.settings.purposeRouting,
						[key]: nextChain,
					},
				};
				await plugin.saveSettings();
				redisplay();
			});
		});

		if (slot.providerId) {
			const hasLocal =
				!slot.model &&
				slot.modelPriority &&
				Object.keys(slot.modelPriority).length > 0;
			row.addButton((b) =>
				b
					.setButtonText(
						slot.model
							? "单模型"
							: hasLocal
								? "本用途次序✓"
								: "本用途次序…",
					)
					.setDisabled(Boolean(slot.model))
					.setTooltip(
						slot.model
							? "已指定单个模型，不使用次序轮询"
							: "为「服务商默认」配置本用途厂内优先级（有则覆盖服务商编辑页次序）",
					)
					.onClick(() => {
						if (slot.model) return;
						const prof = plugin.settings.providers.find(
							(p) => p.id === slot.providerId,
						);
						if (!prof) return;
						new PurposeSlotPriorityModal(
							plugin,
							key,
							i,
							prof,
							redisplay,
						).open();
					}),
			);
		}
	}

	const addRow = block.createDiv({ cls: "ai-notebook-route-add" });
	const addBtn = addRow.createEl("button", { text: "+ 添加顺序" });
	addBtn.addClass("mod-cta");
	addBtn.addEventListener("click", async () => {
		const cur = normalizeRouteChain(plugin.settings.purposeRouting[key]);
		const next = [
			...cur,
			{ providerId: null as string | null, model: null as string | null },
		];
		plugin.settings = {
			...plugin.settings,
			purposeRouting: {
				...plugin.settings.purposeRouting,
				[key]: next,
			},
		};
		await plugin.saveSettings();
		redisplay();
	});
	if (chain.length > PURPOSE_ROUTE_CHAIN_LEN) {
		const rm = addRow.createEl("button", { text: "移除末行" });
		rm.addEventListener("click", async () => {
			const cur = normalizeRouteChain(plugin.settings.purposeRouting[key]);
			if (cur.length <= PURPOSE_ROUTE_CHAIN_LEN) return;
			const next = cur.slice(0, -1);
			plugin.settings = {
				...plugin.settings,
				purposeRouting: {
					...plugin.settings.purposeRouting,
					[key]: next,
				},
			};
			await plugin.saveSettings();
			redisplay();
		});
	}

}

class PurposeSlotPriorityModal extends Modal {
	constructor(
		private readonly plugin: AiNotebookPlugin,
		private readonly purpose: "planner" | "worker" | "voice",
		private readonly slotIndex: number,
		private readonly profile: ProviderProfile,
		private readonly onDone: () => void,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", {
			text:
				"本用途次序 · " + (this.profile.name || "服务商"),
		});
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "仅当该顺序选「服务商默认模型」时生效。填唯一正整数 1、2、3…；空=不参与。若此处有任意优先级，则覆盖服务商编辑页的全局次序。",
		});

		const chain = normalizeRouteChain(
			this.plugin.settings.purposeRouting[this.purpose],
		);
		const slot = chain[this.slotIndex] ?? {
			providerId: this.profile.id,
			model: null,
		};
		const pri: Record<string, number> = {
			...(slot.modelPriority ?? {}),
		};

		for (const model of this.profile.models) {
			const line = contentEl.createDiv({ cls: "ai-notebook-model-line" });
			line.createSpan({ text: model, cls: "ai-notebook-model-name" });
			const wrap = line.createDiv({ cls: "ai-notebook-model-prio" });
			wrap.createSpan({ text: "优先级" });
			const input = wrap.createEl("input");
			input.type = "number";
			input.min = "1";
			input.step = "1";
			input.placeholder = "空";
			input.value = pri[model] != null ? String(pri[model]) : "";
			input.addEventListener("change", () => {
				const raw = input.value.trim();
				if (!raw) {
					delete pri[model];
					return;
				}
				const n = Math.floor(Number(raw));
				if (!Number.isFinite(n) || n < 1) {
					new Notice("优先级须为正整数");
					input.value = pri[model] != null ? String(pri[model]) : "";
					return;
				}
				const clash = Object.entries(pri).find(
					([m, p]) => m !== model && p === n,
				);
				if (clash) {
					new Notice("优先级 " + n + " 已被 " + clash[0] + " 占用");
					input.value = pri[model] != null ? String(pri[model]) : "";
					return;
				}
				pri[model] = n;
			});
		}

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("清空本用途次序").onClick(() => {
					void this.savePriority({}, true);
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("保存")
					.setCta()
					.onClick(() => {
						void this.savePriority(pri, false);
					}),
			);
	}

	private async savePriority(
		pri: Record<string, number>,
		clear: boolean,
	): Promise<void> {
		const nextChain = normalizeRouteChain(
			this.plugin.settings.purposeRouting[this.purpose],
		).map((s, idx) => {
			if (idx !== this.slotIndex) return s;
			const mp =
				clear || !Object.keys(pri).length ? undefined : { ...pri };
			return { ...s, model: null, modelPriority: mp };
		});
		this.plugin.settings = {
			...this.plugin.settings,
			purposeRouting: {
				...this.plugin.settings.purposeRouting,
				[this.purpose]: nextChain,
			},
		};
		await this.plugin.saveSettings();
		this.close();
		this.onDone();
		new Notice(clear ? "已清空本用途次序" : "已保存本用途次序");
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

