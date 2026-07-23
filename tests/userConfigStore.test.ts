import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import type { UserDurableConfig } from "../src/infra/userConfigStore";

// Test merge/extract pure logic without Obsidian App
function extractFromSettings(settings: ReturnType<typeof createDefaultSettings>): UserDurableConfig {
	return {
		schemaVersion: 1,
		providers: settings.providers,
		defaultProviderId: settings.defaultProviderId,
		purposeRouting: settings.purposeRouting,
	};
}

function mergeIntoSettings(
	settings: ReturnType<typeof createDefaultSettings>,
	durable: UserDurableConfig,
) {
	return {
		...settings,
		providers: durable.providers,
		defaultProviderId: durable.defaultProviderId,
		purposeRouting: durable.purposeRouting,
	};
}

describe("user durable config", () => {
	it("survives plugin settings wipe of providers", () => {
		const withProviders = {
			...createDefaultSettings(),
			providers: [
				{
					id: "p1",
					name: "家里中转",
					baseUrl: "https://x.com/v1",
					apiKey: "sk-secret",
					models: ["a", "b"],
					defaultModel: "a",
				},
			],
			defaultProviderId: "p1",
		};
		const durable = extractFromSettings(withProviders);

		// Simulate new plugin data.json with empty providers after reinstall
		const freshPluginData = createDefaultSettings();
		const restored = mergeIntoSettings(freshPluginData, durable);

		expect(restored.providers).toHaveLength(1);
		expect(restored.providers[0]!.name).toBe("家里中转");
		expect(restored.providers[0]!.apiKey).toBe("sk-secret");
		expect(restored.providers[0]!.models).toEqual(["a", "b"]);
		expect(restored.defaultProviderId).toBe("p1");
		// non-provider settings still from fresh
		expect(restored.paths.notebooksRoot).toBe("AI Notebooks");
	});
});
