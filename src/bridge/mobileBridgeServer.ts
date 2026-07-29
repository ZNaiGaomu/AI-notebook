import * as http from "http";
import * as os from "os";
import type { IncomingMessage, ServerResponse } from "http";
import type {
	AiNotebookSettings,
	NotebookItem,
	NotebookMeta,
	ProviderProfile,
	TemplateId,
} from "../domain/types";
import { createId, shortId } from "../domain/ids";
import type { InboxService } from "../services/inboxService";
import type { OrganizeService } from "../services/organizeService";
import type { VoiceService } from "../services/voiceService";
import type { ItemService } from "../services/itemService";
import type { CabinetService } from "../services/cabinetService";
import { buildMobilePageHtml } from "./mobilePageHtml";

export type BridgeDeps = {
	getSettings: () => AiNotebookSettings;
	saveSettings: (s: AiNotebookSettings) => Promise<void>;
	resolveTargetNotebook: () => Promise<NotebookMeta | null>;
	listNotebooks: () => Promise<NotebookMeta[]>;
	resolveNotebookById: (
		id: string | null | undefined,
	) => Promise<NotebookMeta | null>;
	/** Strict lookup: never falls back to default notebook. */
	findNotebookById?: (id: string) => Promise<NotebookMeta | null>;
	createNotebook?: (input: {
		name: string;
		templateId: TemplateId;
	}) => Promise<NotebookMeta>;
	/** Persist preferred mobile target notebook */
	setDefaultNotebookId?: (id: string | null) => Promise<void>;
	resolveVoice: (
		notebook?: NotebookMeta | null,
	) => { profile: ProviderProfile; model: string } | null;
	inbox: InboxService;
	organize: OrganizeService;
	voice: VoiceService;
	items: ItemService;
	cabinet: CabinetService;
	onNoteWritten?: (info: { title: string; path: string }) => void;
};

export type BridgeStatus = {
	running: boolean;
	port: number;
	/** LAN + localhost links (same Wi‑Fi) */
	urls: string[];
	/** Tailscale virtual LAN links (100.64.0.0/10) */
	tailscaleUrls: string[];
	/** Any-network HTTPS (or http) links via tunnel / manual publicBaseUrl */
	publicUrls: string[];
	token: string;
	publicBaseUrl?: string;
	error?: string;
	tunnelHint?: string;
};
type RecentItem = {
	title: string;
	preview: string;
	path: string;
	organized: boolean;
	at: string;
};

/**
 * Desktop-only LAN HTTP bridge: phone opens a page, posts text/voice back into vault + AI.
 */

export class MobileBridgeServer {

	private server: http.Server | null = null;

	private recent: RecentItem[] = [];

	private lastError: string | undefined;

	constructor(private readonly deps: BridgeDeps) {}
	isRunning(): boolean {
		return this.server != null;
	}
	getStatus(extra?: {
		publicBaseUrl?: string | null;
		tunnelHint?: string;
	}): BridgeStatus {
		const s = this.deps.getSettings();
		const port = s.bridge.port || 27124;
		const token = s.bridge.token || "";
		const base = MobileBridgeServer.buildStatusFromAddresses({
			running: this.isRunning(),
			port,
			token,
			addresses: ["127.0.0.1", ...listLocalAddresses()],
		});
		const publicBase =
			(extra?.publicBaseUrl || s.bridge.publicBaseUrl || "").replace(
				/\/+$/,
				"",
			);
		const publicUrls: string[] = [];
		if (publicBase) {
			publicUrls.push(this.publicUrlWithToken(publicBase, token));
		}
		return {
			...base,
			publicUrls,
			publicBaseUrl: publicBase || undefined,
			error: this.lastError,
			tunnelHint: extra?.tunnelHint,
		};
	}

