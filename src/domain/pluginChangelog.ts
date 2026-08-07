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
	{
		id: "cap-0.2.0-float-assistant",
		pluginVersion: "0.2.0",
		title: "浮层助手真写入与多模型回退",
		summary: "可拖拽浮层对话；助手改正文/字段/嵌媒体；规划/助手/语音有序回退",
		details: [
			"浮层助手：收放、尺寸记忆、排队/引导、本轮附件隔离",
			"结构化动作：update_item / create_item / embed_in_body",
			"拖拽粘贴上传；对话附件落盘与历史附件管理",
			"按条目会话历史；用途级多模型链 1→2→3",
		],
		releasedAt: "2026-07-24",
		category: "ui",
	},
	{
		id: "cap-0.3.0-package-sources",
		pluginVersion: "0.3.0",
		title: "GitHub 多来源安装包 + 本地备份切换",
		summary: "多行 GitHub 来源按需拉取 Tags/Release/Code ZIP；本地备份列表一键切换；不改笔记",
		details: [
			"插件整体历史：仿 AI 服务商一行一个 GitHub 来源",
			"拉取回退：Tags 页面 → jsDelivr → Release API → Tags API → 默认分支 Code ZIP",
			"下载优先 github.com/.../archive/refs/tags/vX.Y.Z.zip；失败再 raw/jsDelivr 三文件",
			"按来源分目录 package-archive/by-source/{id}/vX.Y.Z/（同号不同源隔离）",
			"本地运行备份列表可切换；启动同版本已存在则跳过自动备份",
			"本内历史说明挂钩「另存蓝图版本」；单视图隐藏「列表」标签；移除快速捕获",
		],
		releasedAt: "2026-07-25",
		category: "history",
	},
	{
		id: "cap-0.3.0-voice-routing",
		pluginVersion: "0.3.0",
		title: "语音流水线与用途路由增强",
		summary: "录音格式协商、STT 多模型 fan-out、转写后润色、诊断与 WAV 转码",
		details: [
			"voice 用途链 + modelFanout；transcriptions 失败可 chat 听音频回退",
			"可选转码 16k mono WAV；润色 prompt 可配置",
			"语音诊断命令；进度芯片位置记忆",
		],
		releasedAt: "2026-07-25",
		category: "voice",
	},

		{
			id: "cap-0.4.0-manual-items-tailscale",
			pluginVersion: "0.4.0",
			title: "手工条目吸收 + Tailscale 手机入口",
			summary: "items 手工文件自动成条目；手机 Tailscale 虚拟局域网入口更稳",
			details: [
				"items 下手工 Markdown / 非 Markdown 文件可被吸收为条目",
				"Tailscale 100.x 地址单独列出，手机远程写入更稳",
			],
			releasedAt: "2026-07-28",
			category: "bridge",
		},
		{
			id: "cap-0.5.0-mobile-targeted-writes",
			pluginVersion: "0.5.0",
			title: "手机端定向写入已有条目",
			summary: "手机可选记录本/条目；文字、语音、文件可追加到目标正文末尾",
			details: [
				"手机网页选择已有条目并追加正文",
				"手机端新建记录本与命名条目",
				"待发送队列保留记录本/条目目标",
			],
			releasedAt: "2026-07-29",
			category: "bridge",
		},
		{
			id: "cap-0.6.0-attachment-system",
			pluginVersion: "0.6.0",
			title: "独立附件管理与标题目录",
			summary: "附件与收藏柜分离；按条目标题分类；改名同步；正文嵌入与删除互不影响",
			details: [
				"AttachmentService + AI Notebooks/<本>/attachments/index.json",
				"物理路径：attachments/ai-notebook/{记录本标题}/items/{条目标题}/",
				"条目改名时重命名附件目录，并尽量修正正文 ![[旧路径]]",
				"正文粘贴/拖入媒体可自动吸入对应条目附件目录",
				"默认解除登记不删实体文件，不改正文",
			],
			releasedAt: "2026-08-05",
			category: "core",
		},
		{
			id: "cap-0.6.0-inbox-media-organize",
			pluginVersion: "0.6.0",
			title: "收件箱跨本整理 + 媒体可预览",
			summary: "收件箱可选记录本/已有条目；文件收件箱保存二进制并在整理后可看图/听音",
			details: [
				"收件箱详情：目标记录本、目标条目、AI 开关、直接整理",
				"仅收件箱文件走 dumpBinary（AI Inbox/files + ![[embed]]）",
				"整理时把收件箱媒体吸入附件管理并保留正文预览",
				"AI 整理强制保留 Obsidian 媒体嵌入",
			],
			releasedAt: "2026-08-05",
			category: "inbox",
		},
		{
			id: "cap-0.7.0-android-app",
			pluginVersion: "0.7.0",
			title: "原生 Android App 与稳定条目名",
			summary: "Android 10+ 速记工坊；离线队列；条目显示名统一为 items 文件名",
			details: [
				"原生 App：文字 / 录音 / 文件、待发送、垃圾箱、扫码连接",
				"手机来源双通道：App 私有副本 + 原始 content URI",
				"列表与附件归属统一使用 items/*.md 文件名",
				"语音重新转写使用 Obsidian 隐藏注释",
			],
			releasedAt: "2026-08-06",
			category: "bridge",
		},
		{
			id: "cap-0.8.0-item-folder-sync",
			pluginVersion: "0.8.0",
			title: "条目改名全量同步 + 语音 fail-closed",
			summary: "改名同步附件/收藏柜/chat-uploads/残留目录；缺文件不写悬空嵌入",
			details: [
				"itemFolderSync：attachments + cabinet + chat-uploads + residual",
				"同 item_id 历史目录收敛，避免 666-2 伪碰撞",
				"语音/附件移动前校验物理文件存在",
				"聊天历史 vaultPath 随 rewrites 更新",
			],
			releasedAt: "2026-08-07",
			category: "core",
		},
		{
			id: "cap-0.8.0-android-recent-nav",
			pluginVersion: "0.8.0",
			title: "Android 最近三层导航与严格打开",
			summary: "记录本→条目→历史；行内删除；打开文件严格匹配来源",
			details: [
				"最近页：一行一记录本 / 一条目，右侧进入下一级",
				"统一「打开文件」：本地副本优先，原 URI 需元数据校验",
				"clientSourceId 精确匹配，禁止弱回退开错文件",
				"删除移到记录行右侧，不碰电脑 vault",
			],
			releasedAt: "2026-08-07",
			category: "ui",
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
