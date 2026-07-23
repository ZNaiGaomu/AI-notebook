import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import {
	extractProviderList,
	mergeImportedProviders,
	parseImportJson,
} from "../src/domain/providerImport";

describe("mergeImportedProviders", () => {
	it("adds providers and uses host when name empty", () => {
		const base = createDefaultSettings();
		const result = mergeImportedProviders(base, {
			providers: [
				{
					baseUrl: "https://apiport.cc.cd/v1",
					apiKey: "sk-test",
					models: ["whisper-1"],
				},
			],
		});
		expect(result.added).toBe(1);
		expect(result.settings.providers).toHaveLength(1);
		expect(result.settings.providers[0]!.name).not.toBe("");
		expect(result.settings.providers[0]!.defaultModel).toBe("whisper-1");
		expect(result.settings.providers[0]!.models[0]).toBe("whisper-1");
	});

	it("merges without wiping existing apiKey when import key empty", () => {
		const base = {
			...createDefaultSettings(),
			providers: [
				{
					id: "p1",
					name: "Grok",
					baseUrl: "https://a.com/v1",
					apiKey: "sk-keep",
					models: ["g"],
					defaultModel: "g",
				},
			],
			defaultProviderId: "p1",
		};
		const result = mergeImportedProviders(base, {
			providers: [
				{
					id: "p1",
					name: "Grok改名",
					baseUrl: "https://a.com/v1",
					apiKey: "",
					models: ["g", "h"],
				},
				{
					name: "语音转写",
					baseUrl: "https://apiport.cc.cd/v1",
					apiKey: "sk-voice",
					models: ["whisper-1"],
				},
			],
		});
		expect(result.total).toBe(2);
		const grok = result.settings.providers.find((p) => p.id === "p1");
		expect(grok?.apiKey).toBe("sk-keep");
		expect(grok?.name).toBe("Grok改名");
		expect(
			result.settings.providers.some((p) => p.name === "语音转写"),
		).toBe(true);
	});

	it("accepts single provider object and array root", () => {
		const base = createDefaultSettings();
		const one = mergeImportedProviders(base, {
			name: "king",
			baseUrl: "https://api.tokenskingdom.com/v1",
			apiKey: "sk-x",
			models: ["gpt-4o"],
		});
		expect(one.added).toBe(1);
		expect(one.settings.providers[0]!.defaultModel).toBe("gpt-4o");

		const arr = mergeImportedProviders(base, [
			{ baseUrl: "https://b.com/v1", apiKey: "k", models: ["m1"] },
		]);
		expect(arr.added).toBe(1);
	});

	it("warns when nothing recognized", () => {
		const base = createDefaultSettings();
		const r = mergeImportedProviders(base, { foo: 1 });
		expect(r.added).toBe(0);
		expect(r.warning).toBeTruthy();
	});

	it("parseImportJson repairs trailing commas", () => {
		const v = parseImportJson(`{ "providers": [ { "name": "a", "baseUrl": "https://x/v1", }, ], }`);
		expect(extractProviderList(v).length).toBe(1);
	});
});