	static buildStatusFromAddresses(input: {
		running: boolean;
		port: number;
		token: string;
		addresses: string[];
	}): BridgeStatus {
		const q = input.token ? `?t=${encodeURIComponent(input.token)}` : "";
		const unique = [...new Set(input.addresses.filter(Boolean))];
		const tailscaleUrls = unique
			.filter(isTailscaleAddress)
			.map((ip) => httpUrlForAddress(ip, input.port, q));
		const urls = unique
			.filter((ip) => !isTailscaleAddress(ip))
			.map((ip) => httpUrlForAddress(ip, input.port, q));
		return {
			running: input.running,
			port: input.port,
			urls,
			tailscaleUrls,
			publicUrls: [],
			token: input.token,
		};
	}
	publicUrlWithToken(publicBase: string, token: string): string {
		try {
			const base = publicBase.includes("://")
				? publicBase
				: `https://${publicBase}`;
			const u = new URL(base);
			if (token) u.searchParams.set("t", token);
			return `${u.origin}/${u.search}`;
		} catch {
			const q = token ? `?t=${encodeURIComponent(token)}` : "";
			return `${publicBase.replace(/\/+$/, "")}/${q}`;
		}
	}

	async ensureToken(): Promise<string> {
		const s = this.deps.getSettings();
		if (s.bridge.token && s.bridge.token.length >= 8) return s.bridge.token;
		const token = shortId(createId(), 12);
		await this.deps.saveSettings({
			...s,
			bridge: { ...s.bridge, token },
		});
		return token;
	}

	async start(): Promise<BridgeStatus> {
		if (this.server) return this.getStatus();
		const token = await this.ensureToken();
		const s = this.deps.getSettings();
		const port = s.bridge.port || 27124;
		await new Promise<void>((resolve, reject) => {
			const server = http.createServer((req, res) => {
				void this.handle(req, res);
			});
			server.once("error", (err) => {
				this.lastError = err.message;
				this.server = null;
				reject(err);
			});
			server.listen(port, "0.0.0.0", () => {
				this.server = server;
				this.lastError = undefined;
				resolve();
			});
		});
		return this.getStatus();
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}
	listLanUrls(port: number, token: string): string[] {
		return MobileBridgeServer.buildStatusFromAddresses({
			running: this.isRunning(),
			port,
			token,
			addresses: ["127.0.0.1", ...listLocalAddresses()],
		}).urls;
	}

	private authOk(req: IncomingMessage, url: URL): boolean {
		const expected = this.deps.getSettings().bridge.token;
		if (!expected) return false;
		const header = req.headers["x-bridge-token"];
		const fromHeader = Array.isArray(header) ? header[0] : header;
		const fromQuery = url.searchParams.get("t") || "";
		return fromHeader === expected || fromQuery === expected;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const host = req.headers.host || `127.0.0.1`;
			const url = new URL(req.url || "/", `http://${host}`);
			// CORS for phone browsers
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader(
				"Access-Control-Allow-Headers",
				"Content-Type, X-Bridge-Token",
			);
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}
			if (url.pathname === "/" || url.pathname === "/index.html") {
				if (!this.authOk(req, url)) {
					this.json(res, 401, { ok: false, error: "无效令牌，请用电脑生成的完整链接打开" });
					return;
				}
				let notebooks: NotebookMeta[] = [];
				let meta: NotebookMeta | null = null;
				try {
					notebooks = await this.deps.listNotebooks();
				} catch {
					notebooks = [];
				}
				try {
					meta = await this.deps.resolveTargetNotebook();
				} catch {
					meta = null;
				}
				const token =
					this.deps.getSettings().bridge.token ||
					url.searchParams.get("t") ||
					"";
				const html = buildMobilePageHtml({
					token,
					notebookName: meta?.name || "(create a notebook on desktop first)",
					defaultNotebookId: meta?.notebook_id ?? null,
					notebooks: (notebooks || []).map((n) => ({
						id: n.notebook_id,
						name: n.name,
					})),
				});
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(html);
				return;
			}
			if (!this.authOk(req, url)) {
				this.json(res, 401, { ok: false, error: "unauthorized" });
				return;
			}
			if (url.pathname === "/api/ping" && req.method === "GET") {
				this.json(res, 200, { ok: true, pong: true, ts: Date.now() });
				return;
			}
			if (url.pathname === "/api/recent" && req.method === "GET") {
				this.json(res, 200, { ok: true, items: this.recent.slice(0, 20) });
				return;
			}
			if (url.pathname === "/api/status" && req.method === "GET") {
				let meta = null as NotebookMeta | null;
				let notebooks: NotebookMeta[] = [];
				try {
					meta = await this.deps.resolveTargetNotebook();
				} catch {
					meta = null;
				}
				try {
					notebooks = await this.deps.listNotebooks();
				} catch {
					notebooks = [];
				}
				this.json(res, 200, {
					ok: true,
					lan: true,
					notebook: meta?.name ?? null,
					notebookId: meta?.notebook_id ?? null,
					notebooks: (notebooks || []).map((n) => ({
						id: n.notebook_id,
						name: n.name,
					})),
					autoOrganize: this.deps.getSettings().bridge.autoOrganize,
				});
				return;
			}

