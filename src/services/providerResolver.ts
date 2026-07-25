import type {
	AiNotebookSettings,
	NotebookMeta,
	ProviderProfile,
	RouteSlot,
} from "../domain/types";
import { PURPOSE_ROUTE_CHAIN_LEN } from "../domain/types";
import { normalizeRouteChain } from "../domain/purposeRouting";

export type Purpose = "planner" | "worker" | "voice";

export type ResolvedProvider = {
	profile: ProviderProfile;
	model: string;
	/** 1-based position in the purpose chain (for UI notices). */
	slotIndex: number;
};

export type ResolveNeed = {
	/** Prefer models that look vision-capable (images in chat). */
	vision?: boolean;
	/** Prefer STT / whisper-like models. */
	stt?: boolean;
};

/**
 * Resolve first usable provider for purpose (backward-compatible).
 */
export function resolveProvider(
	settings: AiNotebookSettings,
	purpose: Purpose,
	notebook?: NotebookMeta | null,
	need?: ResolveNeed,
): ResolvedProvider | null {
	const chain = resolveProviderChain(settings, purpose, notebook, need);
	return chain[0] ?? null;
}

/**
 * Ordered list of usable providers for a purpose (settings chain → default).
 * When a slot uses「服务商默认模型」(model null), expands up to voice.modelFanout
 * models inside that provider (purpose-aware ranking), then moves to next slot.
 * Deduplicates identical providerId+model pairs.
 */
