import type { AiNotebookSettings, NotebookMeta, ProviderProfile } from "../domain/types";
import { createId, shortId, todayDatePrefix } from "../domain/ids";
import { attachmentsDir, joinPath } from "../infra/paths";
import type { IVaultFs } from "../infra/vaultPort";
import type { AiGateway } from "../infra/aiGateway";
import type { VoiceService } from "./voiceService";

export type VoicePipelineResult = {
	/** Always set when save succeeded */
	vaultPath: string | null;
	embedMarkdown: string;
	transcript: string;
	method: "whisper" | "chat-audio" | "none";
	/** User-facing detail if transcript empty */
	error?: string;
	/** True if we got usable text */
	ok: boolean;
};

/**
 * 1) Save audio into vault attachments
 * 2) Try classic /audio/transcriptions (Whisper)
 * 3) Fallback: send audio bytes to chat model (input_audio) for "listen & type"
 */
export class VoicePipeline {
	constructor(
		private readonly vault: IVaultFs,
		private readonly voice: VoiceService,
		private readonly gateway: AiGateway,
		private readonly getSettings: () => AiNotebookSettings,
		private readonly resolve: (
			purpose: "planner" | "worker" | "voice",
			notebook?: NotebookMeta | null,
		) => { profile: ProviderProfile; model: string } | null,
	) {}

	async saveAudioFile(
		meta: NotebookMeta,
		blob: Blob,
		filename: string,
	): Promise<{ vaultPath: string; arrayBuffer: ArrayBuffer }> {
		const settings = this.getSettings();
		const dir = attachmentsDir(settings, meta.notebook_id);
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
	): Promise<VoicePipelineResult> {
		let vaultPath: string | null = null;
		let arrayBuffer: ArrayBuffer;
		try {
			const saved = await this.saveAudioFile(meta, blob, filename);
			vaultPath = saved.vaultPath;
			arrayBuffer = saved.arrayBuffer;
		} catch (e) {
			return {
				vaultPath: null,
				embedMarkdown: "",
				transcript: "",
				method: "none",
				ok: false,
				error: `保存音频失败: ${e instanceof Error ? e.message : String(e)}`,
			};
		}

		const embedMarkdown = `\n\n![[${vaultPath}]]\n\n> 录音文件：\`${vaultPath}\`\n`;

		// --- Pass 1: Whisper-style STT ---
		const voiceResolved = this.resolve("voice", meta);
		if (voiceResolved) {
			const typed = new Blob([arrayBuffer], {
				type: blob.type || "audio/wav",
			});
			const stt = await this.voice.transcribe(
				voiceResolved.profile,
				voiceResolved.model,
				typed,
				filename || "audio.wav",
			);
			if (stt.ok && stt.text.trim()) {
				return {
					vaultPath,
					embedMarkdown,
					transcript: stt.text.trim(),
					method: "whisper",
					ok: true,
				};
			}
		}

		// --- Pass 2: Chat model "listens" to file content (base64) ---
		const chatResolved =
			this.resolve("worker", meta) ||
			this.resolve("planner", meta) ||
			voiceResolved;
		if (!chatResolved) {
			return {
				vaultPath,
				embedMarkdown,
				transcript: "",
				method: "none",
				ok: false,
				error:
					(voiceResolved
						? "Whisper 转写失败且无可用对话模型做「听音频」回退"
						: "未配置 Provider") +
					"。音频已保存在库中，可点击笔记内嵌入收听。",
			};
		}

		const b64 = arrayBufferToBase64(arrayBuffer);
		// limit ~4MB base64 payload to avoid API rejection
		if (b64.length > 5_500_000) {
			return {
				vaultPath,
				embedMarkdown,
				transcript: "",
				method: "none",
				ok: false,
				error:
					"音频过大，无法用对话模型回退转写。音频已保存，请换支持 Whisper 的服务商或缩短录音。",
			};
		}

		const format: "wav" | "mp3" =
			(filename || "").toLowerCase().endsWith(".mp3") ||
			(blob.type || "").includes("mpeg")
				? "mp3"
				: "wav";

		const chat = await this.gateway.chatTranscribeAudio(
			chatResolved.profile,
			chatResolved.model,
			b64,
			format,
		);
		if (chat.ok && chat.content.trim()) {
			const cleaned = stripTranscriptNoise(chat.content.trim());
			// Important: model may "succeed" with a refusal like「未提供音频」
			if (cleaned && !isBogusTranscript(cleaned)) {
				return {
					vaultPath,
					embedMarkdown,
					transcript: cleaned,
					method: "chat-audio",
					ok: true,
				};
			}
			// fall through as failure
			return {
				vaultPath,
				embedMarkdown,
				transcript: "",
				method: "none",
				ok: false,
				error:
					`对话模型未真正读到音频（回复: ${cleaned.slice(0, 100)}）。` +
					"当前线路多半只支持纯文本聊天，不支持听 WAV。" +
					"请另配支持 POST /v1/audio/transcriptions（whisper-1）的服务商，并在「用途→语音转写」中指定。",
			};
		}

		return {
			vaultPath,
			embedMarkdown,
			transcript: "",
			method: "none",
			ok: false,
			error:
				`两种方式都失败。Whisper/对话听音频：${chat.ok ? "无文本" : chat.error}。` +
				"音频文件已保存在附件目录，笔记中可播放。",
		};
	}
}

function sanitizeName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "_") || "audio.wav";
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
	if (/^NO_AUDIO$/i.test(t)) return true;
	return [
		/未提供.*音频/,
		/没有.*音频/,
		/无.*音频(文件|内容|数据)?/,
		/无法转写/,
		/no audio/i,
		/消息中.*音频/,
		/cannot (find|access|hear).*audio/i,
	].some((re) => re.test(t));
}