			if (url.pathname === "/api/notebooks" && req.method === "GET") {
				const notebooks = await this.deps.listNotebooks();
				const meta = await this.deps.resolveTargetNotebook();
				this.json(res, 200, {
					ok: true,
					defaultId: meta?.notebook_id ?? null,
					notebooks: notebooks.map((n) => ({
						id: n.notebook_id,
						name: n.name,
					})),
				});
				return;
			}
			if (url.pathname === "/api/notebook" && req.method === "POST") {
				const body = await readJson(req);
				const id =
					body.notebook_id != null ? String(body.notebook_id).trim() : "";
				const found = id ? await this.deps.resolveNotebookById(id) : null;
				if (!found) {
					this.json(res, 400, { ok: false, error: "notebook not found" });
					return;
				}
				if (this.deps.setDefaultNotebookId) {
					await this.deps.setDefaultNotebookId(found.notebook_id);
				}
				this.json(res, 200, {
					ok: true,
					notebookId: found.notebook_id,
					name: found.name,
				});
				return;
			}
			if (url.pathname === "/api/notebooks" && req.method === "POST") {
				const body = await readJson(req);
				await this.handleCreateNotebook(res, body);
				return;
			}
			if (url.pathname === "/api/items" && req.method === "GET") {
				const meta = await this.resolveStrictNotebook(
					url.searchParams.get("notebook_id") ||
						url.searchParams.get("notebookId"),
				);
				if (!meta) {
					this.json(res, 400, { ok: false, error: "notebook_id 无效" });
					return;
				}
				const items = await this.deps.items.listItems(meta);
				this.json(res, 200, {
					ok: true,
					notebookId: meta.notebook_id,
					items: items.map(itemPayload),
				});
				return;
			}
			if (url.pathname === "/api/items" && req.method === "POST") {
				const body = await readJson(req);
				await this.handleCreateItem(res, body);
				return;
			}
			if (url.pathname === "/api/text" && req.method === "POST") {
				const body = await readJson(req);
				await this.handleText(res, body);
				return;
			}
			if (url.pathname === "/api/voice" && req.method === "POST") {
				const body = await readJson(req);
				await this.handleVoice(res, body);
				return;
			}
			if (url.pathname === "/api/file" && req.method === "POST") {
				const body = await readJson(req);
				await this.handleFile(res, body);
				return;
			}
			this.json(res, 404, { ok: false, error: "not found" });
		} catch (e) {
			this.json(res, 500, {
				ok: false,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	private async handleCreateNotebook(
		res: ServerResponse,
		body: Record<string, unknown>,
	): Promise<void> {
		if (!this.deps.createNotebook) {
			this.json(res, 501, { ok: false, error: "手机端暂不支持新建记录本" });
			return;
		}
		const name = String(body.name ?? "").trim();
		if (!name) {
			this.json(res, 400, { ok: false, error: "记录本名称为空" });
			return;
		}
		const templateId = pickTemplateId(body);
		const meta = await this.deps.createNotebook({ name, templateId });
		if (this.deps.setDefaultNotebookId) {
			await this.deps.setDefaultNotebookId(meta.notebook_id);
		}
		this.json(res, 200, {
			ok: true,
			defaultId: meta.notebook_id,
			notebook: notebookPayload(meta),
		});
	}

	private async handleCreateItem(
		res: ServerResponse,
		body: Record<string, unknown>,
	): Promise<void> {
		const meta = await this.resolveStrictNotebook(pickNotebookId(body));
		if (!meta) {
			this.json(res, 400, { ok: false, error: "notebook_id 无效" });
			return;
		}
		const title = String(body.title ?? "").trim();
		if (!title) {
			this.json(res, 400, { ok: false, error: "条目名称为空" });
			return;
		}
		const item = await this.deps.items.createItem(meta, {
			title,
			body: String(body.body ?? ""),
			capturedAt: pickCapturedAt(body),
			fields: { source: "mobile-web-item" },
		});
		this.pushRecent({
			title: item.frontmatter.title,
			preview: item.body.slice(0, 80),
			path: item.path,
			organized: false,
			at: recentAt(body),
		});
		this.deps.onNoteWritten?.({ title: item.frontmatter.title, path: item.path });
		this.json(res, 200, { ok: true, item: itemPayload(item) });
	}

	private async resolveStrictNotebook(
		notebookId: string | null | undefined,
	): Promise<NotebookMeta | null> {
		const id = String(notebookId ?? "").trim();
		if (!id) return null;
		if (this.deps.findNotebookById) return this.deps.findNotebookById(id);
		const found = await this.deps.resolveNotebookById(id);
		return found?.notebook_id === id ? found : null;
	}

	private async appendToItem(
		meta: NotebookMeta,
		itemId: string,
		body: string,
		heading: string,
		fields?: Record<string, unknown>,
	): Promise<NotebookItem | null> {
		const item = await this.deps.items.findById(meta, itemId);
		if (!item) return null;
		return this.deps.items.appendToItem(item, { body, heading, fields });
	}

	private async handleText(
		res: ServerResponse,
		body: Record<string, unknown>,
	): Promise<void> {
		const text = String(body.text ?? "").trim();
		if (!text) {
			this.json(res, 400, { ok: false, error: "text 为空" });
			return;
		}
		const organize =
			body.organize === undefined
				? this.deps.getSettings().bridge.autoOrganize
				: Boolean(body.organize);
		const source = String(body.source ?? "mobile-web");
		const notebookId = pickNotebookId(body);
		const itemId = pickItemId(body);
		if (!organize) {
			const path = await this.deps.inbox.dumpRaw({
				text,
				source: "mobile",
				title: text.split("\n")[0]?.slice(0, 40),
			});
			this.pushRecent({
				title: text.split("\n")[0]?.slice(0, 40) || "速记",
				preview: text.slice(0, 80),
				path,
				organized: false,
				at: new Date().toISOString(),
			});
			this.deps.onNoteWritten?.({ title: "收件箱", path });
			this.json(res, 200, { ok: true, path, organized: false });
			return;
		}
		const meta = itemId
			? await this.resolveStrictNotebook(notebookId)
			: await this.deps.resolveNotebookById(notebookId);
		if (!meta) {
			// fall back to inbox
			const path = await this.deps.inbox.dumpRaw({ text, source: "mobile" });
			this.json(res, 200, {
				ok: true,
				path,
				organized: false,
				warning: "无记录本，已写入收件箱",
			});
			return;
		}
		if (itemId) {
			const updated = await this.appendToItem(meta, itemId, text, "手机追加");
			if (!updated) {
				this.json(res, 404, { ok: false, error: "条目不存在" });
				return;
			}
			this.pushRecent({
				title: updated.frontmatter.title,
				preview: text.slice(0, 80),
				path: updated.path,
				organized: false,
				at: recentAt(body),
			});
			this.deps.onNoteWritten?.({
				title: updated.frontmatter.title,
				path: updated.path,
			});
			this.json(res, 200, {
				ok: true,
				appended: true,
				itemId: updated.frontmatter.item_id,
				title: updated.frontmatter.title,
				path: updated.path,
				organized: false,
			});
			return;
		}
		const cap = await this.deps.organize.captureStructured(meta, text, {
			useAi: true,
			source,
			sourceHint: "手机网页桥",
			capturedAt: pickCapturedAt(body),
		});
		this.pushRecent({
			title: cap.item.frontmatter.title,
			preview: cap.item.body.slice(0, 80),
			path: cap.item.path,
			organized: cap.organized,
			at: recentAt(body),
		});
		this.deps.onNoteWritten?.({
			title: cap.item.frontmatter.title,
			path: cap.item.path,
		});
		this.json(res, 200, {
			ok: true,
			title: cap.item.frontmatter.title,
			path: cap.item.path,
			organized: cap.organized,
			error: cap.error,
		});
	}

	private async handleVoice(
		res: ServerResponse,
		body: Record<string, unknown>,
	): Promise<void> {
		const b64 = String(body.audioBase64 ?? "");
		if (!b64) {
			this.json(res, 400, { ok: false, error: "缺少 audioBase64" });
			return;
		}
		const mime = String(body.mimeType ?? "audio/webm");
		const organize =
			body.organize === undefined
				? this.deps.getSettings().bridge.autoOrganize
				: Boolean(body.organize);
		const notebookId = pickNotebookId(body);
		const itemId = pickItemId(body);
		const meta = itemId
			? await this.resolveStrictNotebook(notebookId)
			: await this.deps.resolveNotebookById(notebookId);
		const resolved = this.deps.resolveVoice(meta);
		if (!resolved) {
			this.json(res, 400, {
				ok: false,
				error: "电脑未配置语音/默认 AI Provider，无法转写",
			});
			return;
		}
		const buf = Buffer.from(b64, "base64");
		const type = mime || "audio/wav";
		const blob = new Blob([buf], { type });
		const ext = type.includes("wav")
			? "wav"
			: type.includes("mp3") || type.includes("mpeg")
				? "mp3"
				: type.includes("mp4") || type.includes("m4a")
					? "m4a"
					: type.includes("webm")
						? "webm"
						: "wav";
		const tr = await this.deps.voice.transcribe(
			resolved.profile,
			resolved.model || "whisper-1",
			blob,
			`phone.${ext}`,
		);
		if (!tr.ok) {
			this.json(res, 500, { ok: false, error: `转写失败: ${tr.error}` });
			return;
		}
		try {
			await this.deps.inbox.saveVoiceRaw(tr.text);
		} catch {
			// ignore
		}
		if (!organize || !meta) {
			const path = await this.deps.inbox.dumpRaw({
				text: tr.text,
				source: "voice",
			});
			this.pushRecent({
				title: "语音转写",
				preview: tr.text.slice(0, 80),
				path,
				organized: false,
				at: recentAt(body),
			});
			this.json(res, 200, {
				ok: true,
				transcript: tr.text,
				path,
				organized: false,
			});
			return;
		}
		if (itemId) {
			const updated = await this.appendToItem(
				meta,
				itemId,
				tr.text,
				"语音转写追加",
			);
			if (!updated) {
				this.json(res, 404, { ok: false, error: "条目不存在" });
				return;
			}
			this.pushRecent({
				title: updated.frontmatter.title,
				preview: tr.text.slice(0, 80),
				path: updated.path,
				organized: false,
				at: recentAt(body),
			});
			this.deps.onNoteWritten?.({
				title: updated.frontmatter.title,
				path: updated.path,
			});
			this.json(res, 200, {
				ok: true,
				appended: true,
				transcript: tr.text,
				itemId: updated.frontmatter.item_id,
				title: updated.frontmatter.title,
				path: updated.path,
				organized: false,
			});
			return;
		}
		const cap = await this.deps.organize.captureStructured(meta, tr.text, {
			useAi: true,
			source: "mobile-web-voice",
			sourceHint: "手机网页语音",
			capturedAt: pickCapturedAt(body),
		});
		this.pushRecent({
			title: cap.item.frontmatter.title,
			preview: tr.text.slice(0, 80),
			path: cap.item.path,
			organized: cap.organized,
			at: new Date().toISOString(),
		});
		this.deps.onNoteWritten?.({
			title: cap.item.frontmatter.title,
			path: cap.item.path,
		});
		this.json(res, 200, {
			ok: true,
			transcript: tr.text,
			title: cap.item.frontmatter.title,
			path: cap.item.path,
			organized: cap.organized,
			error: cap.error,
		});
	}

	private async handleFile(
		res: ServerResponse,
		body: Record<string, unknown>,
	): Promise<void> {
		const b64 = String(body.fileBase64 ?? "");
		if (!b64) {
			this.json(res, 400, { ok: false, error: "缺少 fileBase64" });
			return;
		}
		const fileName = sanitizeUploadName(
			String(body.fileName ?? body.filename ?? "upload.bin"),
		);
		const mime = String(body.mimeType ?? "application/octet-stream");
		const notebookId = pickNotebookId(body);
		const itemId = pickItemId(body);
		const meta = itemId
			? await this.resolveStrictNotebook(notebookId)
			: await this.deps.resolveNotebookById(notebookId);
		const buf = Buffer.from(b64, "base64");
		const ab = buf.buffer.slice(
			buf.byteOffset,
			buf.byteOffset + buf.byteLength,
		) as ArrayBuffer;
		const noteTitle = String(body.title ?? fileName)
			.replace(/^mobile file:\s*/i, "")
			.slice(0, 80);

		if (!meta) {
			const path = await this.deps.inbox.dumpRaw({
				text: [
					`# ${noteTitle}`,
					"",
					`手机上传（尚无记录本，仅文字说明）：${fileName}`,
					`类型：${mime}`,
					`大小：${buf.length} 字节`,
				].join("\n"),
				source: "mobile",
				title: noteTitle,
			});
			this.pushRecent({
				title: noteTitle,
				preview: fileName,
				path,
				organized: false,
				at: new Date().toISOString(),
			});
			this.json(res, 200, {
				ok: true,
				path,
				organized: false,
				warning: "无记录本：未保存二进制，仅写入收件箱说明",
			});
			return;
		}
		const targetItem = itemId ? await this.deps.items.findById(meta, itemId) : null;
		if (itemId && !targetItem) {
			this.json(res, 404, { ok: false, error: "条目不存在" });
			return;
		}

		// 1) Write real binary into vault attachments + cabinet index
		const stored = await this.deps.cabinet.importBinary(meta, {
			displayName: fileName,
			data: ab,
			mime,
		});

		// 2) Note body embeds the file so Obsidian can preview image/video/pdf
		const embed = mediaEmbedMarkdown(stored.vaultPath, mime);
		const noteBody = [
			embed,
			"",
			body.note ? String(body.note) : "",
			"",
			`文件：\`${fileName}\``,
			`类型：${mime}`,
			`大小：${buf.length} 字节`,
			`路径：\`${stored.vaultPath}\``,
		]
			.filter((x) => x !== "")
			.join("\n");

		if (targetItem) {
			const refs = targetItem.frontmatter.cabinet_refs || [];
			const nextRefs = refs.includes(stored.id) ? refs : [...refs, stored.id];
			const updated = await this.deps.items.appendToItem(targetItem, {
				body: noteBody,
				heading: `追加文件 · ${fileName}`,
				fields: { cabinet_refs: nextRefs },
			});
			this.pushRecent({
				title: updated.frontmatter.title,
				preview: fileName,
				path: updated.path,
				organized: false,
				at: new Date().toISOString(),
			});
			this.deps.onNoteWritten?.({
				title: updated.frontmatter.title,
				path: updated.path,
			});
			this.json(res, 200, {
				ok: true,
				appended: true,
				itemId: updated.frontmatter.item_id,
				title: updated.frontmatter.title,
				path: updated.path,
				vaultPath: stored.vaultPath,
				fileName,
				size: buf.length,
				mime,
				organized: false,
			});
			return;
		}

		const item = await this.deps.items.createItem(meta, {
			title: noteTitle || fileName,
			body: noteBody,
			capturedAt: pickCapturedAt(body),
			fields: {
				source: "mobile-web-file",
				url: "",
			},
		});

		// link cabinet file to item when possible
		try {
			if (stored.item_id !== item.frontmatter.item_id) {
				// re-register is not needed; update refs on item
				const refs = item.frontmatter.cabinet_refs || [];
				if (!refs.includes(stored.id)) {
					await this.deps.items.updateItem(item, {
						fields: { cabinet_refs: [...refs, stored.id] },
					});
				}
			}
		} catch {
			// non-fatal
		}

		this.pushRecent({
			title: item.frontmatter.title,
			preview: fileName,
			path: item.path,
			organized: false,
			at: new Date().toISOString(),
		});
		this.deps.onNoteWritten?.({
			title: item.frontmatter.title,
			path: item.path,
		});
		this.json(res, 200, {
			ok: true,
			title: item.frontmatter.title,
			path: item.path,
			vaultPath: stored.vaultPath,
			fileName,
			size: buf.length,
			mime,
			organized: false,
		});
	}

	private pushRecent(item: RecentItem): void {
		this.recent = [item, ...this.recent].slice(0, 30);
	}

	private json(res: ServerResponse, code: number, data: unknown): void {
		res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(data));
	}
}

function listLocalAddresses(): string[] {
	const nets = os.networkInterfaces();
	const out: string[] = [];
	for (const entries of Object.values(nets)) {
		if (!entries) continue;
		for (const e of entries) {
			if ((e.family === "IPv4" || e.family === "IPv6") && !e.internal) {
				out.push(stripIpv6Zone(e.address));
			}
		}
	}
	return out;
}

function httpUrlForAddress(address: string, port: number, query: string): string {
	const host = address.includes(":") ? `[${stripIpv6Zone(address)}]` : address;
	return `http://${host}:${port}/${query}`;
}

function stripIpv6Zone(address: string): string {
	const i = address.indexOf("%");
	return i >= 0 ? address.slice(0, i) : address;
}

function isTailscaleAddress(address: string): boolean {
	return isTailscaleIPv4(address) || isTailscaleIPv6(address);
}

function isTailscaleIPv4(address: string): boolean {
	const parts = address.split(".").map((p) => Number(p));
	if (
		parts.length !== 4 ||
		parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
	) {
		return false;
	}
	return parts[0] === 100 && parts[1] != null && parts[1] >= 64 && parts[1] <= 127;
}

function isTailscaleIPv6(address: string): boolean {
	return stripIpv6Zone(address).toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		const max = 25 * 1024 * 1024; // 25MB voice
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > max) {
				reject(new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			try {
				const raw = Buffer.concat(chunks).toString("utf8");
				if (!raw.trim()) {
					resolve({});
					return;
				}
				resolve(JSON.parse(raw) as Record<string, unknown>);
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

function notebookPayload(meta: NotebookMeta): { id: string; name: string } {
	return { id: meta.notebook_id, name: meta.name };
}

function itemPayload(item: NotebookItem): {
	id: string;
	title: string;
	path: string;
	created: string;
	updated: string;
	preview: string;
} {
	return {
		id: item.frontmatter.item_id,
		title: item.frontmatter.title,
		path: item.path,
		created: item.frontmatter.created,
		updated: item.frontmatter.updated,
		preview: item.body.slice(0, 80),
	};
}

function pickNotebookId(body: Record<string, unknown>): string | null {
	const raw = body.notebook_id ?? body.notebookId;
	if (raw == null) return null;
	const s = String(raw).trim();
	return s || null;
}

function pickItemId(body: Record<string, unknown>): string | null {
	const raw = body.item_id ?? body.itemId;
	if (raw == null) return null;
	const s = String(raw).trim();
	return s || null;
}

function pickTemplateId(body: Record<string, unknown>): TemplateId {
	const raw = String(body.templateId ?? body.template_id ?? "blank").trim();
	const allowed: TemplateId[] = [
		"blank",
		"literature",
		"idea",
		"meeting",
		"cabinet-first",
	];
	return allowed.includes(raw as TemplateId) ? (raw as TemplateId) : "blank";
}

/** Mobile capture time from client (queue createdAt / capturedAt). */
function pickCapturedAt(
	body: Record<string, unknown>,
): string | number | null {
	const raw =
		body.capturedAt ?? body.createdAt ?? body.captured_at ?? body.created_at;
	if (raw == null || raw === "") return null;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	const s = String(raw).trim();
	if (!s) return null;
	if (/^\d{10,13}$/.test(s)) return Number(s);
	return s;
}

function recentAt(body: Record<string, unknown>): string {
	const cap = pickCapturedAt(body);
	if (typeof cap === "number") return new Date(cap).toISOString();
	if (typeof cap === "string") {
		const d = new Date(cap);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}
	return new Date().toISOString();
}

function sanitizeUploadName(name: string): string {
	const base = name.replace(/[\\/:*?"<>|]/g, "-").trim();
	return base || `upload-${Date.now()}.bin`;
}

/** Obsidian-friendly embed so images/videos render in the note. */
function mediaEmbedMarkdown(vaultPath: string, mime: string): string {
	const path = vaultPath.replace(/\\/g, "/");
	const m = mime.toLowerCase();
	if (m.startsWith("image/")) {
		return `![[${path}]]`;
	}
	if (m.startsWith("video/")) {
		return `![[${path}]]`;
	}
	if (m.startsWith("audio/")) {
		return `![[${path}]]`;
	}
	if (m === "application/pdf" || path.toLowerCase().endsWith(".pdf")) {
		return `![[${path}]]`;
	}
	// generic file link (clickable in Obsidian)
	return `[[${path}]]`;
}
