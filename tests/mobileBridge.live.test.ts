import { describe, expect, it, afterAll } from "vitest";
import * as http from "http";
import { MobileBridgeServer } from "../src/bridge/mobileBridgeServer";
import { buildMobilePageHtml } from "../src/bridge/mobilePageHtml";
import { createDefaultSettings } from "../src/domain/settingsDefaults";
import type { NotebookMeta } from "../src/domain/types";

function nb(id: string, name: string): NotebookMeta {
	return {
		type: "ai-notebook",
		notebook_id: id,
		name,
		template_id: "blank",
		current_blueprint: 1,
		created: "",
		updated: "",
		provider_profile_id: null,
		model_overrides: {},
		folderName: name,
	};
}

function httpGet(
	port: number,
	path: string,
	headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		http
			.get(
				{ hostname: "127.0.0.1", port, path, headers: headers || {} },
				(res) => {
					let b = "";
					res.on("data", (c) => (b += c));
					res.on("end", () =>
						resolve({ status: res.statusCode || 0, body: b }),
					);
				},
			)
			.on("error", reject);
	});
}

function httpPost(
	port: number,
	path: string,
	body: Record<string, unknown>,
	headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
					...(headers || {}),
				},
			},
			(res) => {
				let responseBody = "";
				res.on("data", (chunk) => (responseBody += chunk));
				res.on("end", () =>
					resolve({ status: res.statusCode || 0, body: responseBody }),
				);
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

describe("mobile bridge live connectivity", () => {
	const port = 27888;
	const token = "live-test-token-xyz";
	let settings = {
		...createDefaultSettings(),
		bridge: {
			...createDefaultSettings().bridge,
			token,
			port,
		},
	};

	let inboxWrites = 0;
	let cabinetImports = 0;
	const server = new MobileBridgeServer({
		getSettings: () => settings,
		saveSettings: async (s) => {
			settings = s as typeof settings;
		},
		resolveTargetNotebook: async () => nb("nb1", "本A"),
		listNotebooks: async () => [nb("nb1", "本A"), nb("nb2", "本B")],
		resolveNotebookById: async (id) =>
			id === "nb2" ? nb("nb2", "本B") : nb("nb1", "本A"),
		resolveVoice: () => null,
		inbox: {
			dumpRaw: async () => {
				inboxWrites++;
				return "inbox.md";
			},
			dumpBinary: async () => {
				inboxWrites++;
				return { notePath: "inbox.md", filePath: "AI Inbox/files/x.bin" };
			},
			saveVoiceRaw: async () => undefined,
		} as never,
		organize: {
			captureStructured: async () => ({
				item: {
					path: "p.md",
					body: "b",
					frontmatter: {
						title: "t",
						item_id: "i",
						cabinet_refs: [],
					},
				},
				organized: false,
			}),
		} as never,
		voice: { transcribe: async () => ({ ok: false, error: "x" }) } as never,
		items: {
			createItem: async () => ({
				path: "p.md",
				body: "",
				frontmatter: { title: "t", item_id: "i", cabinet_refs: [] },
			}),
			updateItem: async (i: unknown) => i,
			findById: async () => null,
			appendToItem: async (i: any) => i,
		} as never,
		cabinet: {
			importBinary: async () => {
				cabinetImports++;
				return {
					id: "c",
					vaultPath: "a/x",
					item_id: null,
				};
			},
		} as never,
		attachments: {
			importBinary: async () => {
				cabinetImports++;
				return {
					id: "att",
					vaultPath: "a/x",
					displayName: "paper.pdf",
					mime: "application/pdf",
					item_id: "i",
				};
			},
		} as never,
	});

	afterAll(async () => {
		await server.stop();
	});

	it("page JS parses and status/ping work with token", async () => {
		// unit: generated page script must parse (regression for btnDelSel bug)
		const pageHtml = buildMobilePageHtml({
			token,
			notebookName: "本A",
			defaultNotebookId: "nb1",
			notebooks: [
				{ id: "nb1", name: "本A" },
				{ id: "nb2", name: "本B" },
			],
		});
		const script = pageHtml.match(/<script>([\s\S]*)<\/script>/)?.[1] || "";
		expect(script.length).toBeGreaterThan(1000);
		// must not have the broken binding that killed all JS
		expect(script).not.toContain('getElementById("btnDelSel".onclick');
		expect(script).toContain('getElementById("btnDelSel").onclick');
		// must boot to connected when token present
		expect(script).toContain("已连接电脑");
		expect(() => new Function(script)).not.toThrow();

		await server.start();
		const page = await httpGet(port, `/?t=${token}`);
		expect(page.status).toBe(200);
		expect(page.body).toContain(token);
		expect(page.body).toContain("本A");
		expect(page.body).toContain("本B");

		const status = await httpGet(port, `/api/status?t=${token}`);
		expect(status.status).toBe(200);
		const sj = JSON.parse(status.body);
		expect(sj.ok).toBe(true);
		expect(sj.notebooks?.length).toBe(2);

		const ping = await httpGet(port, `/api/ping?t=${token}`);
		expect(ping.status).toBe(200);
		expect(JSON.parse(ping.body).pong).toBe(true);

		const statusHdr = await httpGet(port, `/api/status`, {
			"X-Bridge-Token": token,
		});
		expect(statusHdr.status).toBe(200);

		const noTok = await httpGet(port, `/api/status`);
		expect(noTok.status).toBe(401);
	});

	it("stores file inbox submissions as notes without importing binaries", async () => {
		await server.start();
		const beforeInbox = inboxWrites;
		const beforeImports = cabinetImports;
		const response = await httpPost(
			port,
			`/api/file?t=${token}`,
			{
				fileBase64: Buffer.from("pdf-bytes").toString("base64"),
				fileName: "paper.pdf",
				mimeType: "application/pdf",
				organize: false,
				notebook_id: "nb1",
			},
		);
		expect(response.status).toBe(200);
		expect(JSON.parse(response.body)).toMatchObject({
			ok: true,
			inboxOnly: true,
			organized: false,
		});
		expect(inboxWrites).toBe(beforeInbox + 1);
		expect(cabinetImports).toBe(beforeImports);
	});
});
