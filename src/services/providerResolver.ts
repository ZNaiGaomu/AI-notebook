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

	const candidates: Array<{
		providerId: string | null;
		model: string | null;
		slotIndex: number;
	}> = [];

	for (let i = 0; i < Math.max(slots.length, PURPOSE_ROUTE_CHAIN_LEN); i++) {
		const slot: RouteSlot = slots[i] ?? {
			providerId: null,
			model: null,
		};
		if (!slot.providerId && !slot.model) continue;
		candidates.push({
			providerId: slot.providerId,
			model: slot.model,
			slotIndex: i + 1,
		});
	}

	// Always append default provider as last resort if not already covered
	const defaultId =
		notebook?.provider_profile_id ||
		settings.defaultProviderId ||
		settings.providers[0]?.id ||
		null;
	if (defaultId) {
		candidates.push({
			providerId: defaultId,
			model: null,
			slotIndex: candidates.length + 1,
		});
	}

	const out: ResolvedProvider[] = [];
	const seen = new Set<string>();

	const pushResolved = (
		providerId: string | null,
		modelOverride: string | null,
		slotIndex: number,
		preferVision: boolean,
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

		let model =
			(slotIndex === 1 ? notebookModel : null) ||
			modelOverride ||
			profile.defaultModel ||
			profile.models[0] ||
			"";

		if (preferVision) {
			const visionPick = pickVisionModel(profile, model);
			if (visionPick) model = visionPick;
		}
		if (need?.stt || purpose === "voice") {
			const sttPick = pickSttModel(profile, model);
			if (sttPick) model = sttPick;
		}
		if (!model && purpose === "voice") model = "whisper-1";
		if (!model && purpose !== "voice") return;

		const key = `${profile.id}::${model}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ profile, model: model || "whisper-1", slotIndex });
	};

	// Pass 1: if vision needed, prefer slots / models that look vision-capable first
	if (need?.vision) {
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
				pushResolved(c.providerId, c.model, c.slotIndex, true);
			}
		}
	}

	// Pass 2: all candidates in configured order
	for (const c of candidates) {
		pushResolved(c.providerId, c.model, c.slotIndex, Boolean(need?.vision));
	}

	// Pass 3: any remaining configured providers (for vision miss / hard fallback)
	if (need?.vision || out.length === 0) {
		for (let i = 0; i < settings.providers.length; i++) {
			const p = settings.providers[i]!;
			pushResolved(
				p.id,
				need?.vision ? pickVisionModel(p, null) : null,
				100 + i,
				Boolean(need?.vision),
			);
		}
	}

	return out;
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

function pickVisionModel(
	profile: ProviderProfile,
	preferred: string | null,
): string | null {
	if (preferred && looksVisionCapable(preferred)) return preferred;
	const fromList = profile.models.find((m) => looksVisionCapable(m));
	if (fromList) return fromList;
	if (preferred) return preferred;
	return profile.defaultModel || profile.models[0] || null;
}

function pickSttModel(
	profile: ProviderProfile,
	preferred: string | null,
): string | null {
	if (preferred && /whisper|transcrib|speech|asr/i.test(preferred)) {
		return preferred;
	}
	const stt = profile.models.find((m) =>
		/whisper|transcrib|speech|asr/i.test(m),
	);
	return stt || preferred || profile.defaultModel || profile.models[0] || null;
}

/** Error text suggests model cannot accept images / multimodal. */
export function isVisionCapabilityError(error: string): boolean {
	return /vision|image|multimodal|does not support|unsupported.*(image|content)|invalid.*(image|content_type)|unknown variant|content part|not support/i.test(
		error,
	);
}
