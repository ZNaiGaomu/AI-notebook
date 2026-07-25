import type { App } from "obsidian";
import type { AiNotebookSettings, ProviderProfile } from "../domain/types";
import { encodeWavMono } from "../infra/audioWav";
import type { AiGateway } from "../infra/aiGateway";
import { isNoAudioReply } from "../infra/aiGateway";
import type { VoiceService } from "./voiceService";

export type VoiceDiagLine = {
	step: string;
	ok: boolean;
	detail: string;
};

export type Resolved = {
	profile: ProviderProfile;
	model: string;
	slotIndex?: number;
};

/**
 * In-app probe: does NOT print API keys.
 * - Voice-chain probe (default)
 * - Full catalog probe of every configured provider × model
 */
export class VoiceDiagnostics {
	constructor(
		private readonly app: App,
		private readonly voice: VoiceService,
		private readonly gateway: AiGateway,
		private readonly getSettings: () => AiNotebookSettings,
		private readonly resolve: (
			purpose: "planner" | "worker" | "voice",
		) => Resolved | null,
		private readonly resolveChain?: (
			purpose: "planner" | "worker" | "voice",
		) => Resolved[],
	) {}

	async run(): Promise<VoiceDiagLine[]> {
		return this.runVoiceChain();
	}

	/** Probe only the resolved voice purpose chain. */
	async runVoiceChain(): Promise<VoiceDiagLine[]> {
		const lines: VoiceDiagLine[] = [];
		const settings = this.getSettings();
		const voiceR = this.resolve("voice");
		const workerR = this.resolve("worker") || this.resolve("planner");
		const chain =
			this.resolveChain?.("voice") ?? (voiceR ? [voiceR] : []);

		lines.push({
			step: "配置·语音用途链",
			ok: chain.length > 0,
			detail: chain.length
				? chain
						.map(
							(c, i) =>
								"#" +
								String(c.slotIndex ?? i + 1) +
								" " +
								c.profile.name +
								"/" +
								c.model,
						)
						.join(" · ")
				: "未解析到语音 Provider",
		});
		lines.push({
			step: "配置·对话听音频回退",
			ok: settings.voice?.allowChatAudioFallback !== false,
			detail:
				settings.voice?.allowChatAudioFallback === false
					? "已关闭（仅 STT）"
					: "已开启",
		});

		const wav = this.makeProbeWav();
		lines.push({
			step: "本地测试音频",
			ok: wav.size > 100,
			detail: "合成 1 秒 WAV，" + String(wav.size) + " 字节",
		});

		const sttOk: string[] = [];
		const toProbe = chain.slice(0, 12);
		for (const cand of toProbe) {
			const label = cand.profile.name + "/" + cand.model;
			const stt = await this.voice.transcribe(
				cand.profile,
				cand.model,
				wav,
				"probe.wav",
			);
			lines.push({
				step: "STT · " + label,
				ok: stt.ok,
				detail: stt.ok
					? "可用 · " + stt.text.slice(0, 40)
					: "不可用：" + stt.error,
			});
			if (stt.ok) sttOk.push(label);
		}

		const chatCand =
			workerR || chain.find((c) => !/tts/i.test(c.model)) || chain[0];
		if (chatCand) {
			const r = await this.probeChat(chatCand, wav);
			lines.push(r.line);
		}

		lines.push({
			step: "结论·语音链可用模型",
			ok: sttOk.length > 0,
			detail: sttOk.length
				? "STT 可用：" + sttOk.join("、")
				: "语音链上 STT 均不可用。请运行「诊断全部模型语音能力」。",
		});
		void this.app;
		return lines;
	}

