import { describe, expect, it, vi, afterEach } from "vitest";
import {
	AiGateway,
	parseModelsResponse,
} from "../src/infra/aiGateway";
import type { ProviderProfile } from "../src/domain/types";

const profile: ProviderProfile = {
	id: "p",
	name: "t",
	baseUrl: "https://api.example.com/v1",
	apiKey: "sk-test",
	models: [],
	defaultModel: "",
};

describe("parseModelsResponse", () => {
	it("parses OpenAI data[].id", () => {
		const models = parseModelsResponse({
			data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "gpt-4o" }],
		});
		expect(models).toEqual(["gpt-4o", "gpt-4o-mini"]);
	});

	it("parses string arrays and alternate keys", () => {
		expect(parseModelsResponse({ data: ["a", "b"] })).toEqual(["a", "b"]);
		expect(
			parseModelsResponse({ models: [{ name: "x" }, { model: "y" }] }),
		).toEqual(["x", "y"]);
	});
});

describe("AiGateway.listModels", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fetches and returns model ids", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				text: async () =>
					JSON.stringify({
						data: [{ id: "grok-2" }, { id: "grok-3" }],
					}),
			})),
		);
		const gw = new AiGateway();
		const r = await gw.listModels(profile);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.models).toEqual(["grok-2", "grok-3"]);
	});

	it("surfaces API errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 401,
				text: async () =>
					JSON.stringify({ error: { message: "bad key" } }),
			})),
		);
		const gw = new AiGateway();
		const r = await gw.listModels(profile);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/401|bad key/);
	});
});
