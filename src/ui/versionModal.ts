import { App, Modal, Notice, Setting } from "obsidian";
import type {
	BlueprintIndex,
	BlueprintVersionMeta,
	NotebookMeta,
	PluginReleaseCacheEntry,
	PluginVersionSource,
} from "../domain/types";
import type AiNotebookPlugin from "../main";
import {
	listPluginCapabilitiesNewestFirst,
} from "../domain/pluginChangelog";
import { createId } from "../domain/ids";
import {
	recordRollbackIntent,
} from "../services/pluginHistoryStore";
import {
	fetchGithubReleases,
	parseGithubRepoUrl,
	summarizeReleaseBody,
} from "../services/githubReleaseService";

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
 * - 插件：多来源 GitHub 安装包（按需拉取；显式切换；不改笔记）
 */
export class VersionHistoryModal extends Modal {
	private plugin: AiNotebookPlugin;
	private meta: NotebookMeta;
	private index: BlueprintIndex;
	private onRestored: () => void;
	private tab: HistoryTab = "notebook";
	private detailsCache = new Map<number, string[]>();
	/** When set, plugin track shows this source's release list. */
	private openSourceId: string | null = null;
	private busy = false;

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
			text:
				"两条独立时间线：左侧「本内功能」只改当前记录本的能力配置；" +
				"右侧「插件整体」可从多个 GitHub 来源按需拉取安装包并一键切换。" +
				"无论哪条线，都不会删除或改写 items 里的笔记正文。",
		});

		const tabBar = contentEl.createDiv({ cls: "ai-notebook-history-tabs" });
		const nbBtn = tabBar.createEl("button", { text: "本内功能历史" });
		const plBtn = tabBar.createEl("button", { text: "插件整体历史" });
		nbBtn.toggleClass("mod-cta", this.tab === "notebook");
		plBtn.toggleClass("mod-cta", this.tab === "plugin");
		nbBtn.addEventListener("click", () => {
			this.tab = "notebook";
			this.openSourceId = null;
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
			void this.renderPluginTrack(body);
		}
	}

	private renderNotebookTrack(parent: HTMLElement): void {
		parent.createEl("p", {
			cls: "setting-item-description",
			text:
				`当前记录本「${this.meta.name}」· 功能配置 v${this.index.current} · 共 ${this.index.versions.length} 个蓝图版本。` +
				`本列表即「本内蓝图版本线」：工具栏「另存蓝图版本」会把当前能力配置手动提交为新版本并出现在这里；` +
				`「恢复此本内版本」会再提交一条指向旧配置的新版本（历史可追溯）。` +
				`改的是功能配置（blueprints/），不会删除或改写 items 里的笔记正文。`,
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

	private getSources(): PluginVersionSource[] {
		return this.plugin.settings.pluginHistory?.sources ?? [];
	}

	private async saveSources(sources: PluginVersionSource[]): Promise<void> {
		this.plugin.settings = {
			...this.plugin.settings,
			pluginHistory: {
				...this.plugin.settings.pluginHistory,
				sources,
			},
		};
		await this.plugin.saveSettings();
	}

	private async renderPluginTrack(parent: HTMLElement): Promise<void> {
		const installed =
			(this.plugin.manifest?.version as string | undefined) ?? "0.0.0";
		const hist = this.plugin.settings.pluginHistory;

		if (this.openSourceId) {
			const src = this.getSources().find((s) => s.id === this.openSourceId);
			if (src) {
				await this.renderSourceReleases(parent, src, installed);
				return;
			}
			this.openSourceId = null;
		}

		parent.createEl("p", {
			cls: "setting-item-description",
			text:
				`当前运行：v${installed}` +
				(hist.preferredPluginVersion
					? ` · 偏好标记：${hist.preferredPluginVersion}`
					: "") +
				`。` +
				`下方可添加多个 GitHub 来源（类似 AI 服务商，一行一个）。` +
				`「拉取版本」只更新该来源的可选列表与本地缓存，不会改当前运行包；` +
				`只有点「使用此版本」才会覆盖 main.js / manifest.json / styles.css（不碰 data.json 与笔记）。` +
				`同版本号不同来源分开存档。`,
		});

		// Add source row
		const addBox = parent.createDiv({ cls: "ai-notebook-version-card" });
		addBox.createEl("h4", { text: "添加 GitHub 版本来源" });
		let nameVal = "";
		let urlVal = "";
		new Setting(addBox)
			.setName("显示名称")
			.setDesc("自定义，如「官方主仓」「某某 fork」")
			.addText((t) => {
				t.setPlaceholder("官方主仓");
				t.onChange((v) => {
					nameVal = v;
				});
			});
		new Setting(addBox)
			.setName("仓库链接")
			.setDesc("https://github.com/owner/repo 或 owner/repo")
			.addText((t) => {
				t.setPlaceholder("https://github.com/ZNaiGaomu/AI-notebook");
				t.inputEl.addClass("ai-notebook-provider-input");
				t.onChange((v) => {
					urlVal = v;
				});
			})
			.addButton((b) =>
				b
					.setButtonText("添加")
					.setCta()
					.onClick(() => {
						void this.addSource(nameVal, urlVal);
					}),
			);

		const sources = this.getSources();
		if (sources.length === 0) {
			parent.createDiv({
				cls: "ai-notebook-empty",
				text: "尚未添加来源。添加后可拉取版本（Release / Tags / 仓库快照）并切换。",
			});
		} else {
			const list = parent.createDiv({ cls: "ai-notebook-provider-row-list" });
			for (const src of sources) {
				this.renderSourceRow(list, src, installed);
			}
		}

		// Local backups — switchable list (separate from GitHub sources)
		const localBox = parent.createDiv({ cls: "ai-notebook-version-card" });
		localBox.createEl("h4", { text: "本地运行备份" });
		localBox.createEl("p", {
			cls: "setting-item-description",
			text:
				"备份当前运行的安装包到 package-archive/v{版本}/，并在下方列表显示，可一键切换回来。" +
				"与 GitHub 来源的同号版本分开列出（例如「本地备份 v0.2.0」≠「某来源 v0.2.0」）。" +
				"启动时也会自动备份一次。切换只覆盖 main.js / manifest / styles，不碰 data.json 与笔记。",
		});
		const archBtn = localBox.createEl("button", {
			text: "立即备份当前安装包到本地存档",
		});
		archBtn.addClass("mod-cta");
		archBtn.addEventListener("click", () => {
			void (async () => {
				const r = await this.plugin.packageArchive.archiveCurrentPackage();
				if (r.ok) new Notice(`已存档本地备份 v${r.version}，可在下方列表切换`);
				else new Notice(r.error);
				this.render();
			})();
		});

		const localListHost = parent.createDiv({
			cls: "ai-notebook-provider-row-list",
		});
		localListHost.createDiv({
			cls: "setting-item-description",
			text: "正在加载本地备份…",
		});
		void this.fillLocalBackupList(localListHost, installed);

		// Optional: built-in capability log as reference (collapsed)
		const caps = listPluginCapabilitiesNewestFirst();
		if (caps.length > 0) {
			const det = parent.createEl("details");
			det.createEl("summary", {
				text: "内置能力里程碑说明（补充参考，非安装包列表）",
			});
			const ref = det.createDiv({ cls: "setting-item-description" });
			ref.setText(
				"以下文案随插件代码发布，用于解释各版本大致能力；真正的安装包请从来源拉取。",
			);
			for (const cap of caps.slice(0, 12)) {
				const line = det.createDiv({ cls: "ai-notebook-version-time" });
				line.setText(`v${cap.pluginVersion} · ${cap.title} — ${cap.summary}`);
			}
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

	private renderSourceRow(
		list: HTMLElement,
		src: PluginVersionSource,
		installed: string,
	): void {
		const row = list.createDiv({ cls: "ai-notebook-provider-row" });
		const main = row.createDiv({ cls: "ai-notebook-provider-row-main" });
		const title = main.createDiv({ cls: "ai-notebook-provider-row-title" });
		title.createSpan({ text: src.name });
		main.createDiv({
			cls: "ai-notebook-provider-row-url",
			text: src.repoUrl || `${src.owner}/${src.repo}`,
		});
		const metaBits = [
			src.lastFetchedAt
				? `上次拉取 ${formatLocalDateTime(src.lastFetchedAt)}`
				: "尚未拉取",
			`远程缓存 ${src.cachedReleases.length} 个版本`,
		];
		main.createDiv({
			cls: "ai-notebook-provider-row-meta",
			text: metaBits.join(" · "),
		});

		const actions = row.createDiv({ cls: "ai-notebook-provider-row-actions" });
		const fetchBtn = actions.createEl("button", { text: "拉取版本" });
		fetchBtn.addEventListener("click", () => {
			void this.fetchSource(src.id);
		});
		const openBtn = actions.createEl("button", { text: "打开版本" });
		openBtn.addClass("mod-cta");
		openBtn.addEventListener("click", () => {
			this.openSourceId = src.id;
			this.render();
		});
		const delBtn = actions.createEl("button", { text: "删除" });
		delBtn.addEventListener("click", () => {
			void this.removeSource(src.id);
		});
		void installed; // reserved for future badge
	}

	private async addSource(name: string, url: string): Promise<void> {
		const parsed = parseGithubRepoUrl(url);
		if ("error" in parsed) {
			new Notice(parsed.error);
			return;
		}
		const display =
			name.trim() || `${parsed.owner}/${parsed.repo}`;
		const entry: PluginVersionSource = {
			id: createId(),
			name: display,
			repoUrl: parsed.canonicalUrl,
			owner: parsed.owner,
			repo: parsed.repo,
			lastFetchedAt: null,
			cachedReleases: [],
		};
		const sources = [...this.getSources(), entry];
		await this.saveSources(sources);
		new Notice(`已添加来源「${display}」。点「拉取版本」获取安装包列表（不会改当前运行包）。`);
		this.render();
	}

	private async removeSource(id: string): Promise<void> {
		const src = this.getSources().find((s) => s.id === id);
		if (!src) return;
		const ok = confirm(
			`删除来源「${src.name}」？\n仅移除配置与远程缓存列表，不会删除已下载的本地存档，也不会改当前运行包。`,
		);
		if (!ok) return;
		await this.saveSources(this.getSources().filter((s) => s.id !== id));
		if (this.openSourceId === id) this.openSourceId = null;
		new Notice("已删除来源");
		this.render();
	}

	private async fetchSource(id: string): Promise<void> {
		if (this.busy) return;
		const src = this.getSources().find((s) => s.id === id);
		if (!src) return;
		this.busy = true;
		new Notice(`正在从 GitHub 拉取 ${src.owner}/${src.repo} …`);
		try {
			const result = await fetchGithubReleases(src.owner, src.repo);
			if (!result.ok) {
				new Notice(result.error, 12000);
				return;
			}
			const updated: PluginVersionSource = {
				...src,
				lastFetchedAt: new Date().toISOString(),
				cachedReleases: result.releases,
			};
			await this.saveSources(
				this.getSources().map((s) => (s.id === id ? updated : s)),
			);
			const hint = (result.trace ?? []).slice(-3).join(" · ");
			new Notice(
				`已缓存 ${result.releases.length} 个可安装版本（未改变当前运行包）。` +
					(hint ? ` ${hint}` : ""),
				10000,
			);
			this.render();
		} finally {
			this.busy = false;
		}
	}

	private async renderSourceReleases(
		parent: HTMLElement,
		src: PluginVersionSource,
		installed: string,
	): Promise<void> {
		const back = parent.createEl("button", { text: "← 返回来源列表" });
		back.addEventListener("click", () => {
			this.openSourceId = null;
			this.render();
		});

		parent.createEl("h3", { text: `${src.name} · 版本列表` });
		parent.createEl("p", {
			cls: "setting-item-description",
			text:
				`${src.owner}/${src.repo}` +
				(src.lastFetchedAt
					? ` · 上次拉取 ${formatLocalDateTime(src.lastFetchedAt)}`
					: " · 尚未拉取，请点「拉取版本」") +
				`。下载只写入 package-archive/by-source/${src.id}/v…/；` +
				`「使用此版本」才会覆盖运行包。当前运行 v${installed}。`,
		});

		const toolbar = parent.createDiv({ cls: "ai-notebook-settings-actions" });
		const fetchBtn = toolbar.createEl("button", { text: "拉取 / 刷新版本" });
		fetchBtn.addClass("mod-cta");
		fetchBtn.addEventListener("click", () => {
			void this.fetchSource(src.id);
		});

		// re-read after potential fetch
		const fresh = this.getSources().find((s) => s.id === src.id) ?? src;
		const releases = fresh.cachedReleases;

		if (releases.length === 0) {
			parent.createDiv({
				cls: "ai-notebook-empty",
				text: "暂无版本缓存。点「拉取 / 刷新版本」：会依次尝试 Release → Tags → jsDelivr → 页面解析 → 默认分支。",
			});
			return;
		}

		for (let i = 0; i < releases.length; i++) {
			const rel = releases[i]!;
			const prev = releases[i + 1];
			await this.renderReleaseCard(parent, fresh, rel, prev, installed);
		}
	}

	private async renderReleaseCard(
		parent: HTMLElement,
		src: PluginVersionSource,
		rel: PluginReleaseCacheEntry,
		prev: PluginReleaseCacheEntry | undefined,
		installed: string,
	): Promise<void> {
		const row = parent.createDiv({ cls: "ai-notebook-version-card" });
		const isCurrent = rel.version === installed;
		if (isCurrent) row.addClass("is-current");

		const head = row.createDiv({ cls: "ai-notebook-version-card-head" });
		head.createEl("h4", {
			text: `v${rel.version}${isCurrent ? "（当前运行版本号）" : ""}`,
		});
		head.createSpan({
			cls: "ai-notebook-version-author",
			text: src.name,
		});

		row.createDiv({
			cls: "ai-notebook-version-summary",
			text: rel.name || rel.tagName || `v${rel.version}`,
		});
		row.createDiv({
			cls: "ai-notebook-version-time",
			text: rel.publishedAt
				? `发布：${formatLocalDateTime(rel.publishedAt)}（${formatRelative(rel.publishedAt)}）`
				: "发布时间未知",
		});

		const detailsBox = row.createDiv({ cls: "ai-notebook-version-details" });
		detailsBox.createDiv({
			cls: "ai-notebook-version-details-label",
			text: "版本说明 / 相对变化",
		});
		const ul = detailsBox.createEl("ul");
		const bodyLines = summarizeReleaseBody(rel.body, 10);
		if (bodyLines.length) {
			for (const line of bodyLines) ul.createEl("li", { text: line });
		} else {
			ul.createEl("li", { text: "此 Release 未提供说明正文。" });
		}
		// built-in capability hints for same version
		const caps = listPluginCapabilitiesNewestFirst().filter(
			(c) => c.pluginVersion === rel.version,
		);
		if (caps.length) {
			ul.createEl("li", {
				text: `内置能力要点：${caps.map((c) => c.title).join("；")}`,
			});
		}
		if (prev) {
			ul.createEl("li", {
				text: `上一缓存版本：v${prev.version}（对比请以 Release 说明为准）`,
			});
		}

		const hasLocal = await this.plugin.packageArchive.hasSourceArchive(
			src.id,
			rel.version,
		);
		row.createDiv({
			cls: "ai-notebook-version-time",
			text: hasLocal
				? `本地存档：已下载（package-archive/by-source/${src.id}/v${rel.version}）`
				: "本地存档：未下载",
		});

		const actions = row.createDiv({ cls: "ai-notebook-settings-actions" });
		if (!hasLocal) {
			const dl = actions.createEl("button", { text: "下载到本地" });
			dl.addEventListener("click", () => {
				void this.downloadRelease(src, rel);
			});
		}
		const useBtn = actions.createEl("button", {
			text: hasLocal ? `使用此版本（${src.name}）` : "下载并使用",
		});
		useBtn.addClass("mod-cta");
		useBtn.addEventListener("click", () => {
			void this.useRelease(src, rel, hasLocal);
		});
		if (rel.htmlUrl) {
			const open = actions.createEl("button", { text: "打开 Release 页" });
			open.addEventListener("click", () => {
				window.open(rel.htmlUrl, "_blank");
			});
		}
	}

	private async downloadRelease(
		src: PluginVersionSource,
		rel: PluginReleaseCacheEntry,
	): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		new Notice(`正在下载 v${rel.version}（${src.name}）…`);
		try {
			const r = await this.plugin.packageArchive.downloadReleaseToArchive({
				sourceId: src.id,
				sourceName: src.name,
				release: rel,
				owner: src.owner,
				repo: src.repo,
			});
			if (!r.ok) {
				new Notice(r.error);
				return;
			}
			new Notice(`已下载到本地存档 v${r.version}（未切换运行包）`);
			this.render();
		} finally {
			this.busy = false;
		}
	}

	private async useRelease(
		src: PluginVersionSource,
		rel: PluginReleaseCacheEntry,
		hasLocal: boolean,
	): Promise<void> {
		if (this.busy) return;
		const ok = confirm(
			`将插件代码切换为：\n\n` +
				`来源：${src.name}\n` +
				`版本：v${rel.version}\n\n` +
				`· 会先备份当前运行包\n` +
				`· 再覆盖 main.js / manifest.json / styles.css\n` +
				`· 不修改 data.json，不改任何笔记\n` +
				`· 完成后请禁用再启用本插件，或重启 Obsidian\n\n` +
				(hasLocal ? "" : "本地尚无存档，将先下载再切换。\n"),
		);
		if (!ok) return;

		this.busy = true;
		try {
			if (!hasLocal) {
				new Notice(`正在下载 v${rel.version}…`);
				const dl = await this.plugin.packageArchive.downloadReleaseToArchive({
					sourceId: src.id,
					sourceName: src.name,
					release: rel,
					owner: src.owner,
					repo: src.repo,
				});
				if (!dl.ok) {
					new Notice(dl.error);
					return;
				}
			}
			new Notice("正在切换安装包…");
			const result = await this.plugin.packageArchive.switchToPackage(
				rel.version,
				{ sourceId: src.id, sourceName: src.name },
			);
			if (!result.ok) {
				new Notice(result.error);
				return;
			}
			this.plugin.settings = recordRollbackIntent(
				this.plugin.settings,
				rel.version,
			);
			await this.plugin.saveSettings();
			new Notice(
				`已写入「${src.name}」v${rel.version}。请立即：禁用再启用「AI 记录本」，或重启 Obsidian。`,
				12000,
			);
			this.render();
		} finally {
			this.busy = false;
		}
	}

	private async fillLocalBackupList(
		host: HTMLElement,
		installed: string,
	): Promise<void> {
		const backups = await this.plugin.packageArchive.listLocalBackups();
		host.empty();
		if (backups.length === 0) {
			host.createDiv({
				cls: "ai-notebook-empty",
				text: "暂无本地备份。点上方「立即备份」后会出现在这里，并可一键切换。",
			});
			return;
		}
		for (const bak of backups) {
			const row = host.createDiv({ cls: "ai-notebook-version-card" });
			const isCurrent = bak.version === installed;
			if (isCurrent) row.addClass("is-current");

			const head = row.createDiv({ cls: "ai-notebook-version-card-head" });
			head.createEl("h4", {
				text: `v${bak.version}${isCurrent ? "（版本号与当前运行相同）" : ""}`,
			});
			head.createSpan({
				cls: "ai-notebook-version-author",
				text: "本地备份",
			});

			row.createDiv({
				cls: "ai-notebook-version-summary",
				text: bak.sourceName || "本地运行备份",
			});
			row.createDiv({
				cls: "ai-notebook-version-time",
				text: bak.archivedAt
					? `备份时间：${formatLocalDateTime(bak.archivedAt)}（${formatRelative(bak.archivedAt)}）`
					: `路径：${bak.path}`,
			});
			row.createDiv({
				cls: "ai-notebook-version-time",
				text: `存档：${bak.path}`,
			});

			const actions = row.createDiv({ cls: "ai-notebook-settings-actions" });
			const switchBtn = actions.createEl("button", {
				text: "切换到此本地备份",
			});
			switchBtn.addClass("mod-cta");
			switchBtn.addEventListener("click", () => {
				void this.switchLocalBackup(bak.version);
			});
		}
	}

	private async switchLocalBackup(version: string): Promise<void> {
		if (this.busy) return;
		const ok = confirm(
			`将插件代码切换为「本地备份」v${version}？

` +
				`· 会先再备份一次当前运行包
` +
				`· 再覆盖 main.js / manifest.json / styles.css
` +
				`· 不修改 data.json，不改任何笔记
` +
				`· 完成后请禁用再启用本插件，或重启 Obsidian`,
		);
		if (!ok) return;
		this.busy = true;
		try {
			new Notice("正在切换到本地备份…");
			const result = await this.plugin.packageArchive.switchToPackage(version, {
				sourceId: null,
				sourceName: "本地运行备份",
			});
			if (!result.ok) {
				new Notice(result.error);
				return;
			}
			this.plugin.settings = recordRollbackIntent(
				this.plugin.settings,
				version,
			);
			await this.plugin.saveSettings();
			new Notice(
				`已写入本地备份 v${version}。请立即：禁用再启用「AI 记录本」，或重启 Obsidian。`,
				12000,
			);
			this.render();
		} finally {
			this.busy = false;
		}
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
				`· 与插件整体历史无关\n` +
				`· 与工具栏「另存蓝图版本」同一条版本线`,
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
