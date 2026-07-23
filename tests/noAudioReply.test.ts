import { describe, expect, it } from "vitest";
import { isNoAudioReply } from "../src/infra/aiGateway";

describe("isNoAudioReply", () => {
	it("detects Chinese no-audio replies", () => {
		expect(
			isNoAudioReply(
				"无法转写：当前消息中未提供任何音频文件或音频内容。",
			),
		).toBe(true);
		expect(isNoAudioReply("NO_AUDIO")).toBe(true);
	});

	it("allows real transcript", () => {
		expect(isNoAudioReply("你好，我今天中午吃包子")).toBe(false);
	});
});
