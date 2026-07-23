import type { ProviderProfile } from "../domain/types";
import { normalizeBaseUrl } from "../infra/aiGateway";
import { requestMultipart } from "../infra/httpClient";

export type TranscribeResult =
	| { ok: true; text: string }
	| { ok: false; error: string };

/**
 * Voice transcription via OpenAI-compatible /audio/transcriptions.
 * Uses Obsidian requestUrl multipart to avoid CORS Failed to fetch.
 */
export class VoiceService {
	async transcribe(
		profile: ProviderProfile,
		model: string,
		blob: Blob,
		filename = "audio.wav",
	): Promise<TranscribeResult> {
		if (!profile.baseUrl.trim() || !profile.apiKey.trim()) {
			return { ok: false, error: "Provider 未配置完整（URL/Key）" };
		}
		if (!blob || blob.size < 100) {
			return { ok: false, error: "录音数据为空或过短" };
		}

		const base = normalizeBaseUrl(profile.baseUrl);
		const url = `${base}/audio/transcriptions`;
		const { name, type, data } = await toUploadBytes(blob, filename);

		const modelsToTry = uniqueNonEmpty([
			looksLikeSttModel(model) ? model : "",
			"whisper-1",
			"gpt-4o-mini-transcribe",
			"gpt-4o-transcribe",
			looksLikeSttModel(profile.defaultModel) ? profile.defaultModel : "",
			model,
			profile.defaultModel,
			...profile.models.filter(looksLikeSttModel),
		]);

		const fieldStrategies: Array<{
			fieldName: string;
			extra: Record<string, string>;
		}> = [
			{
				fieldName: "file",
				extra: { response_format: "json" },
			},
			{
				fieldName: "file",
				extra: { language: "zh", response_format: "json" },
			},
			{ fieldName: "audio", extra: {} },
		];

		const errors: string[] = [];
		for (const m of modelsToTry) {
			for (let si = 0; si < fieldStrategies.length; si++) {
				const strat = fieldStrategies[si]!;
				const res = await requestMultipart({
					url,
					headers: {
						Authorization: `Bearer ${profile.apiKey}`,
					},
					fields: {
						model: m,
						...strat.extra,
					},
					file: {
						fieldName: strat.fieldName,
						filename: name,
						mime: type,
						data,
					},
				});
				if (!res.ok) {
					errors.push(`model=${m} s${si}: HTTP ${res.status} ${res.error}`);
					if (
						/model|not found|does not exist|invalid model/i.test(res.error)
					) {
						break; // next model
					}
					continue;
				}
				const content = extractTranscript(res.data);
				if (!content?.trim()) {
					errors.push(`model=${m} s${si}: 响应无 text`);
					continue;
				}
				return { ok: true, text: content.trim() };
			}
		}

		return {
			ok: false,
			error:
				errors.slice(0, 4).join(" | ") ||
				`转写失败（已试 ${modelsToTry.length} 个模型 → ${url}）`,
		};
	}
}

async function toUploadBytes(
	blob: Blob,
	filename: string,
): Promise<{ name: string; type: string; data: ArrayBuffer }> {
	const lower = filename.toLowerCase();
	let name = filename;
	let type = blob.type || "";

	if (type.includes("wav") || lower.endsWith(".wav") || !type) {
		name = name.toLowerCase().endsWith(".wav") ? name : "audio.wav";
		type = "audio/wav";
	} else if (
		type.includes("mpeg") ||
		type.includes("mp3") ||
		lower.endsWith(".mp3")
	) {
		name = lower.endsWith(".mp3") ? name : "audio.mp3";
		type = "audio/mpeg";
	} else if (
		type.includes("mp4") ||
		type.includes("m4a") ||
		lower.endsWith(".m4a")
	) {
		name = lower.endsWith(".m4a") ? name : "audio.m4a";
		type = type.includes("mp4") ? type : "audio/mp4";
	} else if (type.includes("webm") || lower.endsWith(".webm")) {
		name = lower.endsWith(".webm") ? name : "audio.webm";
		type = "audio/webm";
	} else {
		name = "audio.wav";
		type = "audio/wav";
	}

	const data = await blob.arrayBuffer();
	return { name, type, data };
}

function looksLikeSttModel(m: string | null | undefined): boolean {
	if (!m) return false;
	const s = m.toLowerCase();
	return (
		s.includes("whisper") ||
		s.includes("transcrib") ||
		s.includes("speech") ||
		s.includes("asr") ||
		s.includes("stt")
	);
}

function extractTranscript(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const text = (data as { text?: unknown }).text;
	if (typeof text === "string" && text.trim()) return text;
	const nested = (data as { data?: { text?: unknown } }).data?.text;
	if (typeof nested === "string" && nested.trim()) return nested;
	const segs = (data as { segments?: Array<{ text?: string }> }).segments;
	if (Array.isArray(segs)) {
		const joined = segs.map((s) => s.text || "").join("").trim();
		if (joined) return joined;
	}
	return null;
}

function uniqueNonEmpty(arr: Array<string | null | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const a of arr) {
		const s = (a || "").trim();
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out.length ? out : ["whisper-1"];
}
