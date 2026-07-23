import { describe, expect, it, vi } from "vitest";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import type { ProviderProfile } from "../src/domain/types";
import { MemoryVault } from "../src/infra/memoryVault";
import { InboxService } from "../src/services/inboxService";
import { ItemService } from "../src/services/itemService";
import { NotebookService } from "../src/services/notebookService";
import {
	OrganizeService,
	type ChatGateway,
} from "../src/services/organizeService";
import { VersionService } from "../src/services/versionService";

const provider: ProviderProfile = {
	id: "p1",
	name: "t",
	baseUrl: "https://api.example.com/v1",
	apiKey: "sk",
	models: ["m"],
	defaultModel: "m",
};

describe("inbox + organize", () => {
	it("dumps pending, AI organizes into notebook, archives", async () => {
		const vault = new MemoryVault();
		const settings = {
			...createDefaultSettings(),
			providers: [provider],
			defaultProviderId: "p1",
			inbox: {
				archiveAfterOrganize: true,
				autoOrganizeVoice: true,
				defaultNotebookId: null,
			},
		};
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);

		const gateway: ChatGateway = {
			chat: vi.fn(async () => ({
				ok: true as const,
				content: JSON.stringify({
					title: "整理后的标题",
					summary: "一句话摘要",
					tags: ["手机"],
					fields: { status: "to-read", url: "https://x.com" },
					body: "## 要点\n- a\n- b",
				}),
				raw: {},
			})),
		};

		const organize = new OrganizeService(
			gateway,
			versions,
			items,
			() => settings,
			() => ({ profile: provider, model: "m" }),
		);
		const inbox = new InboxService(
			vault,
			notebooks,
			organize,
			() => settings,
		);

		const meta = await notebooks.createNotebook({
			name: "文献",
			templateId: "literature",
		});
		// route inbox to this notebook via last id simulation
		settings.ui = { lastNotebookId: meta.notebook_id };

		const path = await inbox.dumpRaw({
			text: "乱七八糟 https://x.com 明天要读 论文xxx",
			source: "mobile",
		});
		expect(path).toContain("AI Inbox/pending");

		const pending = await inbox.listPending();
		expect(pending.length).toBe(1);

		const result = await inbox.processOne(path, {
			notebook: meta,
			useAi: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.organized).toBe(true);

		const listed = await items.listItems(meta);
		expect(listed.length).toBe(1);
		expect(listed[0]!.frontmatter.title).toBe("整理后的标题");
		expect(listed[0]!.body).toContain("要点");

		// archived out of pending
		expect(await inbox.listPending()).toHaveLength(0);
		expect(
			vault.dumpPaths().some((p) => p.includes("processed")),
		).toBe(true);
	});

	it("captureStructured falls back when AI fails", async () => {
		const vault = new MemoryVault();
		const settings = createDefaultSettings();
		const versions = new VersionService(vault, () => settings);
		const notebooks = new NotebookService(vault, versions, () => settings);
		const items = new ItemService(vault, versions, () => settings);
		const gateway: ChatGateway = {
			chat: vi.fn(async () => ({
				ok: false as const,
				error: "network",
			})),
		};
		const organize = new OrganizeService(
			gateway,
			versions,
			items,
			() => settings,
			() => ({ profile: provider, model: "m" }),
		);
		const meta = await notebooks.createNotebook({
			name: "x",
			templateId: "blank",
		});
		const cap = await organize.captureStructured(meta, "原始乱记", {
			useAi: true,
			source: "paste",
		});
		expect(cap.organized).toBe(false);
		expect(cap.item.body).toContain("原始乱记");
		expect(cap.error).toMatch(/network/);
	});
});
