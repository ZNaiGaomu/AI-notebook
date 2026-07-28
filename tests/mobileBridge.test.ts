import { describe, expect, it } from "vitest";
import { MobileBridgeServer } from "../src/bridge/mobileBridgeServer";
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

describe("tailscale virtual LAN links", () => {
	it("separates Tailscale 100.x links from ordinary LAN links", () => {
		const status = MobileBridgeServer.buildStatusFromAddresses({
			running: true,
			port: 27124,
			token: "secret99",
			addresses: ["127.0.0.1", "192.168.1.20", "100.81.234.60"],
		});

		expect(status.urls).toEqual([
			"http://127.0.0.1:27124/?t=secret99",
			"http://192.168.1.20:27124/?t=secret99",
		]);
		expect(status.tailscaleUrls).toEqual([
			"http://100.81.234.60:27124/?t=secret99",
		]);
	});

	it("keeps Tailscale disabled when there is no 100.x address", () => {
		const status = MobileBridgeServer.buildStatusFromAddresses({
			running: true,
			port: 27124,
			token: "secret99",
			addresses: ["127.0.0.1", "10.0.0.8", "192.168.1.20"],
		});

		expect(status.tailscaleUrls).toEqual([]);
		expect(status.urls).toContain("http://10.0.0.8:27124/?t=secret99");
		expect(status.urls).toContain("http://192.168.1.20:27124/?t=secret99");
	});

	it("supports Tailscale IPv6 addresses with bracketed URLs", () => {
		const status = MobileBridgeServer.buildStatusFromAddresses({
			running: true,
			port: 27124,
			token: "secret99",
			addresses: ["fd7a:115c:a1e0:abcd::1234", "fe80::1"],
		});

		expect(status.tailscaleUrls).toEqual([
			"http://[fd7a:115c:a1e0:abcd::1234]:27124/?t=secret99",
		]);
		expect(status.urls).toEqual(["http://[fe80::1]:27124/?t=secret99"]);
	});

	it("deduplicates addresses and URL-encodes bridge tokens", () => {
		const status = MobileBridgeServer.buildStatusFromAddresses({
			running: true,
			port: 27124,
			token: "a b+c?",
			addresses: ["100.81.234.60", "100.81.234.60"],
		});

		expect(status.tailscaleUrls).toEqual([
			"http://100.81.234.60:27124/?t=a%20b%2Bc%3F",
		]);
	});
});
