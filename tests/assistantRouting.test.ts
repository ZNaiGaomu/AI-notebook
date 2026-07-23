import { describe, expect, it } from "vitest";
import {
	normalizeRouteChain,
	primarySlot,
} from "../src/domain/purposeRouting";
import { createDefaultSettings, normalizeSettings } from "../src/domain/settingsDefaults";
import {
	isVisionCapabilityError,
	looksVisionCapable,
	resolveProvider,
	resolveProviderChain,
} from "../src/services/providerResolver";
import {
	parseAssistantResponse,
	assistantToolSystemAppendix,
	buildMediaEmbedMarkdown,
	maybeInferEmbedActions,
} from "../src/services/assistantActions";

describe("purpose routing chains", () => {
	it("normalizes legacy single route object", () => {
		const chain = normalizeRouteChain({
			providerId: "p1",
			model: "m1",
		});
		expect(chain).toHaveLength(3);
		expect(chain[0]).toEqual({ providerId: "p1", model: "m1" });
		expect(chain[1]).toEqual({ providerId: null, model: null });
		expect(primarySlot(chain).providerId).toBe("p1");
	});

	it("normalizes array and pads to 3", () => {
		const chain = normalizeRouteChain([
			{ providerId: "a", model: "x" },
			{ providerId: "b", model: null },
		]);
		expect(chain[0]!.providerId).toBe("a");
		expect(chain[1]!.providerId).toBe("b");
		expect(chain[2]!.providerId).toBeNull();
	});

	it("normalizeSettings upgrades legacy purposeRouting", () => {
		const s = normalizeSettings({
			purposeRouting: {
				planner: { providerId: "px", model: "my" },
				worker: { providerId: null, model: null },
				voice: { providerId: "v", model: "whisper-1" },
			},
		});
		expect(Array.isArray(s.purposeRouting.planner)).toBe(true);
		expect(s.purposeRouting.planner[0]).toEqual({
			providerId: "px",
			model: "my",
		});
		expect(s.purposeRouting.voice[0]!.model).toBe("whisper-1");
	});

	it("resolveProviderChain follows order and dedupes", () => {
		const settings = {
			...createDefaultSettings(),
			providers: [
				{
					id: "p1",
					name: "A",
					baseUrl: "https://a.example/v1",
					apiKey: "k",
					models: ["text-only", "gpt-4o"],
					defaultModel: "text-only",
				},
				{
					id: "p2",
					name: "B",
					baseUrl: "https://b.example/v1",
					apiKey: "k",
					models: ["gpt-4o-mini"],
					defaultModel: "gpt-4o-mini",
				},
			],
			defaultProviderId: "p1",
			purposeRouting: {
				planner: normalizeRouteChain([]),
				worker: normalizeRouteChain([
					{ providerId: "p1", model: "text-only" },
					{ providerId: "p2", model: "gpt-4o-mini" },
				]),
				voice: normalizeRouteChain([]),
			},
		};
		const first = resolveProvider(settings, "worker");
		expect(first?.profile.id).toBe("p1");
		expect(first?.model).toBe("text-only");

		const chain = resolveProviderChain(settings, "worker", null, {
			vision: true,
		});
		expect(chain.length).toBeGreaterThanOrEqual(1);
		expect(chain.some((c) => looksVisionCapable(c.model))).toBe(true);
	});

	it("vision heuristics", () => {
		expect(looksVisionCapable("gpt-4o")).toBe(true);
		expect(looksVisionCapable("whisper-1")).toBe(false);
		expect(isVisionCapabilityError("model does not support image input")).toBe(
			true,
		);
	});
});

describe("assistant response parse", () => {
	it("parses fenced actions envelope", () => {
		const raw = `好的，我来改正文。

\`\`\`json
{
  "reply": "已更新正文",
  "actions": [
    { "type": "update_item", "body": "新的正文内容" }
  ]
}
\`\`\``;
		const p = parseAssistantResponse(raw);
		expect(p.reply).toContain("已更新正文");
		expect(p.actions).toHaveLength(1);
		expect(p.actions[0]).toMatchObject({
			type: "update_item",
			body: "新的正文内容",
		});
	});

	it("parses embed_in_body action", () => {
		const raw = `\`\`\`json
{
  "reply": "已嵌入",
  "actions": [
    { "type": "embed_in_body", "file_ref": "a.png", "caption": "一只猫", "placement": "append" }
  ]
}
\`\`\``;
		const p = parseAssistantResponse(raw);
		expect(p.actions[0]).toMatchObject({
			type: "embed_in_body",
			file_ref: "a.png",
			caption: "一只猫",
		});
	});

	it("parses action array fence", () => {
		const raw = `done
\`\`\`json
[{ "type": "create_item", "title": "新条目", "body": "hi" }]
\`\`\``;
		const p = parseAssistantResponse(raw);
		expect(p.actions[0]).toMatchObject({
			type: "create_item",
			title: "新条目",
		});
	});

	it("no actions for plain text", () => {
		const p = parseAssistantResponse("只是普通回答，没有写入。");
		expect(p.actions).toHaveLength(0);
		expect(p.reply).toContain("普通回答");
	});

	it("system appendix lists pending files and embed rules", () => {
		const s = assistantToolSystemAppendix([
			{
				id: "f1",
				name: "a.png",
				mime: "image/png",
				size: 10,
				data: new ArrayBuffer(10),
				kind: "image",
			},
		]);
		expect(s).toContain("a.png");
		expect(s).toContain("embed_in_body");
		expect(s).toContain("attach_chat_file");
	});

	it("buildMediaEmbedMarkdown uses a single wiki embed (no double image)", () => {
		const img = buildMediaEmbedMarkdown(
			"attachments/ai-notebook/n1/x.png",
			{
				id: "1",
				name: "x.png",
				mime: "image/png",
				size: 1,
				data: new ArrayBuffer(1),
				kind: "image",
			},
			"描述文字",
		);
		expect(img).toContain("![[attachments/ai-notebook/n1/x.png]]");
		expect(img).toContain("描述文字");
		// must NOT also include markdown image for same path
		expect(img).not.toMatch(
			/!\[.*\]\(attachments\/ai-notebook\/n1\/x\.png\)/,
		);
		expect((img.match(/!\[\[/g) || []).length).toBe(1);

		const vid = buildMediaEmbedMarkdown(
			"attachments/ai-notebook/n1/v.mp4",
			{
				id: "2",
				name: "v.mp4",
				mime: "video/mp4",
				size: 1,
				data: new ArrayBuffer(1),
				kind: "video",
			},
		);
		expect(vid).toContain("![[attachments/ai-notebook/n1/v.mp4]]");
		expect(vid).not.toContain("<video");
		expect((vid.match(/!\[\[/g) || []).length).toBe(1);
	});
});

	it("maybeInferEmbedActions synthesizes embeds from user intent", () => {
		const pending = [
			{
				id: "1",
				name: "a.png",
				mime: "image/png",
				size: 1,
				data: new ArrayBuffer(1),
				kind: "image" as const,
			},
		];
		const acts = maybeInferEmbedActions(
			"把图片插入正文并描述",
			[],
			pending,
		);
		expect(acts).toHaveLength(1);
		expect(acts[0]).toMatchObject({ type: "embed_in_body", file_ref: "a.png" });
	});

	it("parses embed_in_body from loose free-text objects", () => {
		const raw = `好的我来处理
{ "type": "embed_in_body", "file_ref": "x.png", "caption": "一只猫" }
完成`;
		const p = parseAssistantResponse(raw);
		expect(p.actions.some((a) => a.type === "embed_in_body")).toBe(true);
	});

