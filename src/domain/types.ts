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
	/**
	 * Explicit fan-out priority per model id (unique positive ints: 1, 2, 3…).
	 * Only models with a priority participate when purpose slot uses「服务商默认」.
	 * Smaller number = higher priority. Priorities > modelFanout N are ignored for that run.
	 */
	modelPriority?: Record<string, number>;
};

/**
 * One ordered slot in a purpose → model chain (fallback order).
 *
 * Model selection modes (A/B/C):
 * - model == null && !modelPriority → A: provider.modelPriority 1..N
 * - model == null && modelPriority set → B: purpose-local priorities 1..N
 * - model set → C: only that single model
 */
export type RouteSlot = {
	providerId: string | null;
	/** Explicit model id (C). null = use default fan-out (A or B). */
	model: string | null;
	/**
	 * Purpose-local priorities for this slot's provider (B).
	 * Unique positive ints; empty/undefined → fall back to provider-level (A).
	 */
	modelPriority?: Record<string, number>;
};

/**
 * Per-purpose ordered provider/model chain.
 * Index 0 is tried first; on capability miss or request failure, try the next slot.
 * Empty chain (or all-null slots) falls back to defaultProviderId.
 */
export type PurposeRouting = {
	planner: RouteSlot[];
	worker: RouteSlot[];
	voice: RouteSlot[];
};

/** Max ordered fallbacks shown in settings UI. */
export const PURPOSE_ROUTE_CHAIN_LEN = 3;



/** Browser recording container format (mp3 may fall back if unsupported). */
export type VoiceRecordFormat = "auto" | "wav" | "webm" | "m4a" | "mp3";

/**
 * Voice capture + STT + optional polish (post-transcript rewrite).
 * Independent of blueprint organize (field extract).
 */
export type VoiceFeatureSettings = {
	/** Preferred recording container; auto negotiates with MediaRecorder. */
	recordFormat: VoiceRecordFormat;
	/**
	 * When purpose slot uses provider default model, try up to this many models
	 * inside that provider before moving to the next purpose slot.
	 */
	modelFanout: number;
	/**
	 * Prefer re-encoding to 16k mono WAV before STT when source is not wav
	 * (helps some OpenAI-compatible gateways).
	 */
	transcodeWavForStt: boolean;
	/**
	 * After STT fails, try chat multimodal "listen".
	 * Default true (restore usable path when mid-proxy has no /audio/transcriptions).
	 */
	allowChatAudioFallback: boolean;
	/** Saved position for draggable voice progress chip (px from viewport top-left). */
	chipPosition: { left: number; top: number } | null;
	polish: {
		/** Default on: after STT, rewrite transcript with a chat model. */
		enabled: boolean;
		providerId: string | null;
		model: string | null;
		prompt: string;
	};
};

export const DEFAULT_VOICE_POLISH_PROMPT =
	"请将下面的语音转写原文润色为通顺、分段清晰的中文笔记。去掉口头禅与重复，不编造事实，不添加原文没有的信息。只输出润色后的正文，不要标题或解释。";

/** One GitHub release that can supply an installable plugin package. */
export type PluginReleaseCacheEntry = {
	/** Semver without leading v, e.g. 0.2.0 */
	version: string;
	tagName: string;
	/** Release title */
	name: string;
	publishedAt: string;
	/** Release body / notes (may be empty) */
	body: string;
	/** Direct zip asset URL (browser_download_url) */
	downloadUrl: string;
	/** GitHub release page */
	htmlUrl: string;
};

/** User-configured package source (one row, like an AI provider). */
export type PluginVersionSource = {
	id: string;
	/** Display name, e.g. 官方主仓 */
	name: string;
	/** Original URL the user pasted */
	repoUrl: string;
	owner: string;
	repo: string;
	lastFetchedAt: string | null;
	/** Last successfully fetched release list (does not affect running package) */
	cachedReleases: PluginReleaseCacheEntry[];
};

export type AiNotebookSettings = {
	schemaVersion: number;
	providers: ProviderProfile[];
	defaultProviderId: string | null;
	purposeRouting: PurposeRouting;
	/** Voice recording format, STT fan-out, polish */
	voice: VoiceFeatureSettings;
	paths: {
		notebooksRoot: string;
		attachmentsRoot: string;
		/** Mobile / quick dump folder inside vault (synced by Obsidian Sync etc.) */
		inboxRoot: string;
		/**
		 * Where chat uploads are stored (relative to vault root).
		 * Default: `{attachmentsRoot}/chat-uploads`
		 * Empty/null → use default. Changing this does not move existing files.
		 */
		chatUploadsRoot: string | null;
	};
	/**
	 * Chat upload retention in days. null = permanent (default).
	 * Only applies to chat-upload archive files not required by other features.
	 */
	chatUploadRetentionDays: number | null;
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
		/**
		 * Multi-row GitHub package sources (like AI providers).
		 * Fetching never changes the running package — only explicit "use this version" does.
		 */
		sources: PluginVersionSource[];
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
