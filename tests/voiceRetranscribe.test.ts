import { describe, expect, it } from "vitest";
import {
	applyRetranscribeToBody,
	buildVoiceBlock,
	extractAudioPathFromRaw,
	voiceBlockEnd,
	voiceBlockStart,
} from "../src/services/voiceRetranscribe";

describe("voice retranscribe writeback", () => {
	it("replaces only the target marked voice block", () => {
		const a = "attachments/ai-notebook/n/items/1/voice/a.m4a";
		const b = "attachments/ai-notebook/n/items/1/voice/b.m4a";
		const body = [
			"# user text",
			buildVoiceBlock({
				vaultPath: a,
				embedMarkdown: `![[${a}]]`,
				transcript: "old a",
				polished: "polished a",
			}),
			"## attachment",
			"![[image.png]]",
			buildVoiceBlock({
				vaultPath: b,
				embedMarkdown: `![[${b}]]`,
				transcript: "old b",
				polished: "",
			}),
		].join("\n\n");

		const next = applyRetranscribeToBody(body, {
			vaultPath: b,
			transcript: "new b",
			polished: "polished new b",
			warning: "",
		});

		expect(next).toContain("old a");
		expect(next).toContain("polished a");
		expect(next).toContain("![[image.png]]");
		expect(next).not.toContain("old b");
		expect(next).toContain("new b");
		expect(next).toContain("polished new b");
		expect(next.match(/ai-notebook-voice:start/g)).toHaveLength(2);
	});

	it("is idempotent for the same marked voice path", () => {
		const path = "attachments/n/items/1/voice/a.m4a";
		const body = buildVoiceBlock({
			vaultPath: path,
			embedMarkdown: `![[${path}]]`,
			transcript: "first",
			polished: "first polished",
		});
		const once = applyRetranscribeToBody(body, {
			vaultPath: path,
			transcript: "second",
			polished: "second polished",
			warning: "",
		});
		const twice = applyRetranscribeToBody(once, {
			vaultPath: path,
			transcript: "second",
			polished: "second polished",
			warning: "",
		});
		expect(twice).toBe(once);
		expect(twice.match(/ai-notebook-voice:start/g)).toHaveLength(1);
		expect(twice.match(/second polished/g)).toHaveLength(1);
	});

	it("upgrades a legacy audio block without changing earlier content", () => {
		const path = "attachments/n/items/1/voice/legacy.m4a";
		const body = [
			"## notes",
			"keep this",
			"## 录音",
			`![[${path}]]`,
			`> 录音文件：\`${path}\``,
			"## 语音转写",
			"old transcript",
		].join("\n\n");

		const next = applyRetranscribeToBody(body, {
			vaultPath: path,
			transcript: "new transcript",
			polished: "new polished",
			warning: "",
		});

		expect(next).toContain("keep this");
		expect(next).toContain(voiceBlockStart(path));
		expect(next).toContain(voiceBlockEnd(path));
		expect(next).not.toContain("old transcript");
		expect(next).toContain("new transcript");
		expect(next).toContain("new polished");
	});

	it("extracts decoded attachment paths that contain spaces", () => {
		const path =
			"attachments/ai-notebook/My Notebook/items/My Item/voice/test audio.m4a";
		const encoded = `app://local/C:/Vault/${encodeURI(path)}`;
		expect(extractAudioPathFromRaw(encoded)).toBe(path);
		expect(extractAudioPathFromRaw(path)).toBe(path);
	});

	it("does not duplicate the audio when legacy target cannot be found", () => {
		const path = "attachments/n/items/1/voice/missing.m4a";
		const body = "user content only";
		const next = applyRetranscribeToBody(body, {
			vaultPath: path,
			transcript: "new",
			polished: "",
			warning: "",
		});
		expect(next).toBe(body);
	});
});
