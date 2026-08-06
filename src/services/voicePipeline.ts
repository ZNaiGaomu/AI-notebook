import type {
	AiNotebookSettings,
	NotebookMeta,
	ProviderProfile,
} from "../domain/types";
import { createId, shortId, todayDatePrefix } from "../domain/ids";
import { joinPath, structuredAttachmentsDir } from "../infra/paths";
import type { IVaultFs } from "../infra/vaultPort";
import type { AiGateway } from "../infra/aiGateway";
import type { VoiceService } from "./voiceService";

export type VoiceResolved = {
	profile: ProviderProfile;
	model: string;
	/** 1-based slot in purpose chain */
	slotIndex?: number;
};

export type VoicePipelineResult = {
	/** Always set when save succeeded */
	vaultPath: string | null;
	/** Markdown embed + path line for note body */
	embedMarkdown: string;
	/** Raw STT text */
	transcript: string;
	/** Polished text if polish ran successfully; else empty */
	polished: string;
	method: "whisper" | "chat-audio" | "none";
	/** Short user-facing summary (safe for notice / short note line) */
	error?: string;
	/** Longer detail for diagnostics (not dumped into note body) */
	errorDetail?: string;
	/** Classified reason when ok=false */
	errorKind?: VoiceErrorKind;
	/** True if we got usable transcript text */
	ok: boolean;
};

export type VoiceErrorKind =
	| "save_failed"
	| "no_provider"
	| "stt_unavailable"
	| "model_no_audio"
	| "audio_too_large"
	| "unknown";

const STT_TIMEOUT_MS = 45_000;
const CHAT_AUDIO_TIMEOUT_MS = 55_000;

/**
 * 1) Save audio into vault attachments (always when possible)
 * 2) Try classic /audio/transcriptions (Whisper) across **voice** chain only
 * 3) Optional: chat multimodal listen on **voice** chain only (not worker/planner)
 */
export class VoicePipeline {
	constructor(
		private readonly vault: IVaultFs,
		private readonly voice: VoiceService,
		private readonly gateway: AiGateway,
		private readonly getSettings: () => AiNotebookSettings,
		/**
		 * Ordered candidates for a purpose (multi-slot).
		 * Callers should pass resolveProviderChain results.
		 */
		private readonly resolveChain: (
			purpose: "planner" | "worker" | "voice",
			notebook?: NotebookMeta | null,
		) => VoiceResolved[],
	) {}

	async saveAudioFile(
		meta: NotebookMeta,
		blob: Blob,
		filename: string,
	): Promise<{ vaultPath: string; arrayBuffer: ArrayBuffer }> {
		const settings = this.getSettings();
		const dir = structuredAttachmentsDir(
			settings,
			meta.notebook_id,
			meta.name,
			null,
			null,
			"voice",
		);
		await this.vault.ensureFolder(dir);
		const safe = sanitizeName(filename || "audio.wav");
		const vaultPath = joinPath(
			dir,
			`voice-${todayDatePrefix()}-${shortId(createId(), 6)}-${safe}`,
		);
		const arrayBuffer = await blob.arrayBuffer();
		if (!this.vault.writeBinary) {
			throw new Error("当前存储层不支持写入二进制音频");
		}
		await this.vault.writeBinary(vaultPath, arrayBuffer);
		return { vaultPath, arrayBuffer };
	}

