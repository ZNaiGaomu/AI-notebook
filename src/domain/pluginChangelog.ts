/**
 * Append-only registry of plugin-wide capability milestones.
 * This is the "outer" history: whole-plugin features, not per-notebook blueprints.
 *
 * Rules:
 * - Only add new entries at the end; never rewrite past ids.
 * - Does not store user note data; only describes shipped plugin capabilities.
 * - Notebook item bodies are never tied to these entries.
 */

export type PluginCapabilityCategory =
	| "core"
	| "blueprint"
	| "cabinet"
	| "voice"
	| "bridge"
	| "inbox"
	| "ui"
	| "history";

export type PluginCapabilityEntry = {
	/** Stable id — never reuse or change meaning */
	id: string;
	/** Semver of the plugin package that includes this capability */
	pluginVersion: string;
	/** Short title for list */
	title: string;
	/** One-line summary */
	summary: string;
	/** Bullet details for the history UI */
	details: string[];
	/** When this capability landed (ISO date, calendar day is enough) */
	releasedAt: string;
	category: PluginCapabilityCategory;
};

/**
 * Chronological capability log (oldest → newest).
 * Update this whenever a user-visible plugin capability ships.
 */
export const PLUGIN_CAPABILITY_LOG: PluginCapabilityEntry[] = [
	{
		id: "cap-0.1.0-p0-p1",
		pluginVersion: "0.1.0",
		title: "多本 + 蓝图底座（P0/P1）",
		summary: "多实例记录本、模板、条目 CRUD、蓝图校验与版本提交/恢复",
		details: [
			"多实例记录本：每本独立文件夹 + _notebook.md",
			"模板：空白 / 文献 / 灵感 / 会议 / 收藏向",
			"条目 Markdown 独立存储；软删除进 .trash",
			"蓝图 Zod 校验；版本 commit / restore（恢复=新提交，数据不动）",
			"未映射字段投影：回滚功能不删 frontmatter 未知键",
			"Diff 确认后再应用功能变更",
		],
		releasedAt: "2026-07-19",
		category: "core",
	},
	{
		id: "cap-0.1.0-p2-ai-feature",
		pluginVersion: "0.1.0",
		title: "用语言改功能（P2）",
		summary: "自然语言 → 完整蓝图 → Diff 确认 → 提交新功能版本",
		details: [
			"FeatureOrchestrator：AI 产蓝图 JSON",
			"助手 / 改功能对话模式强分离",
			"多 Provider + planner/worker/voice 用途路由",
			"改功能上下文可保留多轮（ChatHistory）",
		],
		releasedAt: "2026-07-19",
		category: "blueprint",
	},
	{
		id: "cap-0.1.0-p3-cabinet",
		pluginVersion: "0.1.0",
		title: "收藏柜 links/files（P3）",
		summary: "每本链接与文件索引；附件复制入库约定",
		details: [
			"cabinet/links.json 与 files.json",
			"attachIfUrl：条目有 url 时可写入链接柜",
			"解析链接标题（本地从 URL 推断，非整站抓取）",
		],
		releasedAt: "2026-07-19",
		category: "cabinet",
	},
	{
		id: "cap-0.1.0-p4-voice",
		pluginVersion: "0.1.0",
		title: "语音转写录入（P4）",
		summary: "录音 → transcriptions / 多模态回退 → 可选 AI 整理入库",
		details: [
			"VoiceService + VoicePipeline",
			"语音诊断命令（不打印 API Key）",
			"转写原文可落 AI Inbox/voice-raw",
		],
		releasedAt: "2026-07-19",
		category: "voice",
	},
	{
		id: "cap-0.1.0-inbox-bridge",
		pluginVersion: "0.1.0",
		title: "收件箱与手机网页入口",
		summary: "跨端投递 + 局域网/公网隧道写回 vault 并 AI 整理",
		details: [
			"AI Inbox/pending → 处理收件箱 → 记录本 items",
			"桌面本地 HTTP 手机页（token）",
			"cloudflared / 手动 ngrok 公网隧道",
		],
		releasedAt: "2026-07-19",
		category: "bridge",
	},
	{
		id: "cap-0.1.0-hooks-views",
		pluginVersion: "0.1.0",
		title: "蓝图钩子与 list/table/board 视图",
		summary: "onCreate 真执行；列表排序筛选；表格与看板",
		details: [
			"HookRunner：notify / cabinet.attachIfUrl / ai.extract",
			"entity.list.sort 与 filterFields 生效",
			"视图切换：列表 / 表格 / 看板（select 字段分列）",
			"创建/收件箱/语音等路径统一跑 onCreate 钩子",
		],
		releasedAt: "2026-07-21",
		category: "blueprint",
	},
	{
		id: "cap-0.1.0-cabinet-import-ui",
		pluginVersion: "0.1.0",
		title: "收藏柜补全入口",
		summary: "链接 Modal；从 vault 选择；从电脑导入并复制到附件目录",
		details: [
			"添加链接：URL + 标题 + 备注表单",
			"从库选择文件：FuzzySuggest 登记路径",
			"从电脑导入：系统选文件 → attachments/ai-notebook/{notebook_id}/",
			"文件详情：在库中打开 / 删除记录",
		],
		releasedAt: "2026-07-21",
		category: "cabinet",
	},
	{
		id: "cap-0.1.0-blueprint-history-details",
		pluginVersion: "0.1.0",
		title: "本内功能版本明细",
		summary: "蓝图历史带 changeDetails、本地时间与相对时间",
		details: [
			"commit 自动生成改动明细（字段/视图/钩子/收藏柜等）",
			"旧版本可按相邻蓝图文件补算详情",
			"版本历史弹窗展示摘要 + 详情列表 + 时间节点",
		],
		releasedAt: "2026-07-21",
		category: "history",
	},
	{
		id: "cap-0.1.1-dual-history",
		pluginVersion: "0.1.1",
		title: "双轨历史：本内蓝图 + 插件整体",
		summary: "并排查看本内功能版本与插件能力时间线；插件回退提供安装指引（不改笔记数据）",
		details: [
			"本内历史：仍只作用于当前记录本的 blueprints/",
			"插件整体历史：记录插件级能力里程碑与时间",
			"笔记 items 数据与功能版本完全隔离，回退功能配置不删正文",
			"插件代码回退需重装对应 release 包；历史中提供指引与标记",
		],
		releasedAt: "2026-07-21",
		category: "history",
	},
];

export function listPluginCapabilitiesNewestFirst(): PluginCapabilityEntry[] {
	return [...PLUGIN_CAPABILITY_LOG].reverse();
}

export function getPluginCapability(id: string): PluginCapabilityEntry | undefined {
	return PLUGIN_CAPABILITY_LOG.find((e) => e.id === id);
}

export function latestPluginCapability(): PluginCapabilityEntry | undefined {
	return PLUGIN_CAPABILITY_LOG[PLUGIN_CAPABILITY_LOG.length - 1];
}

export const CATEGORY_LABEL: Record<PluginCapabilityCategory, string> = {
	core: "核心",
	blueprint: "蓝图/功能",
	cabinet: "收藏柜",
	voice: "语音",
	bridge: "跨端",
	inbox: "收件箱",
	ui: "界面",
	history: "历史",
};
