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

		// Caller already resolved purpose chain — prefer the given model first.
		// Only expand to common STT aliases if the primary model fails hard.
		const primary = (model || "").trim();
		const modelsToTry = uniqueNonEmpty([
			primary,
			// light aliases only when primary is empty or clearly generic
			!primary || primary === profile.defaultModel
				? "whisper-1"
				: "",
		]);

		const fieldStrategies: Array<{
			fieldName: string;
			extra: Record<string, string>;
		}> = [
			{
				fieldName: "file",
				extra: { response_format: "json" },
			},
			// second strategy only if first fails with non-model error
			{
				fieldName: "file",
				extra: { language: "zh", response_format: "json" },
			},
		];

		const errors: string[] = [];
		for (const m of modelsToTry) {
			let modelInvalid = false;
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
						modelInvalid = true;
						break; // next model
					}
					// for primary model, try one more field strategy then stop model
					continue;
				}
				let content = extractTranscript(res.data);
					if (!content?.trim() && res.text) {
						content = extractTranscript(res.text);
					}
				if (!content?.trim()) {
					errors.push(`model=${m} s${si}: 响应无 text`);
					continue;
				}
				return { ok: true, text: content.trim() };
			}
			if (modelInvalid && m === primary && modelsToTry.length === 1) {
				// optional single alias retry
				continue;
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
	if (data == null) return null;
	if (typeof data === "string" && data.trim()) {
		const s = data.trim();
		if (s.startsWith("{") || s.startsWith("[")) {
			try {
				return extractTranscript(JSON.parse(s));
			} catch {
				return s;
			}
		}
		return s;
	}
	if (typeof data !== "object") return null;
	const o = data as Record<string, unknown>;

	if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
	for (const k of ["result", "transcript", "transcription", "content"]) {
		const v = o[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	if (o.data != null) {
		const nested = extractTranscript(o.data);
		if (nested) return nested;
	}
	// Xiaomi / DashScope-style
	if (o.output != null && typeof o.output === "object") {
		const out = o.output as Record<string, unknown>;
		if (typeof out.text === "string" && out.text.trim()) return out.text.trim();
		if (typeof out.sentence === "string" && out.sentence.trim()) {
			return out.sentence.trim();
		}
		if (Array.isArray(out.sentences)) {
			const joined = out.sentences
				.map((s) =>
					s && typeof s === "object"
						? String((s as { text?: string }).text || "")
						: String(s || ""),
				)
				.join("")
				.trim();
			if (joined) return joined;
		}
		const nestedOut = extractTranscript(out);
		if (nestedOut) return nestedOut;
	}
	const segs = o.segments;
	if (Array.isArray(segs)) {
		const joined = segs
			.map((s) =>
				s && typeof s === "object"
					? String((s as { text?: string }).text || "")
					: "",
			)
			.join("")
			.trim();
		if (joined) return joined;
	}
	const choices = o.choices;
	if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
		const c0 = choices[0] as Record<string, unknown>;
		if (typeof c0.text === "string" && c0.text.trim()) return c0.text.trim();
		const msg = c0.message;
		if (msg && typeof msg === "object") {
			const content = (msg as { content?: unknown }).content;
			if (typeof content === "string" && content.trim()) return content.trim();
		}
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
