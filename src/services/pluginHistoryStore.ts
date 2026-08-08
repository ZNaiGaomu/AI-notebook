import type { AiNotebookSettings } from "../domain/types";
import {
	PLUGIN_CAPABILITY_LOG,
	latestPluginCapability,
	type PluginCapabilityEntry,
} from "../domain/pluginChangelog";
import { createId, nowIso } from "../domain/ids";

export type PluginUserNoteKind = "seen" | "prefer-version" | "note" | "rollback-intent";

export type PluginUserNote = {
	id: string;
	at: string;
	kind: PluginUserNoteKind;
	text: string;
	relatedCapabilityId?: string;
	relatedPluginVersion?: string;
};

/** Persisted under settings.pluginHistory (plugin data.json). */
export type PluginHistoryState = {
	/** Last auto-synced capability id from PLUGIN_CAPABILITY_LOG */
	lastSeenCapabilityId: string | null;
	/**
	 * User-marked package version they intend to run (rollback target guidance).
	 * Does not swap code by itself — user must reinstall that release folder.
	 */
	preferredPluginVersion: string | null;
	userNotes: PluginUserNote[];
	/** GitHub package sources — full type lives on AiNotebookSettings.pluginHistory */
	sources: AiNotebookSettings["pluginHistory"]["sources"];
	/** Last package successfully applied from history UI */
	appliedPackage: AiNotebookSettings["pluginHistory"]["appliedPackage"];
};

export function defaultPluginHistory(): PluginHistoryState {
	return {
		lastSeenCapabilityId: null,
		preferredPluginVersion: null,
		userNotes: [],
		sources: [],
		appliedPackage: null,
	};
}

export function normalizePluginHistory(raw: unknown): PluginHistoryState {
	const base = defaultPluginHistory();
	if (!raw || typeof raw !== "object") return base;
	const r = raw as Partial<PluginHistoryState>;
	const notes = Array.isArray(r.userNotes)
		? r.userNotes
				.filter((n): n is PluginUserNote => Boolean(n && typeof n === "object"))
				.map((n) => ({
					id: typeof n.id === "string" ? n.id : createId(),
					at: typeof n.at === "string" ? n.at : nowIso(),
					kind: (["seen", "prefer-version", "note", "rollback-intent"].includes(
						String(n.kind),
					)
						? n.kind
						: "note") as PluginUserNoteKind,
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
		: [];
	return {
		lastSeenCapabilityId:
			typeof r.lastSeenCapabilityId === "string" || r.lastSeenCapabilityId === null
				? (r.lastSeenCapabilityId ?? null)
				: null,
		preferredPluginVersion:
			typeof r.preferredPluginVersion === "string" ||
			r.preferredPluginVersion === null
				? (r.preferredPluginVersion ?? null)
				: null,
		userNotes: notes,
			sources: Array.isArray(r.sources) ? r.sources : [],
			appliedPackage:
				r.appliedPackage && typeof r.appliedPackage === "object"
					? (r.appliedPackage as PluginHistoryState["appliedPackage"])
					: null,
	};
}

/**
 * Sync built-in capability log into settings timeline bookkeeping.
 * Returns newly introduced capability entries (for optional Notice).
 */
export function syncPluginHistoryOnLoad(
	settings: AiNotebookSettings,
): { settings: AiNotebookSettings; newCaps: PluginCapabilityEntry[] } {
	const hist = settings.pluginHistory ?? defaultPluginHistory();
	const lastId = hist.lastSeenCapabilityId;
	let start = 0;
	if (lastId) {
		const idx = PLUGIN_CAPABILITY_LOG.findIndex((e) => e.id === lastId);
		start = idx >= 0 ? idx + 1 : 0;
	}
	const newCaps = PLUGIN_CAPABILITY_LOG.slice(start);
	const latest = latestPluginCapability();
	const nextHist: PluginHistoryState = {
		...hist,
			appliedPackage: hist.appliedPackage ?? null,
		sources: hist.sources ?? [],
		lastSeenCapabilityId: latest?.id ?? lastId,
		// first install: mark preferred as current package if empty
		preferredPluginVersion:
			hist.preferredPluginVersion ?? latest?.pluginVersion ?? null,
	};
	// optional auto note for brand-new installs
	let userNotes = nextHist.userNotes;
	if (!lastId && latest) {
		const already = userNotes.some((n) => n.kind === "seen" && n.relatedCapabilityId === latest.id);
		if (!already) {
			userNotes = [
				...userNotes,
				{
					id: createId(),
					at: nowIso(),
					kind: "seen",
					text: `首次同步插件能力说明（能力日志版本 ${latest.pluginVersion}；不等于本机正在运行的安装包）`,
					relatedCapabilityId: latest.id,
					relatedPluginVersion: latest.pluginVersion,
				},
			];
		}
	}
	return {
		settings: {
			...settings,
			pluginHistory: { ...nextHist, userNotes, sources: nextHist.sources ?? [], appliedPackage: nextHist.appliedPackage ?? null },
		},
		newCaps,
	};
}

export function markPreferredPluginVersion(
	settings: AiNotebookSettings,
	version: string,
	note?: string,
): AiNotebookSettings {
	const hist = settings.pluginHistory ?? defaultPluginHistory();
	const entry: PluginUserNote = {
		id: createId(),
		at: nowIso(),
		kind: "prefer-version",
		text: note?.trim() || `标记希望使用的插件包版本为 ${version}`,
		relatedPluginVersion: version,
	};
	return {
		...settings,
		pluginHistory: {
			...hist,
			preferredPluginVersion: version,
			userNotes: [...hist.userNotes, entry],
		},
	};
}

export function recordRollbackIntent(
	settings: AiNotebookSettings,
	targetVersion: string,
	capabilityId?: string,
): AiNotebookSettings {
	const hist = settings.pluginHistory ?? defaultPluginHistory();
	const entry: PluginUserNote = {
		id: createId(),
		at: nowIso(),
		kind: "rollback-intent",
		text: `已切换安装包到 v${targetVersion}（请禁用再启用本插件或重启 Obsidian 后生效；笔记数据不受影响；可在「本地运行备份」切回上一版）`,
		relatedPluginVersion: targetVersion,
		relatedCapabilityId: capabilityId,
	};
	return {
		...settings,
		pluginHistory: {
			...hist,
			preferredPluginVersion: targetVersion,
			userNotes: [...hist.userNotes, entry],
		},
	};
}

/** Unique plugin package versions mentioned in the capability log (newest first). */
export function pluginVersionsInLog(): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = PLUGIN_CAPABILITY_LOG.length - 1; i >= 0; i--) {
		const v = PLUGIN_CAPABILITY_LOG[i]!.pluginVersion;
		if (!seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}
