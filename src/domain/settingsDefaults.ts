import type { AiNotebookSettings, VoiceFeatureSettings } from "./types";
import { DEFAULT_VOICE_POLISH_PROMPT } from "./types";
import { normalizeRouteChain } from "./purposeRouting";

export const SETTINGS_SCHEMA_VERSION = 1;

function emptyChain() {
	return normalizeRouteChain([]);
}

function defaultVoice(): VoiceFeatureSettings {
	return {
		recordFormat: "auto",
		modelFanout: 6,
		transcodeWavForStt: true,
		allowChatAudioFallback: true,
		chipPosition: null,
		polish: {
			enabled: true,
			providerId: null,
			model: null,
			prompt: DEFAULT_VOICE_POLISH_PROMPT,
		},
	};
}

export function createDefaultSettings(): AiNotebookSettings {
	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		providers: [],
		defaultProviderId: null,
		purposeRouting: {
			planner: emptyChain(),
			worker: emptyChain(),
			voice: emptyChain(),
		},
		voice: defaultVoice(),
		paths: {
			notebooksRoot: "AI Notebooks",
			attachmentsRoot: "attachments/ai-notebook",
			inboxRoot: "AI Inbox",
			chatUploadsRoot: null,
		},
		chatUploadRetentionDays: null,
		privacy: {
			attachTopKItems: false,
			topK: 5,
			allowCurrentNoteContext: false,
		},
		inbox: {
			archiveAfterOrganize: true,
			autoOrganizeVoice: true,
			defaultNotebookId: null,
		},
		bridge: {
			enabled: true,
			port: 27124,
			token: "",
			autoStart: false,
			autoOrganize: true,
			publicBaseUrl: "",
			preferPublicTunnel: true,
			cloudflaredPath: "",
		},
		ui: {
			lastNotebookId: null,
		},
		pluginHistory: {
			lastSeenCapabilityId: null,
			preferredPluginVersion: null,
			userNotes: [],
			sources: [],
		},
	};
}

/** Merge unknown loadData payload into a full settings object (immutable). */
export function normalizeSettings(raw: unknown): AiNotebookSettings {
	const base = createDefaultSettings();
	if (!raw || typeof raw !== "object") {
		return base;
	}
	const r = raw as Partial<AiNotebookSettings>;
	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		providers: Array.isArray(r.providers) ? r.providers.map(normalizeProvider) : [],
		defaultProviderId:
			typeof r.defaultProviderId === "string" || r.defaultProviderId === null
				? r.defaultProviderId
				: null,
		purposeRouting: {
			planner: normalizeRouteChain(r.purposeRouting?.planner),
			worker: normalizeRouteChain(r.purposeRouting?.worker),
			voice: normalizeRouteChain(r.purposeRouting?.voice),
		},
			voice: normalizeVoiceSettings(
				(r as Partial<AiNotebookSettings>).voice,
			),
		paths: {
			notebooksRoot:
				typeof r.paths?.notebooksRoot === "string" && r.paths.notebooksRoot.trim()
					? r.paths.notebooksRoot.trim()
					: base.paths.notebooksRoot,
			attachmentsRoot:
				typeof r.paths?.attachmentsRoot === "string" &&
				r.paths.attachmentsRoot.trim()
					? r.paths.attachmentsRoot.trim()
					: base.paths.attachmentsRoot,
			inboxRoot:
				typeof r.paths?.inboxRoot === "string" && r.paths.inboxRoot.trim()
					? r.paths.inboxRoot.trim()
					: base.paths.inboxRoot,
			chatUploadsRoot:
				typeof r.paths?.chatUploadsRoot === "string" &&
				r.paths.chatUploadsRoot.trim()
					? r.paths.chatUploadsRoot.trim().replace(/\\/g, "/")
					: null,
		},
		chatUploadRetentionDays:
			typeof r.chatUploadRetentionDays === "number" &&
			r.chatUploadRetentionDays > 0
				? Math.floor(r.chatUploadRetentionDays)
				: null,
		privacy: {
			attachTopKItems: Boolean(r.privacy?.attachTopKItems),
			topK:
				typeof r.privacy?.topK === "number" && r.privacy.topK > 0
					? Math.floor(r.privacy.topK)
					: 5,
			allowCurrentNoteContext: Boolean(r.privacy?.allowCurrentNoteContext),
		},
		inbox: {
			archiveAfterOrganize:
				r.inbox?.archiveAfterOrganize !== undefined
					? Boolean(r.inbox.archiveAfterOrganize)
					: base.inbox.archiveAfterOrganize,
			autoOrganizeVoice:
				r.inbox?.autoOrganizeVoice !== undefined
					? Boolean(r.inbox.autoOrganizeVoice)
					: base.inbox.autoOrganizeVoice,
			defaultNotebookId:
				typeof r.inbox?.defaultNotebookId === "string" ||
				r.inbox?.defaultNotebookId === null
					? (r.inbox?.defaultNotebookId ?? null)
					: null,
		},
		bridge: {
			enabled:
				r.bridge?.enabled !== undefined
					? Boolean(r.bridge.enabled)
					: base.bridge.enabled,
			port:
				typeof r.bridge?.port === "number" &&
				r.bridge.port > 0 &&
				r.bridge.port < 65536
					? Math.floor(r.bridge.port)
					: base.bridge.port,
			token:
				typeof r.bridge?.token === "string" ? r.bridge.token : base.bridge.token,
			autoStart:
				r.bridge?.autoStart !== undefined
					? Boolean(r.bridge.autoStart)
					: base.bridge.autoStart,
			autoOrganize:
				r.bridge?.autoOrganize !== undefined
					? Boolean(r.bridge.autoOrganize)
					: base.bridge.autoOrganize,
			publicBaseUrl:
				typeof r.bridge?.publicBaseUrl === "string"
					? r.bridge.publicBaseUrl.trim().replace(/\/+$/, "")
					: base.bridge.publicBaseUrl,
			preferPublicTunnel:
				r.bridge?.preferPublicTunnel !== undefined
					? Boolean(r.bridge.preferPublicTunnel)
					: base.bridge.preferPublicTunnel,
			cloudflaredPath:
				typeof r.bridge?.cloudflaredPath === "string"
					? r.bridge.cloudflaredPath.trim()
					: base.bridge.cloudflaredPath,
		},
		ui: {
			lastNotebookId:
				typeof r.ui?.lastNotebookId === "string" || r.ui?.lastNotebookId === null
					? (r.ui?.lastNotebookId ?? null)
					: null,
		},
		pluginHistory: normalizePluginHistoryField(r.pluginHistory),
	};
}

