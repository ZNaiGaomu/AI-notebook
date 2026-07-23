import { describe, expect, it } from "vitest";
import { buildMobilePageHtml } from "../src/bridge/mobilePageHtml";
import { createDefaultSettings, normalizeSettings } from "../src/domain/settingsDefaults";

describe("mobile bridge page + settings", () => {
	it("renders page with token and notebook name", () => {
		const html = buildMobilePageHtml({
			token: "abc123token",
			notebookName: "文献本",
			defaultNotebookId: "nb1",
			notebooks: [
				{ id: "nb1", name: "文献本" },
				{ id: "nb2", name: "空白本-2" },
			],
		});
		expect(html).toContain("AI 速记");
		expect(html).toContain("文献本");
		expect(html).toContain("空白本-2");
		expect(html).toContain("abc123token");
		expect(html).toContain("/api/text");
		expect(html).toContain("/api/voice");
		expect(html).toContain("待发送");
		expect(html).toContain("垃圾箱");
		expect(html).toContain("indexedDB");
	});

	it("normalizes bridge defaults", () => {
		const s = normalizeSettings({});
		expect(s.bridge.port).toBe(27124);
		expect(s.bridge.enabled).toBe(true);
		expect(s.bridge.autoOrganize).toBe(true);
		expect(s.bridge.preferPublicTunnel).toBe(true);
		const merged = normalizeSettings({
			bridge: {
				port: 3000,
				token: "x",
				autoStart: true,
				publicBaseUrl: "https://abc.trycloudflare.com/",
			},
		});
		expect(merged.bridge.port).toBe(3000);
		expect(merged.bridge.token).toBe("x");
		expect(merged.bridge.autoStart).toBe(true);
		expect(merged.bridge.publicBaseUrl).toBe(
			"https://abc.trycloudflare.com",
		);
		// keep other defaults
		expect(createDefaultSettings().paths.inboxRoot).toBe("AI Inbox");
	});
});

describe("withToken helper shape", () => {
	it("appends token query on public base", async () => {
		const { withToken } = await import("../src/bridge/publicTunnel");
		const u = withToken("https://demo.trycloudflare.com", "secret99");
		expect(u).toContain("https://demo.trycloudflare.com");
		expect(u).toContain("t=secret99");
	});
});
