import { describe, expect, it, vi } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import type { ProviderProfile } from "../src/domain/types";
import { MemoryVault } from "../src/infra/memoryVault";
import type { AiGateway } from "../src/infra/aiGateway";
import {
	VoicePipeline,
	ensureEmbedsPreserved,
} from "../src/services/voicePipeline";
import type { VoiceService } from "../src/services/voiceService";
import { NotebookService } from "../src/services/notebookService";
import { VersionService } from "../src/services/versionService";

const profile: ProviderProfile = {
	id: "p1",
	name: "t",
	baseUrl: "https://api.example.com/v1",
	apiKey: "sk",
	models: ["grok"],
	defaultModel: "grok",
};

const profile2: ProviderProfile = {
	id: "p2",
	name: "whisper-host",
	baseUrl: "https://stt.example.com/v1",
	apiKey: "sk2",
	models: ["whisper-1"],
	defaultModel: "whisper-1",
};

describe("VoicePipeline", () => {
	it("saves audio then uses whisper when available", async () => {
		const vault = new MemoryVault();
		const settings = {
			...createDefaultSettings(),
			providers: [profile],
			defaultProviderId: "p1",
		};
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "v",
			templateId: "blank",
		});

		const voice = {
			transcribe: vi.fn(async () => ({
				ok: true as const,
				text: "你好世界",
			})),
		} as unknown as VoiceService;
		const gateway = {
			chatTranscribeAudio: vi.fn(),
			chat: vi.fn(async () => ({ ok: true as const, content: "润色后的文字", raw: {} })),
		} as unknown as AiGateway;

		const pipe = new VoicePipeline(
			vault,
			voice,
			gateway,
			() => settings,
			() => [{ profile, model: "whisper-1", slotIndex: 1 }],
		);

		const blob = new Blob([new Uint8Array(400)], { type: "audio/wav" });
		const r = await pipe.process(meta, blob, "audio.wav");
		expect(r.ok).toBe(true);
		expect(r.method).toBe("whisper");
		expect(r.transcript).toBe("你好世界");
		expect(typeof r.polished).toBe("string");
		expect(r.vaultPath).toBeTruthy();
		expect(r.embedMarkdown).toContain("![[");
		expect(voice.transcribe).toHaveBeenCalled();
		expect(gateway.chatTranscribeAudio).not.toHaveBeenCalled();
	});

	it("falls back to chat audio when whisper fails", async () => {
		const vault = new MemoryVault();
		const settings = {
			...createDefaultSettings(),
			providers: [profile],
			defaultProviderId: "p1",
			voice: {
				...createDefaultSettings().voice,
				allowChatAudioFallback: true,
			},
		};
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "v2",
			templateId: "blank",
		});

		const voice = {
			transcribe: vi.fn(async () => ({
				ok: false as const,
				error: "no channel",
			})),
		} as unknown as VoiceService;
		const gateway = {
			chatTranscribeAudio: vi.fn(async () => ({
				ok: true as const,
				content: "从对话模型听出来的字",
				raw: {},
			})),
			chat: vi.fn(async () => ({ ok: true as const, content: "润色后的文字", raw: {} })),
		} as unknown as AiGateway;

		const pipe = new VoicePipeline(
			vault,
			voice,
			gateway,
			() => settings,
			(purpose) =>
				purpose === "voice"
					? [{ profile, model: "grok", slotIndex: 1 }]
					: [{ profile, model: "grok", slotIndex: 1 }],
		);

		const blob = new Blob([new Uint8Array(400)], { type: "audio/wav" });
		const r = await pipe.process(meta, blob, "audio.wav");
		expect(r.ok).toBe(true);
		expect(r.method).toBe("chat-audio");
		expect(r.transcript).toContain("听出来");
		expect(r.vaultPath).toBeTruthy();
	});

	it("tries next voice slot when first STT fails", async () => {
		const vault = new MemoryVault();
		const settings = {
			...createDefaultSettings(),
			providers: [profile, profile2],
			defaultProviderId: "p1",
		};
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "v3",
			templateId: "blank",
		});

		const voice = {
			transcribe: vi.fn(async (_p: ProviderProfile, model: string) => {
				if (model === "whisper-1") {
					return { ok: true as const, text: "第二槽成功" };
				}
				return { ok: false as const, error: "HTTP 404 no stt" };
			}),
		} as unknown as VoiceService;
		const gateway = {
			chatTranscribeAudio: vi.fn(),
			chat: vi.fn(async () => ({ ok: true as const, content: "润色后的文字", raw: {} })),
		} as unknown as AiGateway;

		const pipe = new VoicePipeline(
			vault,
			voice,
			gateway,
			() => settings,
			(purpose) =>
				purpose === "voice"
					? [
							{ profile, model: "grok", slotIndex: 1 },
							{ profile: profile2, model: "whisper-1", slotIndex: 2 },
						]
					: [],
		);

		const blob = new Blob([new Uint8Array(400)], { type: "audio/wav" });
		const r = await pipe.process(meta, blob, "audio.wav");
		expect(r.ok).toBe(true);
		expect(r.method).toBe("whisper");
		expect(r.transcript).toBe("第二槽成功");
		expect(voice.transcribe).toHaveBeenCalledTimes(2);
	});

	it("always returns embed when save ok even if STT fails", async () => {
		const vault = new MemoryVault();
		const settings = {
			...createDefaultSettings(),
			providers: [profile],
			defaultProviderId: "p1",
		};
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "v4",
			templateId: "blank",
		});

		const voice = {
			transcribe: vi.fn(async () => ({
				ok: false as const,
				error: "HTTP 404",
			})),
		} as unknown as VoiceService;
		const gateway = {
			chatTranscribeAudio: vi.fn(async () => ({
				ok: true as const,
				content: "NO_AUDIO",
				raw: {},
			})),
			chat: vi.fn(async () => ({ ok: false as const, error: "skip" })),
		} as unknown as AiGateway;

		const pipe = new VoicePipeline(
			vault,
			voice,
			gateway,
			() => settings,
			() => [{ profile, model: "grok", slotIndex: 1 }],
		);

		const blob = new Blob([new Uint8Array(400)], { type: "audio/wav" });
		const r = await pipe.process(meta, blob, "audio.wav");
		expect(r.ok).toBe(false);
		expect(r.vaultPath).toBeTruthy();
		expect(r.embedMarkdown).toContain("![[");
		expect(r.embedMarkdown).toContain(r.vaultPath!);
		expect(["model_no_audio", "stt_unavailable"]).toContain(r.errorKind);
		// short error for note, detail separate
		expect(r.error).toBeTruthy();
		expect(r.error!.length).toBeLessThan(200);
	});

	it("ensureEmbedsPreserved re-appends missing audio embed", () => {
		const original =
			"转写文字\n\n![[attachments/ai-notebook/x/voice-a.wav]]\n";
		const rewritten = "> 摘要\n\n整理后的正文，没有音频了";
		const fixed = ensureEmbedsPreserved(original, rewritten);
		expect(fixed).toContain("![[attachments/ai-notebook/x/voice-a.wav]]");
		expect(fixed).toContain("整理后的正文");
	});
});