export function resolveProviderChain(
	settings: AiNotebookSettings,
	purpose: Purpose,
	notebook?: NotebookMeta | null,
	need?: ResolveNeed,
): ResolvedProvider[] {
	const slots = normalizeRouteChain(settings.purposeRouting?.[purpose]);
	const notebookModel =
		notebook?.model_overrides?.[purpose] &&
		notebook.model_overrides[purpose]!.trim()
			? notebook.model_overrides[purpose]!.trim()
			: null;
	const fanout = Math.max(1, Math.floor(settings.voice?.modelFanout ?? 6));
	const wantStt = Boolean(need?.stt || purpose === "voice");
	const wantVision = Boolean(need?.vision);

	const candidates: Array<{
		providerId: string | null;
		model: string | null;
		slotIndex: number;
		modelPriority?: Record<string, number>;
	}> = [];

	for (let i = 0; i < slots.length; i++) {
		const slot: RouteSlot = slots[i] ?? {
			providerId: null,
			model: null,
		};
		if (!slot.providerId && !slot.model && !slot.modelPriority) continue;
		candidates.push({
			providerId: slot.providerId,
			model: slot.model,
			slotIndex: i + 1,
			modelPriority: slot.modelPriority,
		});
	}

	// Only fall back to default provider when purpose chain has NO slots.
	// If user configured voice/planner/worker order 1..N, never inject extra vendors.
	if (candidates.length === 0) {
		const defaultId =
			notebook?.provider_profile_id ||
			settings.defaultProviderId ||
			settings.providers[0]?.id ||
			null;
		if (defaultId) {
			candidates.push({
				providerId: defaultId,
				model: null,
				slotIndex: 1,
			});
		}
	}

	const out: ResolvedProvider[] = [];
	const seen = new Set<string>();

	const pushOne = (
		profile: ProviderProfile,
		model: string,
		slotIndex: number,
	) => {
		const m = (model || "").trim();
		if (!m && purpose !== "voice") return;
		const finalModel = m || (purpose === "voice" ? "whisper-1" : "");
		if (!finalModel) return;
		// User may prioritize any model including TTS; do not auto-skip here.
		const key = `${profile.id}::${finalModel}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ profile, model: finalModel, slotIndex });
	};

	const expandSlot = (
			providerId: string | null,
			modelOverride: string | null,
			slotIndex: number,
			preferVision: boolean,
			slotPriority?: Record<string, number>,
		) => {
			const pid =
				providerId ||
				settings.defaultProviderId ||
				settings.providers[0]?.id ||
				null;
			if (!pid) return;
			const profile = settings.providers.find((p) => p.id === pid);
			if (!profile) return;
			if (!profile.baseUrl.trim() || !profile.apiKey.trim()) return;

			// C: explicit model on slot (notebook override only on slot 1)
			const explicit =
				(slotIndex === 1 ? notebookModel : null) ||
				(modelOverride && modelOverride.trim() ? modelOverride.trim() : null);

			if (explicit) {
				pushOne(profile, explicit, slotIndex);
				return;
			}

			// B: purpose-local priorities on this slot
			// A: provider.modelPriority
			const effectiveProfile: ProviderProfile = slotPriority
				? { ...profile, modelPriority: slotPriority }
				: profile;

			const ranked = rankModelsForPurpose(effectiveProfile, {
				stt: wantStt,
				vision: preferVision || wantVision,
				purpose,
				maxPriority: fanout,
			});
			if (ranked.length === 0 && purpose === "voice") {
				const fallback =
					profile.defaultModel ||
					profile.models[0] ||
					"whisper-1";
				pushOne(profile, fallback, slotIndex);
				return;
			}
			if (ranked.length === 0 && purpose !== "voice") {
				const one =
					profile.defaultModel || profile.models[0] || "";
				if (one) pushOne(profile, one, slotIndex);
				return;
			}
			for (const m of ranked) {
				pushOne(profile, m, slotIndex);
			}
		};

	if (wantVision) {
		for (const c of candidates) {
			const profile = settings.providers.find(
				(p) =>
					p.id ===
					(c.providerId ||
						settings.defaultProviderId ||
						settings.providers[0]?.id),
			);
			if (!profile) continue;
			const model =
				c.model || profile.defaultModel || profile.models[0] || "";
			if (
				looksVisionCapable(model) ||
				profile.models.some((m) => looksVisionCapable(m))
			) {
				expandSlot(c.providerId, c.model, c.slotIndex, true, c.modelPriority);
			}
		}
	}

	for (const c of candidates) {
		expandSlot(c.providerId, c.model, c.slotIndex, wantVision, c.modelPriority);
	}

	// Hard fallback across ALL providers only when nothing was configured
	// for this purpose (empty chain). Never expand beyond user's purpose table.
	if (out.length === 0 && candidates.length === 0) {
		for (let i = 0; i < settings.providers.length; i++) {
			const p = settings.providers[i]!;
			expandSlot(p.id, null, 100 + i, wantVision);
		}
	} else if (wantVision && out.length === 0) {
		// Vision: if configured slots produced nothing usable, still try
		// remaining providers that look vision-capable (chat with images).
		for (let i = 0; i < settings.providers.length; i++) {
			const p = settings.providers[i]!;
			expandSlot(p.id, null, 100 + i, true);
		}
	}

	return out;
}

/**
 * Rank models inside a provider for a purpose when slot model is「默认」.
 * Voice: ASR first, skip TTS. Vision: vision-capable first. Else default + list.
 */
export function rankModelsForPurpose(
	profile: ProviderProfile,
	opts: {
		stt?: boolean;
		vision?: boolean;
		purpose?: Purpose;
		/** Max priority number to include (N). */
		maxPriority?: number;
	},
): string[] {
	const maxP = Math.max(1, Math.floor(opts.maxPriority ?? 6));
	const pri = profile.modelPriority ?? {};

	// Scheme A: only models with explicit unique priority 1..N
	const prioritized = Object.entries(pri)
		.filter(([model, prio]) => {
			if (!profile.models.includes(model) && model !== profile.defaultModel) {
				// still allow if listed in models
			}
			const inList =
				profile.models.includes(model) || model === profile.defaultModel;
			if (!inList) return false;
			if (typeof prio !== "number" || !Number.isFinite(prio)) return false;
			const p = Math.floor(prio);
			if (p < 1 || p > maxP) return false;
				// Full 1..N poll: include TTS if user set priority
				return true;
		})
		.map(([model, prio]) => ({ model, prio: Math.floor(prio as number) }))
		.sort((a, b) => a.prio - b.prio || a.model.localeCompare(b.model));

	// Deduplicate by priority (unique already) and model
	const seenP = new Set<number>();
	const seenM = new Set<string>();
	const ordered: string[] = [];
	for (const e of prioritized) {
		if (seenP.has(e.prio) || seenM.has(e.model)) continue;
		seenP.add(e.prio);
		seenM.add(e.model);
		ordered.push(e.model);
	}

	if (ordered.length) return ordered;

	// No priorities configured: legacy heuristic fallback (single default-ish)
	const pool = uniqueModels([profile.defaultModel, ...profile.models]);
	if (!pool.length) {
		return opts.stt || opts.purpose === "voice" ? ["whisper-1"] : [];
	}
	if (opts.stt || opts.purpose === "voice") {
			const asr = pool.filter(looksLikeSttModel);
			const rest = pool.filter((m) => !looksLikeSttModel(m));
			return uniqueModels([...asr, ...rest]).slice(0, maxP);
	}
	if (opts.vision) {
		const vis = pool.filter(looksVisionCapable);
		return (vis[0] ? [vis[0]] : pool.slice(0, 1));
	}
	return pool.slice(0, 1);
}

export function looksLikeSttModel(model: string): boolean {
	const m = model.toLowerCase();
	if (!m || looksLikeTtsModel(m)) return false;
	return /whisper|transcrib|speech|asr|\bstt\b|funasr|mimo-v2\.5-asr/i.test(m);
}

export function looksLikeTtsModel(model: string): boolean {
	return /tts|voiceclone|voicedesign|text-to-speech|speech-synthesis/i.test(
		model.toLowerCase(),
	);
}

/**
 * Heuristic: model id looks multimodal / vision-capable.
 */
export function looksVisionCapable(model: string): boolean {
	const m = model.toLowerCase();
	if (!m) return false;
	if (/whisper|tts|embed|embedding|moderation|stt|asr/i.test(m)) return false;
	return (
		/vision|vl\b|vl-|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o1|o3|o4|gemini|claude-3|claude-4|claude-sonnet|claude-opus|qwen.*(vl|omni|max|plus)|glm-4v|yi-vision|step-1v|internvl|pixtral|llava|moondream|phi-4|phi-3\.5-vision|nova-pro|nova-lite|sonar/i.test(
			m,
		) || /4o|4\.1|omni/.test(m)
	);
}

function uniqueModels(arr: Array<string | null | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const a of arr) {
		const s = (a || "").trim();
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out;
}

/** Error text suggests model cannot accept images / multimodal. */
export function isVisionCapabilityError(error: string): boolean {
	return /vision|image|multimodal|does not support|unsupported.*(image|content)|invalid.*(image|content_type)|unknown variant|content part|not support/i.test(
		error,
	);
}
