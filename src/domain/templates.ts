import type { Blueprint, TemplateId } from "./types";

export type TemplateInfo = {
	id: TemplateId;
	label: string;
	description: string;
};

export const TEMPLATES: TemplateInfo[] = [
	{
		id: "blank",
		label: "空白本",
		description: "仅标题与正文，用语言慢慢长出功能",
	},
	{
		id: "literature",
		label: "文献本",
		description: "URL、状态、作者与笔记，适合文献搜集",
	},
	{
		id: "idea",
		label: "灵感本",
		description: "快速记下想法与标签",
	},
	{
		id: "meeting",
		label: "会议本",
		description: "会议纪要、参与人与决议",
	},
	{
		id: "cabinet-first",
		label: "收藏向",
		description: "轻量条目 + 默认开启收藏柜",
	},
];

function baseUi(home: string): Blueprint["ui"] {
	return {
		primaryView: "list",
		homePrompt: home,
		featureEditPrompt: "描述你想如何改这个记录本的功能…",
	};
}

function baseAi(hints: string): Blueprint["aiBehaviors"] {
	return {
		systemHints: hints,
		allowedTools: ["searchItems", "createItem", "updateItem"],
	};
}

export function buildTemplateBlueprint(
	templateId: TemplateId,
	notebookName: string,
): Blueprint {
	switch (templateId) {
		case "literature":
			return {
				$schema: "ai-notebook-blueprint/v1",
				blueprintVersion: 1,
				name: notebookName,
				description: "模板：文献搜集",
				entityTypes: [
					{
						id: "literature",
						label: "文献",
						fields: [
							{ id: "title", label: "标题", type: "text", required: true, showInList: true },
							{ id: "url", label: "链接", type: "url", showInList: true },
							{ id: "authors", label: "作者", type: "text" },
							{
								id: "status",
								label: "状态",
								type: "select",
								options: ["to-read", "reading", "done"],
								showInList: true,
							},
							{ id: "notes", label: "笔记", type: "markdown" },
						],
						list: { sort: "updated_desc", filterFields: ["status", "tags"] },
					},
				],
				views: [
					{ id: "main", type: "list", entityType: "literature" },
					{ id: "table", type: "table", entityType: "literature" },
					{ id: "board", type: "board", entityType: "literature" },
				],
				commands: [
					{
						id: "quick-capture",
						label: "快速捕获",
						action: "openCaptureModal",
						entityType: "literature",
					},
				],
				hooks: {
					onCreate: [
						{ type: "notify", message: "已创建文献条目" },
						{ type: "cabinet.attachIfUrl" },
					],
				},
				cabinet: { enabled: true, buckets: ["links", "files"] },
				aiBehaviors: baseAi("你是文献助手，帮助整理阅读材料。"),
				ui: baseUi("记录一篇文献、链接或阅读笔记…"),
			};
		case "idea":
			return {
				$schema: "ai-notebook-blueprint/v1",
				blueprintVersion: 1,
				name: notebookName,
				description: "模板：灵感",
				entityTypes: [
					{
						id: "idea",
						label: "灵感",
						fields: [
							{ id: "title", label: "标题", type: "text", required: true, showInList: true },
							{ id: "body", label: "内容", type: "markdown" },
							{ id: "tags", label: "标签", type: "tags", showInList: true },
							{
								id: "mood",
								label: "情绪",
								type: "select",
								options: ["spark", "curious", "urgent", "calm"],
								showInList: true,
							},
						],
						list: { sort: "updated_desc", filterFields: ["mood", "tags"] },
					},
				],
				views: [
					{ id: "main", type: "list", entityType: "idea" },
					{ id: "board", type: "board", entityType: "idea" },
				],
				commands: [
					{
						id: "quick-capture",
						label: "快速捕获",
						action: "openCaptureModal",
						entityType: "idea",
					},
				],
				hooks: { onCreate: [] },
				cabinet: { enabled: false, buckets: ["links", "files"] },
				aiBehaviors: baseAi("你是灵感助手，帮助提炼与扩展想法。"),
				ui: baseUi("记下你的灵感…"),
			};
		case "meeting":
			return {
				$schema: "ai-notebook-blueprint/v1",
				blueprintVersion: 1,
				name: notebookName,
				description: "模板：会议",
				entityTypes: [
					{
						id: "meeting",
						label: "会议",
						fields: [
							{ id: "title", label: "主题", type: "text", required: true, showInList: true },
							{ id: "date", label: "日期", type: "date", showInList: true },
							{ id: "attendees", label: "参与人", type: "text" },
							{ id: "decisions", label: "决议", type: "markdown" },
							{ id: "notes", label: "纪要", type: "markdown" },
						],
						list: { sort: "updated_desc" },
					},
				],
				views: [
					{ id: "main", type: "list", entityType: "meeting" },
					{ id: "table", type: "table", entityType: "meeting" },
				],
				commands: [
					{
						id: "quick-capture",
						label: "快速捕获",
						action: "openCaptureModal",
						entityType: "meeting",
					},
				],
				hooks: { onCreate: [] },
				cabinet: { enabled: false, buckets: ["links", "files"] },
				aiBehaviors: baseAi("你是会议纪要助手。"),
				ui: baseUi("记录一次会议…"),
			};
		case "cabinet-first":
			return {
				$schema: "ai-notebook-blueprint/v1",
				blueprintVersion: 1,
				name: notebookName,
				description: "模板：收藏向",
				entityTypes: [
					{
						id: "clip",
						label: "条目",
						fields: [
							{ id: "title", label: "标题", type: "text", required: true, showInList: true },
							{ id: "url", label: "链接", type: "url", showInList: true },
							{ id: "notes", label: "备注", type: "markdown" },
						],
						list: { sort: "updated_desc" },
					},
				],
				views: [
					{ id: "main", type: "list", entityType: "clip" },
					{ id: "table", type: "table", entityType: "clip" },
				],
				commands: [
					{
						id: "quick-capture",
						label: "快速捕获",
						action: "openCaptureModal",
						entityType: "clip",
					},
				],
				hooks: {
					onCreate: [
						{ type: "notify", message: "已收藏条目" },
						{ type: "cabinet.attachIfUrl" },
					],
				},
				cabinet: { enabled: true, buckets: ["links", "files"] },
				aiBehaviors: baseAi("你是收藏整理助手。"),
				ui: baseUi("收藏链接或材料…"),
			};
		case "blank":
		default:
			return {
				$schema: "ai-notebook-blueprint/v1",
				blueprintVersion: 1,
				name: notebookName,
				description: "空白记录本",
				entityTypes: [
					{
						id: "note",
						label: "笔记",
						fields: [
							{ id: "title", label: "标题", type: "text", required: true, showInList: true },
							{ id: "body", label: "正文", type: "markdown" },
							{ id: "tags", label: "标签", type: "tags", showInList: true },
						],
						list: { sort: "updated_desc" },
					},
				],
				views: [{ id: "main", type: "list", entityType: "note" }],
				commands: [
					{
						id: "quick-capture",
						label: "快速捕获",
						action: "openCaptureModal",
						entityType: "note",
					},
				],
				hooks: { onCreate: [] },
				cabinet: { enabled: false, buckets: ["links", "files"] },
				aiBehaviors: baseAi("你是通用记录助手。"),
				ui: baseUi("写下你想记录的内容…"),
			};
	}
}
