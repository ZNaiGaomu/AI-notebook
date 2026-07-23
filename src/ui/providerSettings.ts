import { Notice, Setting } from "obsidian";
import type AiNotebookPlugin from "../main";
import { createId } from "../domain/ids";
import type { ProviderProfile } from "../domain/types";
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
 * Redesigned multi-vendor / multi-model AI provider manager.
 */
export function renderProviderSection(
	containerEl: HTMLElement,
	plugin: AiNotebookPlugin,
	gateway: AiGateway,
	redisplay: () => void,
): void {
	containerEl.createEl("h3", { text: "AI 服务商与模型" });
	containerEl.createEl("p", {
		text:
			`可添加多家服务商（OpenAI / DeepSeek / 中转站等），名称自定义。` +
			`配置保存在库内 .obsidian/${USER_CONFIG_FILENAME}，` +
			`更新/覆盖插件文件夹时不会丢失。`,
		cls: "setting-item-description",
	});

	// —— toolbar ——
	const toolbar = containerEl.createDiv({
		cls: "ai-notebook-provider-toolbar",
	});

	const addWrap = toolbar.createDiv();
	new Setting(addWrap)
		.setName("添加服务商")
		.setDesc("选一个预设快速创建，再改名称 / Key / 模型")
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
			b.setButtonText("添加").setCta().onClick(async () => {
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
		return;
	}

	// —— each vendor card ——
	for (const profile of plugin.settings.providers) {
		renderProviderCard(containerEl, plugin, gateway, profile, redisplay);
	}

	// —— purpose routing ——
	containerEl.createEl("h3", { text: "用途 → 服务商" });
	containerEl.createEl("p", {
		text: "不同功能可走不同服务商；留空则用默认服务商。",
		cls: "setting-item-description",
	});
	renderRoute(containerEl, plugin, "planner", "改功能 / 规划");
	renderRoute(containerEl, plugin, "worker", "整理 / 助手");
	renderRoute(containerEl, plugin, "voice", "语音转写");
}

function renderRoute(
	containerEl: HTMLElement,
	plugin: AiNotebookPlugin,
	key: "planner" | "worker" | "voice",
	label: string,
): void {
	new Setting(containerEl).setName(label).addDropdown((d) => {
		d.addOption("", "跟随默认");
		for (const p of plugin.settings.providers) {
			d.addOption(p.id, p.name || p.id.slice(0, 8));
		}
		d.setValue(plugin.settings.purposeRouting[key].providerId ?? "");
		d.onChange(async (v) => {
			plugin.settings = {
				...plugin.settings,
				purposeRouting: {
					...plugin.settings.purposeRouting,
					[key]: {
						...plugin.settings.purposeRouting[key],
						providerId: v || null,
					},
				},
			};
			await plugin.saveSettings();
		});
	});
}

function renderProviderCard(
	containerEl: HTMLElement,
	plugin: AiNotebookPlugin,
	gateway: AiGateway,
	profile: ProviderProfile,
	redisplay: () => void,
): void {
	const isDefault = plugin.settings.defaultProviderId === profile.id;
	const wrap = containerEl.createDiv({
		cls: "ai-notebook-provider-card",
	});

	const head = wrap.createDiv({ cls: "ai-notebook-provider-card-head" });
	const title = head.createEl("h4", {
		text: profile.name || "未命名服务商",
	});
	if (isDefault) {
		head.createSpan({
			cls: "ai-notebook-provider-badge",
			text: "默认",
		});
	}
	head.createSpan({
		cls: "ai-notebook-provider-meta",
		text: `${profile.models.length} 个模型`,
	});

	const update = async (patch: Partial<ProviderProfile>) => {
		plugin.settings = {
			...plugin.settings,
			providers: plugin.settings.providers.map((p) =>
				p.id === profile.id ? { ...p, ...patch } : p,
			),
		};
		await plugin.saveSettings();
		// redisplay only when model list structure changes (chips)
		if (patch.models != null || patch.defaultModel != null) {
			redisplay();
		} else if (patch.name != null) {
			title.setText(patch.name || "未命名服务商");
		}
	};

	new Setting(wrap)
		.setName("显示名称")
		.setDesc("自定义，如「家里中转」「公司 OpenAI」")
		.addText((t) => {
			t.setPlaceholder("服务商名称");
			t.setValue(profile.name);
			t.inputEl.addClass("ai-notebook-provider-input");
			t.onChange(async (v) => {
				// debounce-ish: save on blur via change is fine for Setting
				await update({ name: v });
			});
		});

	new Setting(wrap)
		.setName("Base URL")
		.setDesc("OpenAI 兼容接口，一般以 /v1 结尾")
		.addText((t) => {
			t.setPlaceholder("https://api.openai.com/v1");
			t.setValue(profile.baseUrl);
			t.inputEl.addClass("ai-notebook-provider-input");
			t.onChange(async (v) => {
				await update({ baseUrl: v.trim() });
			});
		});

	new Setting(wrap).setName("API Key").addText((t) => {
		t.setPlaceholder("sk-…");
		t.setValue(profile.apiKey);
		t.inputEl.type = "password";
		t.inputEl.addClass("ai-notebook-provider-input");
		t.onChange(async (v) => {
			await update({ apiKey: v });
		});
	});

	// —— models: fetch from upstream + one-per-line list ——
	const modelsBlock = wrap.createDiv({ cls: "ai-notebook-models-block" });
	const labelRow = modelsBlock.createDiv({ cls: "ai-notebook-models-label-row" });
	labelRow.createEl("div", {
		cls: "ai-notebook-models-label",
		text: "模型列表（一行一个；点「设为默认」或 × 删除）",
	});
	const fetchBtn = labelRow.createEl("button", {
		text: "从上游获取模型",
	});
	fetchBtn.addClass("mod-cta");
	fetchBtn.title = "用当前 Base URL + API Key 请求 GET /v1/models";

	const current =
		plugin.settings.providers.find((p) => p.id === profile.id) ?? profile;

	const listEl = modelsBlock.createDiv({ cls: "ai-notebook-model-list" });
	if (current.models.length === 0) {
		listEl.createDiv({
			cls: "ai-notebook-empty",
			text: "暂无模型。填好 URL 与 Key 后点「从上游获取模型」，或在下方手动添加。",
		});
	} else {
		for (const model of current.models) {
			const row = listEl.createDiv({ cls: "ai-notebook-model-row" });
			if (model === current.defaultModel) {
				row.addClass("is-default");
			}
			const name = row.createDiv({
				cls: "ai-notebook-model-row-name",
				text: model,
			});
			name.title = model;
			const right = row.createDiv({ cls: "ai-notebook-model-row-actions" });
			if (model === current.defaultModel) {
				right.createSpan({
					cls: "ai-notebook-provider-badge",
					text: "默认",
				});
			} else {
				const setDef = right.createEl("button", { text: "设为默认" });
				setDef.addEventListener("click", async () => {
					await update({ defaultModel: model });
					redisplay();
					new Notice(`默认模型：${model}`);
				});
			}
			const del = right.createEl("button", { text: "删除" });
			del.addClass("mod-warning");
			del.addEventListener("click", async () => {
				const latest =
					plugin.settings.providers.find((p) => p.id === profile.id) ??
					profile;
				const models = latest.models.filter((m) => m !== model);
				await update({
					models,
					defaultModel: models.includes(latest.defaultModel)
						? latest.defaultModel
						: (models[0] ?? ""),
				});
				redisplay();
			});
		}
	}

	const addRow = modelsBlock.createDiv({ cls: "ai-notebook-model-add-row" });
	const input = addRow.createEl("input", {
		type: "text",
		placeholder: "手动添加模型 ID（可选）",
	});
	input.addClass("ai-notebook-provider-input");
	const addBtn = addRow.createEl("button", { text: "添加" });
	const addModel = async () => {
		const id = input.value.trim();
		if (!id) return;
		const latest =
			plugin.settings.providers.find((p) => p.id === profile.id) ?? profile;
		if (latest.models.includes(id)) {
			new Notice("模型已存在");
			return;
		}
		const models = [...latest.models, id];
		await update({
			models,
			defaultModel: latest.defaultModel || id,
		});
		input.value = "";
		redisplay();
	};
	addBtn.addEventListener("click", () => void addModel());
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			void addModel();
		}
	});

	fetchBtn.addEventListener("click", async () => {
		const latest =
			plugin.settings.providers.find((p) => p.id === profile.id) ?? profile;
		if (!latest.baseUrl.trim() || !latest.apiKey.trim()) {
			new Notice("请先填写 Base URL 和 API Key");
			return;
		}
		// Drop placeholder model so user doesn't keep your-model-id
		fetchBtn.setText("获取中…");
		fetchBtn.setAttr("disabled", "true");
		const result = await gateway.listModels(latest);
		fetchBtn.setText("从上游获取模型");
		fetchBtn.removeAttribute("disabled");
		if (!result.ok) {
			// Long errors: show short toast + console
			const short =
				result.error.length > 120
					? result.error.slice(0, 120) + "…"
					: result.error;
			new Notice(`获取失败：${short}`);
			console.warn("[ai-notebook listModels]", result.error);
			// Still help: if list fails, offer whisper-1 for voice providers
			if (
				latest.name.includes("语音") ||
				latest.name.toLowerCase().includes("whisper")
			) {
				new Notice("提示：可手动添加模型 whisper-1 后点「设为默认」");
			}
			return;
		}
		let models = result.models;
		// Prefer keeping useful STT ids near top if present
		const stt = models.filter((m) =>
			/whisper|transcrib|speech|asr/i.test(m),
		);
		if (stt.length) {
			const rest = models.filter((m) => !stt.includes(m));
			models = [...stt, ...rest];
		}
		const defaultModel =
			(latest.defaultModel &&
			latest.defaultModel !== "your-model-id" &&
			models.includes(latest.defaultModel)
				? latest.defaultModel
				: null) ||
			stt[0] ||
			models[0] ||
			"";
		await update({ models, defaultModel });
		new Notice(`已获取 ${models.length} 个模型`);
		redisplay();
	});

	const tip = modelsBlock.createDiv({
		cls: "setting-item-description",
	});
	tip.setText(
		`当前默认：${current.defaultModel || "（无）"} · 共 ${current.models.length} 个 · 数据来自上游 GET /v1/models 或手动添加`,
	);

	// —— actions ——
	const actions = wrap.createDiv({ cls: "ai-notebook-provider-actions" });

	const testBtn = actions.createEl("button", { text: "测试连通" });
	testBtn.addEventListener("click", async () => {
		const latest =
			plugin.settings.providers.find((p) => p.id === profile.id) ?? profile;
		testBtn.setText("测试中…");
		testBtn.setAttr("disabled", "true");
		const result = await gateway.testConnection(latest);
		testBtn.setText("测试连通");
		testBtn.removeAttribute("disabled");
		if (result.ok) {
			new Notice(`连通成功：${result.content.slice(0, 80)}`);
		} else {
			new Notice(`连通失败：${result.error}`);
		}
	});

	if (!isDefault) {
		const defBtn = actions.createEl("button", { text: "设为默认" });
		defBtn.addEventListener("click", async () => {
			plugin.settings = {
				...plugin.settings,
				defaultProviderId: profile.id,
			};
			await plugin.saveSettings();
			redisplay();
		});
	}

	const delBtn = actions.createEl("button", { text: "删除服务商" });
	delBtn.addClass("mod-warning");
	delBtn.addEventListener("click", async () => {
		if (!confirm(`删除服务商「${profile.name}」？`)) return;
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
	});
}
