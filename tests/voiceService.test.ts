import { describe, expect, it, vi, afterEach } from "vitest";
import { VoiceService } from "../src/services/voiceService";
import type { ProviderProfile } from "../src/domain/types";

const profile: ProviderProfile = {
	id: "p",
	name: "t",
	baseUrl: "https://api.example.com/v1",
	apiKey: "sk",
	models: ["whisper-1"],
	defaultModel: "whisper-1",
};

function bigBlob(): Blob {
	// > 100 bytes so size check passes
	return new Blob([new Uint8Array(200)], { type: "audio/wav" });
}

describe("VoiceService", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("parses transcription response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ text: "你好世界" }),
			})),
		);
		const voice = new VoiceService();
		const result = await voice.transcribe(
			profile,
			"whisper-1",
			bigBlob(),
			"audio.wav",
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text).toBe("你好世界");
	});

	it("surfaces http errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 401,
				text: async () =>
					JSON.stringify({ error: { message: "unauthorized" } }),
			})),
		);
		const voice = new VoiceService();
		const result = await voice.transcribe(
			profile,
			"whisper-1",
			bigBlob(),
			"audio.wav",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/401|unauthorized/);
	});

	it("rejects empty audio", async () => {
		const voice = new VoiceService();
		const result = await voice.transcribe(
			profile,
			"whisper-1",
			new Blob(["x"]),
			"audio.wav",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/过短|空/);
	});
});
