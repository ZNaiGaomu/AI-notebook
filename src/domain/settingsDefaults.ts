import type { AiNotebookSettings } from "./types";

export const SETTINGS_SCHEMA_VERSION = 1;

export function createDefaultSettings(): AiNotebookSettings {
	return {
		schemaVersion: SETTINGS_SCHEMA_VERSION,
		providers: [],
		defaultProviderId: null,
		purposeRouting: {
			planner: { providerId: null, model: null },
			worker: { providerId: null, model: null },
			voice: { providerId: null, model: null },
		},
		paths: {
			notebooksRoot: "AI Notebooks",
			attachmentsRoot: "attachments/ai-notebook",
			inboxRoot: "AI Inbox",
		},
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
			planner: normalizeRoute(r.purposeRouting?.planner),
			worker: normalizeRoute(r.purposeRouting?.worker),
			voice: normalizeRoute(r.purposeRouting?.voice),
		},
		paths: {
			notebooksRoot:
				typeof r.paths?.notebooksRoot === "string" && r.paths.notebooksRoot.trim()
					? r.paths.notebooksRoot.trim()
					: base.paths.notebooksRoot,
			attachmentsRoot:
				typeof r.paths?.attachmentsRoot === "string" && r.paths.attachmentsRoot.trim()
					? r.paths.attachmentsRoot.trim()
					: base.paths.attachmentsRoot,
			inboxRoot:
				typeof r.paths?.inboxRoot === "string" && r.paths.inboxRoot.trim()
					? r.paths.inboxRoot.trim()
					: base.paths.inboxRoot,
		},
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
	};
}

function normalizeRoute(
	route: { providerId?: string | null; model?: string | null } | undefined,
): { providerId: string | null; model: string | null } {
	return {
		providerId:
			typeof route?.providerId === "string" || route?.providerId === null
				? (route?.providerId ?? null)
				: null,
		model:
			typeof route?.model === "string" || route?.model === null
				? (route?.model ?? null)
				: null,
	};
}

function normalizeProvider(p: unknown): AiNotebookSettings["providers"][number] {
	const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
	const models = Array.isArray(o.models)
		? o.models.filter((m): m is string => typeof m === "string")
		: [];
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
	};
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
