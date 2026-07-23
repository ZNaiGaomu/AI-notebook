import { describe, expect, it, vi } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import type { ProviderProfile } from "../src/domain/types";
import { MemoryVault } from "../src/infra/memoryVault";
import type { AiGateway } from "../src/infra/aiGateway";
import { VoicePipeline } from "../src/services/voicePipeline";
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
		} as unknown as AiGateway;

		const pipe = new VoicePipeline(
			vault,
			voice,
			gateway,
			() => settings,
			() => ({ profile, model: "whisper-1" }),
		);

		const blob = new Blob([new Uint8Array(400)], { type: "audio/wav" });
		const r = await pipe.process(meta, blob, "audio.wav");
		expect(r.ok).toBe(true);
		expect(r.method).toBe("whisper");
		expect(r.transcript).toBe("你好世界");
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
		} as unknown as AiGateway;

		const pipe = new VoicePipeline(
			vault,
			voice,
			gateway,
			() => settings,
			() => ({ profile, model: "grok" }),
		);

		const blob = new Blob([new Uint8Array(400)], { type: "audio/wav" });
		const r = await pipe.process(meta, blob, "audio.wav");
		expect(r.ok).toBe(true);
		expect(r.method).toBe("chat-audio");
		expect(r.transcript).toContain("听出来");
		expect(r.vaultPath).toBeTruthy();
	});
});