	async process(
		meta: NotebookMeta,
		blob: Blob,
		filename: string,
		opts?: {
			onProgress?: (msg: string) => void;
			existing?: { vaultPath: string; arrayBuffer: ArrayBuffer };
		},
	): Promise<VoicePipelineResult> {
		const progress = (msg: string) => {
			try {
				opts?.onProgress?.(msg);
			} catch {
				/* ignore */
			}
		};

		let vaultPath: string | null = null;
		let arrayBuffer: ArrayBuffer;
		try {
			if (opts?.existing?.vaultPath && opts.existing.arrayBuffer) {
				vaultPath = opts.existing.vaultPath;
				arrayBuffer = opts.existing.arrayBuffer;
				progress("音频已就绪，开始转写…");
			} else {
				progress("正在保存录音…");
				const saved = await this.saveAudioFile(meta, blob, filename);
				vaultPath = saved.vaultPath;
				arrayBuffer = saved.arrayBuffer;
				progress("录音已保存，开始转写…");
			}
		} catch (e) {
			return {
				vaultPath: null,
				embedMarkdown: "",
				transcript: "",
				polished: "",
				method: "none",
				ok: false,
				errorKind: "save_failed",
				error: `保存音频失败: ${e instanceof Error ? e.message : String(e)}`,
			};
		}

		const embedMarkdown = buildEmbedMarkdown(vaultPath);

		// Voice purpose chain ONLY — never pull worker/planner into STT/chat-audio
		// Full voice purpose chain including user-prioritized TTS models
		const voiceChain = dedupeResolved(this.resolveChain("voice", meta));

		// Prepare STT payload: keep original + optional 16k wav
		const originalBlob = new Blob([arrayBuffer], {
			type: blob.type || guessMime(filename),
		});
		let sttBlob = originalBlob;
		let sttFilename = filename || "audio.wav";
		let sttArrayBuffer = arrayBuffer;
		const wantTranscode = this.getSettings().voice?.transcodeWavForStt !== false;
		const isWav =
			(sttFilename || "").toLowerCase().endsWith(".wav") ||
			(blob.type || "").includes("wav");
		if (wantTranscode && !isWav && typeof window !== "undefined") {
			progress("转码为 16k WAV 以提高 STT 兼容…");
			try {
				const { blobTo16kWav } = await import("../infra/audioWav");
				sttBlob = await blobTo16kWav(originalBlob);
				sttFilename = "audio-16k.wav";
				sttArrayBuffer = await sttBlob.arrayBuffer();
			} catch {
				// keep original
				sttBlob = originalBlob;
				sttFilename = filename || "audio.m4a";
			}
		}

		const sttErrors: string[] = [];
		if (voiceChain.length === 0) {
			sttErrors.push("未配置语音用途服务商/模型");
		}
		const total = voiceChain.length;
		progress(`STT：共 ${total} 个候选，按优先级轮询…`);

		for (let ci = 0; ci < voiceChain.length; ci++) {
			const cand = voiceChain[ci]!;
			progress(`STT ${ci + 1}/${total}：${formatCand(cand)}`);
			// Try 16k wav first (if prepared), then original container
			const attempts: Array<{ blob: Blob; name: string }> = [
				{ blob: sttBlob, name: sttFilename },
			];
			if (sttFilename !== (filename || "audio.wav")) {
				attempts.push({
					blob: originalBlob,
					name: filename || "audio.m4a",
				});
			}
			let lastErr = "";
			let okText = "";
			for (const att of attempts) {
				const stt = await withTimeout(
					this.voice.transcribe(
						cand.profile,
						cand.model,
						att.blob,
						att.name,
					),
					STT_TIMEOUT_MS,
					`STT 超时 ${Math.round(STT_TIMEOUT_MS / 1000)}s (${att.name})`,
				);
				if (stt.ok && stt.text.trim()) {
					okText = stt.text.trim();
					break;
				}
				lastErr = stt.ok ? "响应无文本" : classifyHttpish(stt.error);
			}
			if (okText) {
				progress("转写成功，正在润色…");
				const polished = await this.maybePolish(meta, okText);
				return {
					vaultPath,
					embedMarkdown,
					transcript: okText,
					polished,
					method: "whisper",
					ok: true,
				};
			}
			sttErrors.push(`${formatCand(cand)}: ${lastErr || "失败"}`);
		}

		// Chat listen: default ON, but ONLY voice chain (not worker/planner)
		const allowChat = this.getSettings().voice?.allowChatAudioFallback !== false;
		if (!allowChat) {
			progress("STT 失败（对话听音频已关）");
			return {
				vaultPath,
				embedMarkdown,
				transcript: "",
				polished: "",
				method: "none",
				ok: false,
				errorKind: sttErrors.length ? "stt_unavailable" : "no_provider",
				error:
					"自动转写失败（仅 STT）。请确认语音用途绑定 asr/whisper，或开启「对话听音频回退」。",
				errorDetail: sttErrors.slice(0, 6).join(" · "),
			};
		}

		if (voiceChain.length === 0) {
			return {
				vaultPath,
				embedMarkdown,
				transcript: "",
				polished: "",
				method: "none",
				ok: false,
				errorKind: "no_provider",
				error: "未配置语音用途服务商，无法自动转写（录音已保存）",
				errorDetail: sttErrors.join(" · "),
			};
		}

		// Prefer wav bytes for chat listen when we have them
		const chatBuf = sttArrayBuffer;
		const b64 = arrayBufferToBase64(chatBuf);
		if (b64.length > 5_500_000) {
			return {
				vaultPath,
				embedMarkdown,
				transcript: "",
				polished: "",
				method: "none",
				ok: false,
				errorKind: "audio_too_large",
				error: "音频过大，无法用对话回退。录音已保存。",
				errorDetail: sttErrors.join(" · "),
			};
		}

		const format: "wav" | "mp3" =
			sttFilename.toLowerCase().endsWith(".mp3") ||
			(blob.type || "").includes("mpeg")
				? "mp3"
				: "wav";

		const chatErrors: string[] = [];
		let sawNoAudio = false;
		let sawHttpFail = false;

		progress("STT 未成功，尝试对话听音频（仅语音用途链）…");
		// Cap chat fallback models to avoid endless hang
		// Full voice chain for chat listen too (user asked full poll)
		const chatCands = voiceChain;
		for (let ci = 0; ci < chatCands.length; ci++) {
			const cand = chatCands[ci]!;
			progress(`听音频 ${ci + 1}/${chatCands.length}：${formatCand(cand)}`);
			const chat = await withTimeout(
				this.gateway.chatTranscribeAudio(
					cand.profile,
					cand.model,
					b64,
					format,
				),
				CHAT_AUDIO_TIMEOUT_MS,
				`听音频超时 ${Math.round(CHAT_AUDIO_TIMEOUT_MS / 1000)}s`,
			);
			const label = formatCand(cand);
			if (chat.ok && chat.content.trim()) {
				const cleaned = stripTranscriptNoise(chat.content.trim());
				if (cleaned && !isBogusTranscript(cleaned)) {
					progress("听音频成功，正在润色…");
					const polished = await this.maybePolish(meta, cleaned);
					return {
						vaultPath,
						embedMarkdown,
						transcript: cleaned,
						polished,
						method: "chat-audio",
						ok: true,
					};
				}
				sawNoAudio = true;
				chatErrors.push(
					`${label}: 模型未收到音频（${cleaned.slice(0, 60) || "空"}）`,
				);
				continue;
			}
			sawHttpFail = true;
			chatErrors.push(
				`${label}: ${chat.ok ? "无文本" : classifyHttpish(chat.error)}`,
			);
		}

		const errorKind: VoiceErrorKind = sawNoAudio
			? "model_no_audio"
			: sawHttpFail && sttErrors.length
				? "stt_unavailable"
				: "unknown";

		const short =
			errorKind === "model_no_audio"
				? "模型未真正收到音频（NO_AUDIO）。请优先用支持 /audio/transcriptions 的 asr/whisper 模型。"
				: "自动转写失败。录音已保存，可在笔记中播放。";

		progress("转写结束：失败");
		return {
			vaultPath,
			embedMarkdown,
			transcript: "",
			polished: "",
			method: "none",
			ok: false,
			errorKind,
			error: short,
			errorDetail: [
				sttErrors.length ? `STT: ${sttErrors.slice(0, 4).join(" · ")}` : "",
				chatErrors.length
					? `听音频: ${chatErrors.slice(0, 4).join(" · ")}`
					: "",
			]
				.filter(Boolean)
				.join("\n"),
		};
	}