function normalizePluginHistoryField(
	raw: AiNotebookSettings["pluginHistory"] | undefined,
): AiNotebookSettings["pluginHistory"] {
	const base = createDefaultSettings().pluginHistory;
	if (!raw || typeof raw !== "object") return base;
	const notes = Array.isArray(raw.userNotes)
		? raw.userNotes
				.filter((n) => n && typeof n === "object")
				.map((n) => ({
					id: typeof n.id === "string" ? n.id : "",
					at: typeof n.at === "string" ? n.at : "",
					kind: (["seen", "prefer-version", "note", "rollback-intent"].includes(
						String(n.kind),
					)
						? n.kind
						: "note") as AiNotebookSettings["pluginHistory"]["userNotes"][number]["kind"],
					text: typeof n.text === "string" ? n.text : "",
					relatedCapabilityId:
						typeof n.relatedCapabilityId === "string"
							? n.relatedCapabilityId
							: undefined,
					relatedPluginVersion:
						typeof n.relatedPluginVersion === "string"
							? n.relatedPluginVersion
							: undefined,
				}))
				.filter((n) => n.id)
		: [];
	const sources = Array.isArray((raw as { sources?: unknown }).sources)
			? ((raw as { sources: unknown[] }).sources)
					.filter((s) => s && typeof s === "object")
					.map((s) => normalizeVersionSource(s))
					.filter((s) => s.id && s.owner && s.repo)
			: [];
		return {
			lastSeenCapabilityId:
				typeof raw.lastSeenCapabilityId === "string" ||
				raw.lastSeenCapabilityId === null
					? raw.lastSeenCapabilityId
					: null,
			preferredPluginVersion:
				typeof raw.preferredPluginVersion === "string" ||
				raw.preferredPluginVersion === null
					? raw.preferredPluginVersion
					: null,
			userNotes: notes,
			sources,
		};
}


