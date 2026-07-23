import type { App } from "obsidian";
import type { AiNotebookSettings, ProviderProfile } from "../domain/types";
import { encodeWavMono } from "../infra/audioWav";
import type { AiGateway } from "../infra/aiGateway";
import { isNoAudioReply } from "../infra/aiGateway";
import type { VoiceService } from "./voiceService";
import type { resolveProvider } from "./providerResolver";

export type VoiceDiagLine = {
	step: string;
	ok: boolean;
	detail: string;
};

/**
 * In-app probe: does NOT print API keys.
 * Tests Whisper endpoint + chat multimodal audio with a short synthetic WAV.
 */
export class VoiceDiagnostics {
	constructor(
		private readonly app: App,
		private readonly voice: VoiceService,
		private readonly gateway: AiGateway,
		private readonly getSettings: () => AiNotebookSettings,
		private readonly resolve: (
			purpose: "planner" | "worker" | "voice",
		) => { profile: ProviderProfile; model: string } | null,
	) {}

	async run(): Promise<VoiceDiagLine[]> {
		const lines: VoiceDiagLine[] = [];
		const settings = this.getSettings();
		const voiceR = this.resolve("voice");
		const workerR = this.resolve("worker") || this.resolve("planner");

		lines.push({
			step: "配置·语音用途",
			ok: !!voiceR,
			detail: voiceR
				? `服务商「${voiceR.profile.name}」· 模型 ${voiceR.model} · URL ${maskUrl(voiceR.profile.baseUrl)}`
				: "未解析到语音 Provider（请配置服务商与用途路由）",
		});
		lines.push({
			step: "配置·对话用途",
			ok: !!workerR,
			detail: workerR
				? `服务商「${workerR.profile.name}」· 模型 ${workerR.model} · URL ${maskUrl(workerR.profile.baseUrl)}`
				: "未解析到对话 Provider",
		});

		// 1s 440Hz beep WAV
		const sampleRate = 16000;
		const samples = new Float32Array(sampleRate);
		for (let i = 0; i < samples.length; i++) {
			samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.25;
		}
		const wav = encodeWavMono(samples, sampleRate);
		lines.push({
			step: "本地测试音频",
			ok: wav.size > 100,
			detail: `合成 1 秒 WAV，${wav.size} 字节（非你的录音，仅测接口）`,
		});

		// Whisper
		if (voiceR) {
			const stt = await this.voice.transcribe(
				voiceR.profile,
				voiceR.model,
				wav,
				"probe.wav",
			);
			lines.push({
				step: "测试 A · Whisper /audio/transcriptions",
				ok: stt.ok,
				detail: stt.ok
					? `成功，返回文本长度 ${stt.text.length}：${stt.text.slice(0, 60)}`
					: `失败：${stt.error}`,
			});
		} else {
			lines.push({
				step: "测试 A · Whisper /audio/transcriptions",
				ok: false,
				detail: "跳过（无语音 Provider）",
			});
		}

		// Chat audio
		if (workerR) {
			const buf = await wav.arrayBuffer();
			const b64 = arrayBufferToBase64(buf);
			const chat = await this.gateway.chatTranscribeAudio(
				workerR.profile,
				workerR.model,
				b64,
				"wav",
			);
			if (!chat.ok) {
				lines.push({
					step: "测试 B · 对话模型听音频",
					ok: false,
					detail: `失败：${chat.error}`,
				});
			} else if (isNoAudioReply(chat.content) || isBogus(chat.content)) {
				lines.push({
					step: "测试 B · 对话模型听音频",
					ok: false,
					detail: `接口有响应，但模型表示没收到音频：${chat.content.slice(0, 100)}`,
				});
			} else {
				lines.push({
					step: "测试 B · 对话模型听音频",
					ok: true,
					detail: `成功（模型能听）：${chat.content.slice(0, 80)}`,
				});
			}
		} else {
			lines.push({
				step: "测试 B · 对话模型听音频",
				ok: false,
				detail: "跳过（无对话 Provider）",
			});
		}

		const anyOk = lines.some(
			(l) => l.ok && (l.step.startsWith("测试 A") || l.step.startsWith("测试 B")),
		);
		lines.push({
			step: "结论",
			ok: anyOk,
			detail: anyOk
				? "至少一种转写方式可用。若仍失败，请看失败步骤详情。"
				: "当前配置下无法自动转写。录音保存/播放正常，但服务商未提供可用 STT 或听音频能力。请另配支持 whisper-1 的 /v1/audio/transcriptions。",
		});

		void settings;
		void this.app;
		return lines;
	}
}

function maskUrl(u: string): string {
	try {
		const x = new URL(u.includes("://") ? u : `https://${u}`);
		return `${x.origin}${x.pathname.replace(/\/+$/, "") || ""}`;
	} catch {
		return u.slice(0, 40);
	}
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
	].some((re) => re.test(text));
}
