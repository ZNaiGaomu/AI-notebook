/** Shared domain types for AI Notebook (P0/P1). */

export type FieldType =
	| "text"
	| "markdown"
	| "number"
	| "date"
	| "url"
	| "select"
	| "multi-select"
	| "tags"
	| "checkbox"
	| "note-ref"
	| "file-ref";

export type BlueprintField = {
	id: string;
	label: string;
	type: FieldType;
	required?: boolean;
	showInList?: boolean;
	options?: string[];
};

export type EntityTypeDef = {
	id: string;
	label: string;
	fields: BlueprintField[];
	list?: {
		sort?: "updated_desc" | "updated_asc" | "created_desc" | "title_asc";
		filterFields?: string[];
	};
};

export type BlueprintView = {
	id: string;
	type: "list" | "detail" | "table" | "board";
	entityType: string;
};

export type BlueprintCommand = {
	id: string;
	label: string;
	action: "openCaptureModal" | "openChat" | "openFeatureEdit" | "refreshList";
	entityType?: string;
};

export type HookStep =
	| { type: "notify"; message: string }
	| { type: "ai.extract" }
	| { type: "cabinet.attachIfUrl" };

export type Blueprint = {
	$schema: "ai-notebook-blueprint/v1";
	blueprintVersion: number;
	name: string;
	description: string;
	entityTypes: EntityTypeDef[];
	views: BlueprintView[];
	commands: BlueprintCommand[];
	hooks: {
		onCreate: HookStep[];
	};
	cabinet: {
		enabled: boolean;
		buckets: Array<"links" | "files">;
	};
	aiBehaviors: {
		systemHints: string;
		allowedTools: string[];
	};
	ui: {
		primaryView: "list";
		homePrompt: string;
		featureEditPrompt: string;
	};
};

export type BlueprintVersionMeta = {
	version: number;
	file: string;
	createdAt: string;
	author: "template" | "user" | "ai" | "user-restore";
	sourcePrompt: string | null;
	/** 一句话摘要（列表标题） */
	changeSummary: string;
	/**
	 * 结构化改动明细（人话），如「新增字段 status」「开启收藏柜」。
	 * 旧版本可能缺失；UI 会按需从相邻蓝图 diff 补算。
	 */
	changeDetails?: string[];
	parentVersion: number | null;
	restoredFrom?: number;
};

export type BlueprintIndex = {
	notebook_id: string;
	current: number;
	versions: BlueprintVersionMeta[];
};

export type NotebookMeta = {
	type: "ai-notebook";
	notebook_id: string;
	name: string;
	template_id: string;
	current_blueprint: number;
	created: string;
	updated: string;
	provider_profile_id: string | null;
	model_overrides: {
		planner: string | null;
		worker: string | null;
		voice: string | null;
	};
	/** Folder name under notebooks root (display path segment). */
	folderName: string;
};

export type ItemFrontmatter = {
	ai_notebook: true;
	notebook_id: string;
	item_id: string;
	schema_version: number;
	entity_type: string;
	title: string;
	tags: string[];
	cabinet_refs: string[];
	created: string;
	updated: string;
	[key: string]: unknown;
};

export type NotebookItem = {
	path: string;
	frontmatter: ItemFrontmatter;
	body: string;
};

export type TemplateId =
	| "blank"
	| "literature"
	| "idea"
	| "meeting"
	| "cabinet-first";

export type ProviderProfile = {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	models: string[];
	defaultModel: string;
};

export type PurposeRouting = {
	planner: { providerId: string | null; model: string | null };
	worker: { providerId: string | null; model: string | null };
	voice: { providerId: string | null; model: string | null };
};

export type AiNotebookSettings = {
	schemaVersion: number;
	providers: ProviderProfile[];
	defaultProviderId: string | null;
	purposeRouting: PurposeRouting;
	paths: {
		notebooksRoot: string;
		attachmentsRoot: string;
		/** Mobile / quick dump folder inside vault (synced by Obsidian Sync etc.) */
		inboxRoot: string;
	};
	privacy: {
		attachTopKItems: boolean;
		topK: number;
		allowCurrentNoteContext: boolean;
	};
	inbox: {
		/** After AI organize, move source note to processed/ */
		archiveAfterOrganize: boolean;
		/** When capturing voice, also run AI field extract */
		autoOrganizeVoice: boolean;
		/** Default notebook id for inbox → notebook routing (null = last opened) */
		defaultNotebookId: string | null;
	};
	/** Desktop-only: local web page for phone capture over LAN / public tunnel */
	bridge: {
		enabled: boolean;
		port: number;
		/** Shared secret in URL ?t= */
		token: string;
		/** Auto start HTTP bridge when plugin loads (desktop) */
		autoStart: boolean;
		/** After phone submit, run AI organize into notebook immediately */
		autoOrganize: boolean;
		/**
		 * Public base URL without path/query, e.g. https://xxx.trycloudflare.com
		 * or https://abc.ngrok-free.app — phone can open from any network.
		 */
		publicBaseUrl: string;
		/** Prefer creating a temporary Cloudflare quick tunnel when showing link */
		preferPublicTunnel: boolean;
		/** Optional full path to cloudflared executable */
		cloudflaredPath: string;
	};
	ui: {
		lastNotebookId: string | null;
	};
	/**
	 * Outer (plugin-wide) capability history bookkeeping.
	 * Independent of per-notebook blueprint versions; never mutates note bodies.
	 */
	pluginHistory: {
		lastSeenCapabilityId: string | null;
		preferredPluginVersion: string | null;
		userNotes: Array<{
			id: string;
			at: string;
			kind: "seen" | "prefer-version" | "note" | "rollback-intent";
			text: string;
			relatedCapabilityId?: string;
			relatedPluginVersion?: string;
		}>;
	};
};

export type InboxEntry = {
	path: string;
	title: string;
	body: string;
	source: "mobile" | "voice" | "paste" | "share" | "unknown";
	created: string;
	status: "pending" | "processed" | "error";
};

export const RESERVED_ITEM_KEYS = new Set([
	"ai_notebook",
	"notebook_id",
	"item_id",
	"schema_version",
	"entity_type",
	"title",
	"tags",
	"cabinet_refs",
	"created",
	"updated",
	"source",
	"inbox_path",
	"organized",
]);