	/**
	 * Probe EVERY configured provider × model for STT + chat-audio.
	 * Can be slow; skips empty key/url.
	 */
	async runFullCatalog(opts?: {
		onProgress?: (msg: string) => void;
		maxPerProvider?: number;
	}): Promise<{
		lines: VoiceDiagLine[];
		sttOk: string[];
		chatOk: string[];
	}> {
		const lines: VoiceDiagLine[] = [];
		const settings = this.getSettings();
		const wav = this.makeProbeWav();
		const sttOk: string[] = [];
		const chatOk: string[] = [];
		const maxPer = Math.max(1, opts?.maxPerProvider ?? 40);
		const progress = (m: string) => {
			try {
				opts?.onProgress?.(m);
			} catch {
				/* ignore */
			}
		};

		const providers = settings.providers.filter(
			(p) => p.baseUrl.trim() && p.apiKey.trim(),
		);
		lines.push({
			step: "全量体检·范围",
			ok: providers.length > 0,
			detail:
				"服务商 " +
				String(providers.length) +
				" 家；每家最多测 " +
				String(maxPer) +
				" 个模型；含 STT + 听音频",
		});

		let total = 0;
		for (const p of providers) {
			total += Math.min(maxPer, uniqueModels(p).length);
		}
		let done = 0;

		for (const profile of providers) {
			const models = uniqueModels(profile).slice(0, maxPer);
			for (const model of models) {
				done++;
				const label = profile.name + "/" + model;
				progress(
					"体检 " +
						String(done) +
						"/" +
						String(total) +
						" · " +
						label,
				);

				const stt = await this.voice.transcribe(
					profile,
					model,
					wav,
					"probe.wav",
				);
				const sttLine: VoiceDiagLine = {
					step: "STT · " + label,
					ok: stt.ok,
					detail: stt.ok
						? "可用 · " + stt.text.slice(0, 48)
						: "不可用：" + (stt.error || "").slice(0, 120),
				};
				lines.push(sttLine);
				if (stt.ok) sttOk.push(label);

				// Chat-audio only for non-obvious TTS to save time? User asked ALL models.
				const chat = await this.probeChat(
					{ profile, model },
					wav,
				);
				lines.push(chat.line);
				if (chat.ok) chatOk.push(label);
			}
		}

		lines.push({
			step: "结论·真正能语音转文字的模型",
			ok: sttOk.length + chatOk.length > 0,
			detail: [
				sttOk.length
					? "【STT /audio/transcriptions 可用】\n" +
						sttOk.map((s) => "- " + s).join("\n")
					: "【STT】无一可用（多数中转未开 transcriptions）",
				chatOk.length
					? "【对话听音频可用】\n" +
						chatOk.map((s) => "- " + s).join("\n")
					: "【听音频】无一可用",
				"建议：语音用途优先绑定 STT 可用模型；若仅听音频可用，保持「对话听音频回退」开启。",
			].join("\n\n"),
		});

		void this.app;
		return { lines, sttOk, chatOk };
	}

	private makeProbeWav(): Blob {
		const sampleRate = 16000;
		const samples = new Float32Array(sampleRate);
		for (let i = 0; i < samples.length; i++) {
			samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.25;
		}
		return encodeWavMono(samples, sampleRate);
	}

	private async probeChat(
		cand: { profile: ProviderProfile; model: string },
		wav: Blob,
	): Promise<{ ok: boolean; line: VoiceDiagLine }> {
		const label = cand.profile.name + "/" + cand.model;
		try {
			const buf = await wav.arrayBuffer();
			const b64 = arrayBufferToBase64(buf);
			const chat = await this.gateway.chatTranscribeAudio(
				cand.profile,
				cand.model,
				b64,
				"wav",
			);
			if (!chat.ok) {
				return {
					ok: false,
					line: {
						step: "听音频 · " + label,
						ok: false,
						detail: "失败：" + (chat.error || "").slice(0, 120),
					},
				};
			}
			if (isNoAudioReply(chat.content) || isBogus(chat.content)) {
				return {
					ok: false,
					line: {
						step: "听音频 · " + label,
						ok: false,
						detail: "未真正收到音频：" + chat.content.slice(0, 80),
					},
				};
			}
			return {
				ok: true,
				line: {
					step: "听音频 · " + label,
					ok: true,
					detail: "可用：" + chat.content.slice(0, 80),
				},
			};
		} catch (e) {
			return {
				ok: false,
				line: {
					step: "听音频 · " + label,
					ok: false,
					detail:
						"异常：" +
						(e instanceof Error ? e.message : String(e)).slice(0, 120),
				},
			};
		}
	}
}

function uniqueModels(p: ProviderProfile): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of [p.defaultModel, ...p.models]) {
		const s = (m || "").trim();
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunk = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function isBogus(text: string): boolean {
	return [
		/未提供.*音频/,
		/没有.*音频/,
		/无法转写/,
		/消息中.*音频/,
		/no audio/i,
		/didn.?t provide any audio/i,
		/NO_AUDIO/i,
	].some((re) => re.test(text));
}
