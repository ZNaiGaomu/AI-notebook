import { describe, expect, it, vi } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import { buildTemplateBlueprint } from "../src/domain/templates";
import type { ProviderProfile } from "../src/domain/types";
import { MemoryVault } from "../src/infra/memoryVault";
import {
	FeatureOrchestrator,
	type ChatGateway,
} from "../src/services/featureOrchestrator";
import { NotebookService } from "../src/services/notebookService";
import { VersionService } from "../src/services/versionService";

function makeProvider(): ProviderProfile {
	return {
		id: "p1",
		name: "test",
		baseUrl: "https://api.example.com/v1",
		apiKey: "sk-test",
		models: ["gpt-test"],
		defaultModel: "gpt-test",
	};
}

describe("FeatureOrchestrator", () => {
	it("proposes blueprint from AI JSON and applies after confirm path", async () => {
		const vault = new MemoryVault();
		const settings = {
			...createDefaultSettings(),
			providers: [makeProvider()],
			defaultProviderId: "p1",
		};
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "本",
			templateId: "blank",
		});
		const current = buildTemplateBlueprint("blank", "本");

		const nextBlueprint = {
			...current,
			entityTypes: current.entityTypes.map((e) => ({
				...e,
				fields: [
					...e.fields,
					{
						id: "status",
						label: "状态",
						type: "select",
						options: ["open", "done"],
						showInList: true,
					},
				],
			})),
		};

		const gateway: ChatGateway = {
			chat: vi.fn(async () => ({
				ok: true as const,
				content: JSON.stringify({
					changeSummary: "增加状态字段",
					blueprint: nextBlueprint,
				}),
				raw: {},
			})),
		};

		const orch = new FeatureOrchestrator(
			gateway,
			versions,
			() => settings,
			() => ({ profile: makeProvider(), model: "gpt-test" }),
		);

		const result = await orch.propose(meta.folderName, "加一个状态字段 open/done");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.changeSummary).toContain("状态");
		expect(
			result.plan.blueprint.entityTypes[0]?.fields.some((f) => f.id === "status"),
		).toBe(true);
		expect(result.plan.diff.some((d) => d.kind === "add")).toBe(true);

		const applied = await orch.apply(
			meta.folderName,
			meta.notebook_id,
			result.plan,
			"加一个状态字段 open/done",
		);
		expect(applied.version).toBe(2);
		const { blueprint } = await versions.loadCurrentBlueprint(meta.folderName);
		expect(blueprint.entityTypes[0]?.fields.some((f) => f.id === "status")).toBe(
			true,
		);
	});

	it("retries when first response is invalid then succeeds", async () => {
		const vault = new MemoryVault();
		const settings = {
			...createDefaultSettings(),
			providers: [makeProvider()],
			defaultProviderId: "p1",
		};
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "本2",
			templateId: "idea",
		});
		const current = (await versions.loadCurrentBlueprint(meta.folderName))
			.blueprint;

		let calls = 0;
		const gateway: ChatGateway = {
			chat: vi.fn(async () => {
				calls++;
				if (calls === 1) {
					return {
						ok: true as const,
						content: "not json at all",
						raw: {},
					};
				}
				return {
					ok: true as const,
					content:
						"```json\n" +
						JSON.stringify({
							changeSummary: "ok",
							blueprint: current,
						}) +
						"\n```",
					raw: {},
				};
			}),
		};

		const orch = new FeatureOrchestrator(
			gateway,
			versions,
			() => settings,
			() => ({ profile: makeProvider(), model: "gpt-test" }),
		);
		const result = await orch.propose(meta.folderName, "微调描述即可");
		expect(result.ok).toBe(true);
		expect(calls).toBe(2);
	});

	it("fails clearly without provider", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const meta = await notebooks.createNotebook({
			name: "本3",
			templateId: "blank",
		});
		const gateway: ChatGateway = {
			chat: vi.fn(),
		};
		const orch = new FeatureOrchestrator(
			gateway,
			versions,
			() => settings,
			() => null,
		);
		const result = await orch.propose(meta.folderName, "加字段");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/Provider/);
	});
});
