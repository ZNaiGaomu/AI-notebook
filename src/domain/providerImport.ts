import { createId } from "./ids";
import type {
	AiNotebookSettings,
	ProviderProfile,
	PurposeRouting,
} from "./types";
import { normalizeRouteChain } from "./purposeRouting";

/**
 * Normalize one provider from import JSON (various shapes).
 * Missing name → "无" (or hostname from baseUrl if possible)
 * models[0] → defaultModel when missing
 */
export function normalizeImportedProvider(
	raw: unknown,
	prevById?: Map<string, ProviderProfile>,
	prevByUrl?: Map<string, ProviderProfile>,
): ProviderProfile | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;

	const baseUrl = pickString(o, [
		"baseUrl",
		"base_url",
		"api_base",
		"apiBase",
		"url",
		"endpoint",
		"base",
	]);

	const apiKeyFromImport = pickString(o, [
		"apiKey",
		"api_key",
		"key",
		"token",
		"secret",
		"access_token",
	]);

	let models: string[] = [];
	if (Array.isArray(o.models)) {
		models = o.models
			.map((m) => {
				if (typeof m === "string") return m.trim();
				if (m && typeof m === "object") {
					const mo = m as Record<string, unknown>;
					return pickString(mo, ["id", "model", "name", "model_id"]) || "";
				}
				return "";
			})
			.filter(Boolean);
	} else if (typeof o.models === "string") {
		models = o.models
			.split(/[,，\n|;]/)
			.map((s) => s.trim())
			.filter(Boolean);
	} else {
		const single = pickString(o, ["model", "defaultModel", "default_model"]);
		if (single) models = [single];
	}

	// strip placeholders
	models = models.filter((m) => m && m !== "your-model-id" && m !== "sk-...");

	let id =
		typeof o.id === "string" && o.id.trim() ? o.id.trim() : "";
	// match existing by id or same baseUrl
	const prev =
		(id && prevById?.get(id)) ||
		(baseUrl ? prevByUrl?.get(normalizeUrlKey(baseUrl)) : undefined) ||
		undefined;
	if (!id) id = prev?.id || createId();

	const nameRaw = pickString(o, ["name", "title", "label", "provider"]);
	let name = nameRaw || "";
	if (!name || name === "无") {
		name = hostFromUrl(baseUrl) || prev?.name || "无";
	}

	const apiKey = apiKeyFromImport.trim()
		? apiKeyFromImport.trim()
		: (prev?.apiKey ?? "");

	let defaultModel = pickString(o, [
		"defaultModel",
		"default_model",
		"model",
	]);
	if (!defaultModel || defaultModel === "your-model-id") {
		// Import requirement: models in file become the default model(s)
		defaultModel = models[0] || prev?.defaultModel || "";
	}
	if (models.length === 0 && defaultModel) {
		models = [defaultModel];
	}
	// ensure default is in list
	if (defaultModel && !models.includes(defaultModel)) {
		models = [defaultModel, ...models];
	}

	// empty shell?
	if (!baseUrl && !apiKey && models.length === 0) {
		return null;
	}

	return {
		id,
		name: name || "无",
		baseUrl: baseUrl || prev?.baseUrl || "",
		apiKey,
		models,
		defaultModel: defaultModel || models[0] || "",
	};
}

export type ImportProvidersResult = {
	settings: AiNotebookSettings;
	added: number;
	updated: number;
	total: number;
	/** Why nothing imported */
	warning?: string;
};

/**
 * Merge imported providers into settings.
 */
