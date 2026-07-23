import { App, Modal, Notice } from "obsidian";
import type { BlueprintIndex, BlueprintVersionMeta, NotebookMeta } from "../domain/types";
import type AiNotebookPlugin from "../main";
import {
	CATEGORY_LABEL,
	listPluginCapabilitiesNewestFirst,
	type PluginCapabilityEntry,
} from "../domain/pluginChangelog";
import {
	recordRollbackIntent,
} from "../services/pluginHistoryStore";

const AUTHOR_LABEL: Record<BlueprintVersionMeta["author"], string> = {
	template: "模板初始化",
	user: "手动提交",
	ai: "语言改功能",
	"user-restore": "版本恢复",
};

type HistoryTab = "notebook" | "plugin";

/**
 * Dual-track history:
 * - 本内：当前记录本的蓝图功能版本（可真正 restore 配置）
 * - 插件：整体能力时间线（回退=标记目标包版本 + 安装指引，不改笔记）
 */
export class VersionHistoryModal extends Modal {
	private plugin: AiNotebookPlugin;
	private meta: NotebookMeta;
	private index: BlueprintIndex;
	private onRestored: () => void;
	private tab: HistoryTab = "notebook";
	private detailsCache = new Map<number, string[]>();

	constructor(
		app: App,
		plugin: AiNotebookPlugin,
		meta: NotebookMeta,
		index: BlueprintIndex,
		onRestored: () => void,
	) {
		super(app);
		this.plugin = plugin;
		this.meta = meta;
		this.index = index;
		this.onRestored = onRestored;
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ai-notebook-version-modal");
		contentEl.createEl("h2", { text: "历史版本" });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "两条独立时间线：左侧「本内功能」只改当前记录本的能力配置；右侧「插件整体」记录插件级功能演进。无论哪条线，都不会删除或改写 items 里的笔记正文。",
		});

		const tabBar = contentEl.createDiv({ cls: "ai-notebook-history-tabs" });
		const nbBtn = tabBar.createEl("button", { text: "本内功能历史" });
		const plBtn = tabBar.createEl("button", { text: "插件整体历史" });
		nbBtn.toggleClass("mod-cta", this.tab === "notebook");
		plBtn.toggleClass("mod-cta", this.tab === "plugin");
		nbBtn.addEventListener("click", () => {
			this.tab = "notebook";
			this.render();
		});
		plBtn.addEventListener("click", () => {
			this.tab = "plugin";
			this.render();
		});

		const body = contentEl.createDiv({ cls: "ai-notebook-history-body" });
		if (this.tab === "notebook") {
			this.renderNotebookTrack(body);
		} else {
			this.renderPluginTrack(body);
		}
	}

	private renderNotebookTrack(parent: HTMLElement): void {
		parent.createEl("p", {
			cls: "setting-item-description",
			text: `当前记录本「${this.meta.name}」· 功能配置 v${this.index.current} · 共 ${this.index.versions.length} 个蓝图版本。恢复会生成新版本记录，历史可追溯。`,
		});

		const versions = [...this.index.versions].reverse();
		if (versions.length === 0) {
			parent.createDiv({ cls: "ai-notebook-empty", text: "暂无本内版本记录。" });
			return;
		}

		for (const v of versions) {
			const row = parent.createDiv({ cls: "ai-notebook-version-card" });
			if (v.version === this.index.current) row.addClass("is-current");

			const head = row.createDiv({ cls: "ai-notebook-version-card-head" });
			head.createEl("h4", {
				text: `v${v.version}${v.version === this.index.current ? "（当前）" : ""}`,
			});
			head.createSpan({
				cls: "ai-notebook-version-author",
				text: AUTHOR_LABEL[v.author] ?? v.author,
			});

			row.createDiv({
				cls: "ai-notebook-version-summary",
				text: v.changeSummary || "（无摘要）",
			});

			const timeLine = row.createDiv({ cls: "ai-notebook-version-time" });
			timeLine.setText(
				`时间：${formatLocalDateTime(v.createdAt)}（${formatRelative(v.createdAt)}）`,
			);
			if (v.parentVersion != null) {
				timeLine.createSpan({ text: ` · 父版本 v${v.parentVersion}` });
			}
			if (v.restoredFrom != null) {
				timeLine.createSpan({ text: ` · 恢复自 v${v.restoredFrom}` });
			}

			const detailsBox = row.createDiv({ cls: "ai-notebook-version-details" });
			detailsBox.createDiv({
				cls: "ai-notebook-version-details-label",
				text: "改动详情（本内功能配置）",
			});
			const ul = detailsBox.createEl("ul");
			ul.createEl("li", { text: "加载中…" });
			void this.fillNotebookDetails(v, ul);

			if (v.sourcePrompt) {
				const det = row.createEl("details");
				det.createEl("summary", { text: "当时的改功能指令" });
				det.createEl("pre", { text: v.sourcePrompt });
			}

			const actions = row.createDiv({ cls: "ai-notebook-settings-actions" });
			if (v.version !== this.index.current) {
				const restoreBtn = actions.createEl("button", { text: "恢复此本内版本" });
				restoreBtn.addClass("mod-cta");
				restoreBtn.addEventListener("click", () => {
					void this.doNotebookRestore(v.version);
				});
			} else {
				actions.createSpan({
					cls: "setting-item-description",
					text: "当前本正在使用此功能配置 · 笔记数据不受版本切换影响",
				});
			}
		}
	}

	private renderPluginTrack(parent: HTMLElement): void {
		const hist = this.plugin.settings.pluginHistory;
		const installed =
			// manifest version is available via plugin
			(this.plugin.manifest?.version as string | undefined) ?? "0.1.1";

		parent.createEl("p", {
			cls: "setting-item-description",
			text: `当前运行：v${installed} · 偏好标记：${hist.preferredPluginVersion ?? "未设置"}。有本地存档时可一键切换；启动时自动把当前包备份到 package-archive/。笔记数据始终不动。`,
		});
		const archBtn = parent.createEl("button", { text: "立即备份当前安装包到本地存档" });
		archBtn.addEventListener("click", () => {
			void (async () => {
				const r = await this.plugin.packageArchive.archiveCurrentPackage();
				if (r.ok) new Notice(`已存档 v${r.version}`);
				else new Notice(r.error);
				this.render();
			})();
		});

		const caps = listPluginCapabilitiesNewestFirst();
		for (const cap of caps) {
			void this.renderCapabilityCard(parent, cap, installed);
		}

		if (hist.userNotes.length > 0) {
			parent.createEl("h3", { text: "你的操作记录" });
			const notes = [...hist.userNotes].reverse().slice(0, 20);
			for (const n of notes) {
				const row = parent.createDiv({ cls: "ai-notebook-version-card" });
				row.createDiv({
					cls: "ai-notebook-version-summary",
					text: n.text,
				});
				row.createDiv({
					cls: "ai-notebook-version-time",
					text: `${formatLocalDateTime(n.at)} · ${n.kind}${n.relatedPluginVersion ? ` · 目标包 ${n.relatedPluginVersion}` : ""}`,
				});
			}
		}
	}

	private async renderCapabilityCard(
		parent: HTMLElement,
		cap: PluginCapabilityEntry,
		installedVersion: string,
	): Promise<void> {
		const row = parent.createDiv({ cls: "ai-notebook-version-card" });
		const isInstalledLine = cap.pluginVersion === installedVersion;
		if (isInstalledLine) row.addClass("is-current");

		const head = row.createDiv({ cls: "ai-notebook-version-card-head" });
		head.createEl("h4", { text: cap.title });
		head.createSpan({
			cls: "ai-notebook-version-author",
			text: CATEGORY_LABEL[cap.category] ?? cap.category,
		});
		head.createSpan({
			cls: "ai-notebook-version-author",
			text: `包 v${cap.pluginVersion}`,
		});

		row.createDiv({
			cls: "ai-notebook-version-summary",
			text: cap.summary,
		});
		row.createDiv({
			cls: "ai-notebook-version-time",
			text: `时间节点：${cap.releasedAt}${isInstalledLine ? " · 当前安装包包含此能力" : ""}`,
		});

		const detailsBox = row.createDiv({ cls: "ai-notebook-version-details" });
		detailsBox.createDiv({
			cls: "ai-notebook-version-details-label",
			text: "能力详情（插件级）",
		});
		const ul = detailsBox.createEl("ul");
		for (const d of cap.details) {
			ul.createEl("li", { text: d });
		}

		const archived = await this.plugin.packageArchive.hasArchive(
			cap.pluginVersion,
		);
		row.createDiv({
			cls: "ai-notebook-version-time",
			text: archived
				? `本地安装包：已存档（package-archive/v${cap.pluginVersion}）· 可一键切换`
				: `本地安装包：尚未存档（该版本需曾安装运行过，或手动拷入 package-archive）`,
		});

		const actions = row.createDiv({ cls: "ai-notebook-settings-actions" });
		if (archived && cap.pluginVersion !== installedVersion) {
			const switchBtn = actions.createEl("button", {
				text: `一键切换到 v${cap.pluginVersion}`,
			});
			switchBtn.addClass("mod-cta");
			switchBtn.addEventListener("click", () => {
				void this.switchPluginPackage(cap.pluginVersion);
			});
		} else if (archived) {
			actions.createSpan({
				cls: "setting-item-description",
				text: "当前已是此包版本（本地存档齐全）",
			});
		} else {
			const miss = actions.createEl("button", {
				text: "无本地包 · 如何补档",
			});
			miss.addEventListener("click", () => {
				new Notice(
					[
						`缺少 v${cap.pluginVersion} 存档。可选：`,
						`1) 开发机 npm run package 后，复制 release/history/v${cap.pluginVersion}/`,
						`   到 .obsidian/plugins/ai-notebook/package-archive/v${cap.pluginVersion}/`,
						`2) 或临时安装该版本并打开一次插件（会自动归档）`,
						`不会影响笔记数据。`,
					].join("\n"),
					14000,
				);
			});
		}

		const markBtn = actions.createEl("button", {
			text: `仅标记偏好：v${cap.pluginVersion}`,
		});
		markBtn.addEventListener("click", () => {
			void this.markPluginRollback(cap);
		});
		const guideBtn = actions.createEl("button", { text: "说明" });
		guideBtn.addEventListener("click", () => {
			new Notice(
				[
					"插件整体历史会尽量在本地保留安装包。",
					"有存档时：「一键切换」覆盖 main.js / manifest / styles（不碰 data.json）。",
					"切换后请禁用再启用插件或重启 Obsidian。",
					"开发打包同时写入 release/history/vX.Y.Z。",
				].join("\n"),
				12000,
			);
		});
	}

	private async switchPluginPackage(version: string): Promise<void> {
		const ok = confirm(
			`一键将插件代码切换到本地存档 v${version}？\n\n` +
				`· 会先备份当前运行包\n` +
				`· 再覆盖 main.js / manifest.json / styles.css\n` +
				`· 不修改 data.json，不改任何笔记\n` +
				`· 完成后请禁用再启用本插件，或重启 Obsidian`,
		);
		if (!ok) return;
		new Notice("正在切换安装包…");
		const result = await this.plugin.packageArchive.switchToPackage(version);
		if (!result.ok) {
			new Notice(result.error);
			return;
		}
		this.plugin.settings = recordRollbackIntent(this.plugin.settings, version);
		await this.plugin.saveSettings();
		new Notice(
			`已写入 v${version} 的运行文件。请立即：禁用再启用「AI 记录本」，或重启 Obsidian。`,
			10000,
		);
		this.render();
	}

	private async markPluginRollback(cap: PluginCapabilityEntry): Promise<void> {
		const ok = confirm(
			`仅标记插件偏好版本为 v${cap.pluginVersion}？（不切换文件）`,
		);
		if (!ok) return;
		this.plugin.settings = recordRollbackIntent(
			this.plugin.settings,
			cap.pluginVersion,
			cap.id,
		);
		await this.plugin.saveSettings();
		new Notice(`已标记偏好包 v${cap.pluginVersion}`);
		this.render();
	}

	private async fillNotebookDetails(
		v: BlueprintVersionMeta,
		ul: HTMLElement,
	): Promise<void> {
		let details = this.detailsCache.get(v.version);
		if (!details) {
			details = await this.plugin.versions.resolveChangeDetails(
				this.meta.folderName,
				v,
			);
			this.detailsCache.set(v.version, details);
		}
		ul.empty();
		for (const line of details) {
			ul.createEl("li", { text: line });
		}
	}

	private async doNotebookRestore(targetVersion: number): Promise<void> {
		const confirmed = confirm(
			`确认将「本内功能」恢复为 v${targetVersion}？\n\n` +
				`· 不会删除或改写已有条目正文\n` +
				`· 会在本内历史新增一条「恢复自 v${targetVersion}」\n` +
				`· 与插件整体历史无关`,
		);
		if (!confirmed) return;
		try {
			const { version } = await this.plugin.versions.restore(
				this.meta.folderName,
				this.meta.notebook_id,
				targetVersion,
			);
			await this.plugin.notebooks.touchCurrentBlueprint(this.meta, version);
			new Notice(
				`已恢复本内功能至基于 v${targetVersion} 的新版本 v${version}`,
			);
			this.close();
			this.onRestored();
		} catch (e) {
			new Notice(`恢复失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function formatLocalDateTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		// allow YYYY-MM-DD
		if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
		return iso;
	}
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

function formatRelative(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const diffMs = Date.now() - d.getTime();
	const sec = Math.round(diffMs / 1000);
	if (sec < 60) return "刚刚";
	const min = Math.round(sec / 60);
	if (min < 60) return `${min} 分钟前`;
	const hr = Math.round(min / 60);
	if (hr < 48) return `${hr} 小时前`;
	const day = Math.round(hr / 24);
	if (day < 30) return `${day} 天前`;
	const mon = Math.round(day / 30);
	if (mon < 12) return `${mon} 个月前`;
	return `${Math.round(mon / 12)} 年前`;
}