	private async maybePolish(
		meta: NotebookMeta,
		transcript: string,
	): Promise<string> {
		const settings = this.getSettings();
		const polish = settings.voice?.polish;
		// Always attempt polish after STT when possible (user expects 转写+润色).
		// Only skip if explicitly force-disabled.
		if (polish && polish.enabled === false && (polish as { forceOff?: boolean }).forceOff) {
			return "";
		}
		const text = transcript.trim();
		if (!text || isBogusTranscript(text)) return "";

		const pid =
			polish.providerId ||
			settings.defaultProviderId ||
			settings.providers[0]?.id ||
			null;
		if (!pid) return "";
		const profile = settings.providers.find((p) => p.id === pid);
		if (!profile?.baseUrl.trim() || !profile.apiKey.trim()) {
			const chain = this.resolveChain("worker", meta);
			if (!chain[0]) return "";
			return this.runPolish(
				chain[0].profile,
				chain[0].model,
				polish.prompt,
				text,
			);
		}
		const model =
			(polish.model && polish.model.trim()) ||
			profile.defaultModel ||
			profile.models[0] ||
			"";
		if (!model) return "";
		return this.runPolish(profile, model, polish.prompt, text);
	}

	private async runPolish(
		profile: ProviderProfile,
		model: string,
		prompt: string,
		transcript: string,
	): Promise<string> {
		const raw = transcript.trim();
		if (!raw || isBogusTranscript(raw)) return "";
		const system =
			(prompt && prompt.trim()) ||
			"请润色语音转写原文：通顺分段、去口头禅，不编造。只输出正文。";
		const user =
			"以下是已完成的语音转写原文（不是音频文件）。请仅润色这段文字：\n\n" +
			raw.slice(0, 12000);
		try {
			const chat = await withTimeout(
				this.gateway.chat(
					profile,
					model,
					[
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					{ maxTokens: 2048, temperature: 0.3 },
				),
				30_000,
				"润色超时",
			);
			if (!chat.ok) return "";
			const out = (chat.content || "").trim();
			if (!out || isBogusTranscript(out)) return "";
			if (
				/提供.*语音|语音文件|转写原文|NO_AUDIO/i.test(out) &&
				out.length < 120
			) {
				return "";
			}
			return out;
		} catch {
			return "";
		}
	}
}

export function buildEmbedMarkdown(vaultPath: string): string {
	return `\n\n## 录音\n\n![[${vaultPath}]]\n\n> 录音文件：\`${vaultPath}\`\n`;
}

/**
 * If AI rewrite dropped vault embeds from original text, append them back.
 */
export function ensureEmbedsPreserved(
	original: string,
	nextBody: string,
): string {
	const embeds = original.match(/!\[\[[^\]]+\]\]/g) ?? [];
	if (!embeds.length) return nextBody;
	let out = nextBody;
	const missing: string[] = [];
	for (const e of embeds) {
		if (!out.includes(e)) missing.push(e);
	}
	if (!missing.length) return out;
	return `${out.trimEnd()}\n\n## 录音\n\n${missing.join("\n")}\n`;
}