function normalizeVersionSource(
	raw: unknown,
): AiNotebookSettings["pluginHistory"]["sources"][number] {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const releases = Array.isArray(o.cachedReleases)
		? o.cachedReleases
				.filter((r) => r && typeof r === "object")
				.map((r) => {
					const x = r as Record<string, unknown>;
					return {
						version:
							typeof x.version === "string" ? x.version.replace(/^v/i, "") : "",
						tagName: typeof x.tagName === "string" ? x.tagName : "",
						name: typeof x.name === "string" ? x.name : "",
						publishedAt: typeof x.publishedAt === "string" ? x.publishedAt : "",
						body: typeof x.body === "string" ? x.body : "",
						downloadUrl: typeof x.downloadUrl === "string" ? x.downloadUrl : "",
						htmlUrl: typeof x.htmlUrl === "string" ? x.htmlUrl : "",
					};
				})
				.filter((r) => r.version && r.downloadUrl)
		: [];
	return {
		id: typeof o.id === "string" ? o.id : "",
		name: typeof o.name === "string" ? o.name : "未命名来源",
		repoUrl: typeof o.repoUrl === "string" ? o.repoUrl : "",
		owner: typeof o.owner === "string" ? o.owner : "",
		repo: typeof o.repo === "string" ? o.repo : "",
		lastFetchedAt:
			typeof o.lastFetchedAt === "string" || o.lastFetchedAt === null
				? (o.lastFetchedAt as string | null)
				: null,
		cachedReleases: releases,
	};
}

function normalizeVoiceSettings(
	raw: VoiceFeatureSettings | undefined,
): VoiceFeatureSettings {
	const base = defaultVoice();
	if (!raw || typeof raw !== "object") return base;
	const fmt = String(raw.recordFormat || "");
	const recordFormat = (
		["auto", "wav", "webm", "m4a", "mp3"] as const
	).includes(fmt as "auto")
		? (fmt as VoiceFeatureSettings["recordFormat"])
		: base.recordFormat;
	const fan =
		typeof raw.modelFanout === "number" && raw.modelFanout >= 1
			? Math.floor(raw.modelFanout)
			: base.modelFanout;
	const polishRaw = raw.polish && typeof raw.polish === "object" ? raw.polish : null;
	return {
		recordFormat,
		modelFanout: fan,
		transcodeWavForStt:
			raw.transcodeWavForStt !== undefined
				? Boolean(raw.transcodeWavForStt)
				: base.transcodeWavForStt,
		allowChatAudioFallback:
			raw.allowChatAudioFallback !== undefined
				? Boolean(raw.allowChatAudioFallback)
				: true,
		chipPosition: normalizeChipPosition(raw.chipPosition),
		polish: {
			enabled:
				polishRaw?.enabled !== undefined
					? Boolean(polishRaw.enabled)
					: base.polish.enabled,
			providerId:
				typeof polishRaw?.providerId === "string" || polishRaw?.providerId === null
					? (polishRaw?.providerId ?? null)
					: null,
			model:
				typeof polishRaw?.model === "string" || polishRaw?.model === null
					? (polishRaw?.model ?? null)
					: null,
			prompt:
				typeof polishRaw?.prompt === "string" && polishRaw.prompt.trim()
					? polishRaw.prompt
					: base.polish.prompt,
		},
	};
}


function normalizeChipPosition(
	raw: unknown,
): { left: number; top: number } | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as { left?: unknown; top?: unknown };
	const left = Number(o.left);
	const top = Number(o.top);
	if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
	return { left: Math.round(left), top: Math.round(top) };
}

function normalizeProvider(p: unknown): AiNotebookSettings["providers"][number] {
	const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
	const models = Array.isArray(o.models)
		? o.models.filter((m): m is string => typeof m === "string")
		: [];
	const modelPriority = normalizeModelPriority(o.modelPriority, models);
	return {
		id: typeof o.id === "string" ? o.id : "",
		name: typeof o.name === "string" ? o.name : "Unnamed",
		baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : "",
		apiKey: typeof o.apiKey === "string" ? o.apiKey : "",
		models,
		defaultModel:
			typeof o.defaultModel === "string"
				? o.defaultModel
				: (models[0] ?? ""),
		modelPriority,
	};
}

/** Keep unique positive integer priorities; drop unknown models; resolve collisions by first-wins then renumber? first-wins on unique. */
function normalizeModelPriority(
	raw: unknown,
	models: string[],
): Record<string, number> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const allowed = new Set(models);
	const entries: Array<{ model: string; prio: number }> = [];
	const used = new Set<number>();
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!allowed.has(k)) continue;
		const n = typeof v === "number" ? v : Number(v);
		if (!Number.isFinite(n) || n < 1) continue;
		const prio = Math.floor(n);
		if (used.has(prio)) continue; // unique: first wins
		used.add(prio);
		entries.push({ model: k, prio });
	}
	if (!entries.length) return undefined;
	const out: Record<string, number> = {};
	for (const e of entries) out[e.model] = e.prio;
	return out;
}

/** Export settings without secrets. */
export function redactSettingsForExport(settings: AiNotebookSettings): unknown {
	return {
		...settings,
		providers: settings.providers.map((p) => ({
			...p,
			apiKey: "",
		})),
		bridge: {
			...settings.bridge,
			token: settings.bridge.token ? "***" : "",
		},
	};
}