export function mergeImportedProviders(
	settings: AiNotebookSettings,
	parsed: unknown,
): ImportProvidersResult {
	const prevById = new Map(settings.providers.map((p) => [p.id, p]));
	const prevByUrl = new Map(
		settings.providers
			.filter((p) => p.baseUrl)
			.map((p) => [normalizeUrlKey(p.baseUrl), p]),
	);

	const list = extractProviderList(parsed);
	let purposeRouting: PurposeRouting | undefined;
	let defaultProviderId: string | null | undefined;

	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const o = parsed as Record<string, unknown>;
		if (o.purposeRouting && typeof o.purposeRouting === "object") {
			purposeRouting = o.purposeRouting as PurposeRouting;
		}
		if (
			typeof o.defaultProviderId === "string" ||
			o.defaultProviderId === null
		) {
			defaultProviderId = o.defaultProviderId as string | null;
		}
	}

	if (list.length === 0) {
		return {
			settings,
			added: 0,
			updated: 0,
			total: settings.providers.length,
			warning:
				"未识别到服务商。请粘贴含 providers 数组的 JSON，或单个含 baseUrl/apiKey 的对象。",
		};
	}

	let added = 0;
	let updated = 0;
	const byId = new Map(prevById);

	for (const raw of list) {
		const p = normalizeImportedProvider(raw, prevById, prevByUrl);
		if (!p) continue;
		if (byId.has(p.id)) {
			updated++;
		} else {
			// also treat same URL as update
			const existingUrl = p.baseUrl
				? prevByUrl.get(normalizeUrlKey(p.baseUrl))
				: undefined;
			if (existingUrl && byId.has(existingUrl.id)) {
				const merged: ProviderProfile = {
					...existingUrl,
					...p,
					id: existingUrl.id,
					apiKey: p.apiKey || existingUrl.apiKey,
					// imported models become defaults; keep old models merged
					models: uniqueModels([
						...p.models,
						...existingUrl.models.filter((m) => m !== "your-model-id"),
					]),
					defaultModel:
						p.defaultModel ||
						p.models[0] ||
						existingUrl.defaultModel,
				};
				byId.set(existingUrl.id, merged);
				updated++;
				continue;
			}
			added++;
		}
		byId.set(p.id, p);
	}

	const providers = [...byId.values()];
	let nextDefault =
		defaultProviderId !== undefined
			? defaultProviderId
			: settings.defaultProviderId;
	if (nextDefault && !providers.some((p) => p.id === nextDefault)) {
		nextDefault = providers[0]?.id ?? null;
	}
	if (!nextDefault && providers[0]) nextDefault = providers[0].id;

	const next: AiNotebookSettings = {
		...settings,
		providers,
		defaultProviderId: nextDefault,
		purposeRouting: purposeRouting
			? mergeRouting(settings.purposeRouting, purposeRouting)
			: settings.purposeRouting,
	};

	return {
		settings: next,
		added,
		updated,
		total: providers.length,
	};
}

/** Pull providers array from many possible JSON shapes. */
export function extractProviderList(parsed: unknown): unknown[] {
	if (Array.isArray(parsed)) return parsed;
	if (!parsed || typeof parsed !== "object") return [];
	const o = parsed as Record<string, unknown>;

	const candidates = [
		o.providers,
		o.provider,
		o.services,
		o.apis,
		o.list,
		o.data,
		o.items,
		(o.settings as Record<string, unknown> | undefined)?.providers,
		(o.config as Record<string, unknown> | undefined)?.providers,
		(o.ai as Record<string, unknown> | undefined)?.providers,
	];
	for (const c of candidates) {
		if (Array.isArray(c) && c.length) return c;
		// single object in data
		if (c && typeof c === "object" && !Array.isArray(c)) {
			const co = c as Record<string, unknown>;
			if (co.baseUrl || co.base_url || co.apiKey || co.api_key) return [c];
		}
	}

	// single provider object at root
	if (
		o.baseUrl ||
		o.base_url ||
		o.apiKey ||
		o.api_key ||
		o.key ||
		(o.name && (o.url || o.endpoint))
	) {
		return [o];
	}
	return [];
}

function mergeRouting(
	base: PurposeRouting,
	patch: PurposeRouting,
): PurposeRouting {
	return {
		planner: normalizeRouteChain(
			Array.isArray(patch.planner) && patch.planner.length
				? patch.planner
				: base.planner,
		),
		worker: normalizeRouteChain(
			Array.isArray(patch.worker) && patch.worker.length
				? patch.worker
				: base.worker,
		),
		voice: normalizeRouteChain(
			Array.isArray(patch.voice) && patch.voice.length
				? patch.voice
				: base.voice,
		),
	};
}

function pickString(o: Record<string, unknown>, keys: string[]): string {
	for (const k of keys) {
		const v = o[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

function normalizeUrlKey(url: string): string {
	return url.trim().replace(/\/+$/, "").toLowerCase();
}

function hostFromUrl(url: string): string {
	if (!url) return "";
	try {
		const u = new URL(url.includes("://") ? url : `https://${url}`);
		return u.hostname.replace(/^api\./, "") || "无";
	} catch {
		return "";
	}
}

function uniqueModels(arr: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of arr) {
		if (!m || seen.has(m)) continue;
		seen.add(m);
		out.push(m);
	}
	return out;
}

/** Soft-parse JSON: strip BOM, trailing commas, extract first {...} or [...] */
export function parseImportJson(raw: string): unknown {
	let s = raw.trim().replace(/^﻿/, "");
	// smart quotes
	s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
	try {
		return JSON.parse(s);
	} catch {
		// trailing commas
		const repaired = s.replace(/,\s*([\]}])/g, "$1");
		try {
			return JSON.parse(repaired);
		} catch {
			// extract first json value
			const obj = s.match(/\{[\s\S]*\}/);
			const arr = s.match(/\[[\s\S]*\]/);
			const chunk =
				obj && arr
					? obj.index! <= arr.index!
						? obj[0]
						: arr[0]
					: obj?.[0] || arr?.[0];
			if (chunk) {
				return JSON.parse(chunk.replace(/,\s*([\]}])/g, "$1"));
			}
			throw new Error("JSON 无法解析");
		}
	}
}