function sanitizeName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "_") || "audio.wav";
}

function guessMime(filename: string): string {
	const l = filename.toLowerCase();
	if (l.endsWith(".wav")) return "audio/wav";
	if (l.endsWith(".mp3")) return "audio/mpeg";
	if (l.endsWith(".m4a") || l.endsWith(".mp4")) return "audio/mp4";
	if (l.endsWith(".webm")) return "audio/webm";
	return "application/octet-stream";
}

function looksLikeTtsModel(model: string): boolean {
	return /tts|voiceclone|voicedesign|text-to-speech/i.test(model);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunk = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunk) {
		const sub = bytes.subarray(i, i + chunk);
		binary += String.fromCharCode(...sub);
	}
	return btoa(binary);
}

function stripTranscriptNoise(text: string): string {
	return text
		.replace(/^```[\s\S]*?\n/, "")
		.replace(/```$/, "")
		.replace(/^转写[：:]\s*/i, "")
		.trim();
}

/** Refuse to treat model "I got no audio" replies as real transcripts. */
function isBogusTranscript(text: string): boolean {
	const t = text.trim();
	if (!t) return true;
	if (/^NO_AUDIO\b/i.test(t)) return true;
	if (/\bNO_AUDIO\b/i.test(t) && t.length < 400) return true;
	const head = t.split("\n")[0]?.trim() || t;
	if (/^NO_AUDIO\b/i.test(head)) return true;
	return [
		/未提供.*音频/,
		/没有.*音频/,
		/无.*音频(文件|内容|数据)?/,
		/无法转写/,
		/no audio/i,
		/didn'?t provide any audio/i,
		/did not provide any audio/i,
		/not provide any audio/i,
		/消息中.*音频/,
		/cannot (find|access|hear).*audio/i,
		/user (hasn'?t|has not|didn'?t|did not).*audio/i,
	].some((re) => re.test(t));
}

function formatCand(c: VoiceResolved): string {
	const slot = c.slotIndex ? `#${c.slotIndex}` : "";
	return `${c.profile.name || c.profile.id}${slot}/${c.model}`;
}

function dedupeResolved(list: VoiceResolved[]): VoiceResolved[] {
	const out: VoiceResolved[] = [];
	const seen = new Set<string>();
	for (const r of list) {
		const key = `${r.profile.id}::${r.model}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	return out;
}

function classifyHttpish(err: string): string {
	const e = err || "";
	if (/timeout|超时/i.test(e)) return "超时";
	if (/404|not found|does not exist/i.test(e)) {
		return "接口/模型不存在（可能无 /audio/transcriptions）";
	}
	if (/401|403|unauthorized|invalid.*key/i.test(e)) {
		return "鉴权失败（检查 API Key）";
	}
	if (/429|rate limit/i.test(e)) return "限流";
	if (/ETIMEDOUT|aborted/i.test(e)) return "超时";
	return e.slice(0, 120);
}

async function withTimeout<T>(
	p: Promise<T>,
	ms: number,
	timeoutMsg: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			p,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(timeoutMsg)), ms);
			}),
		]);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// Normalize timeout into TranscribeResult-like failures for callers that expect objects
		if (/超时|timeout/i.test(msg)) {
			// For voice.transcribe / chat results we need typed returns — callers pass those promises.
			// Re-throw only if not a result-shaped promise; wrap as false-like via throw for outer catch.
		}
		// If the raced promise was TranscribeResult/ChatResult, return error-shaped when timeout
		if (/超时|timeout/i.test(msg)) {
			return { ok: false as const, error: msg } as T;
		}
		throw e;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
