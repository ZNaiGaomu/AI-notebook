import type {
	AiNotebookSettings,
	NotebookMeta,
	ProviderProfile,
} from "../domain/types";

export type Purpose = "planner" | "worker" | "voice";

export function resolveProvider(
	settings: AiNotebookSettings,
	purpose: Purpose,
	notebook?: NotebookMeta | null,
): { profile: ProviderProfile; model: string } | null {
	const route = settings.purposeRouting[purpose];
	const notebookModel =
		notebook?.model_overrides?.[purpose] &&
		notebook.model_overrides[purpose]!.trim()
			? notebook.model_overrides[purpose]
			: null;

	let providerId =
		route.providerId ||
		notebook?.provider_profile_id ||
		settings.defaultProviderId;

	// notebook override only for model string in meta; provider still from routing/default
	if (!providerId) {
		providerId = settings.providers[0]?.id ?? null;
	}
	if (!providerId) return null;

	const profile = settings.providers.find((p) => p.id === providerId);
	if (!profile) return null;

	// Voice STT can fall back to whisper-1 even if user only configured chat models
	let model =
		notebookModel ||
		route.model ||
		profile.defaultModel ||
		profile.models[0] ||
		"";
	if (!model && purpose === "voice") {
		model = "whisper-1";
	}
	if (!model && purpose !== "voice") return null;
	if (!profile.baseUrl.trim() || !profile.apiKey.trim()) return null;

	return { profile, model: model || "whisper-1" };
}
