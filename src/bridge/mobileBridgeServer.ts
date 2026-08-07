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
import { itemDisplayName } from "../services/itemDisplayName";
import {
	applyRetranscribeToBody,
	buildVoiceBlock,
	itemBasename,
} from "../services/voiceRetranscribe";
import type { InboxService } from "../services/inboxService";
import type { OrganizeService } from "../services/organizeService";
import type { VoiceService } from "../services/voiceService";
import type { ItemService } from "../services/itemService";
import type { CabinetService } from "../services/cabinetService";
import type { AttachmentService } from "../services/attachmentService";
import {
	buildAttachmentEmbedMarkdown,
} from "../services/attachmentService";
import type { VoicePipeline } from "../services/voicePipeline";
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
	/** Full voice purpose chain for STT polling (never stop at first failure). */
	resolveVoiceChain?: (
		notebook?: NotebookMeta | null,
	) => Array<{ profile: ProviderProfile; model: string; slotIndex?: number }>;
	/** Desktop-identical STT pipeline (full chain + chat-audio fallback). */
	voicePipeline?: VoicePipeline;
	inbox: InboxService;
	organize: OrganizeService;
	voice: VoiceService;
	items: ItemService;
	cabinet: CabinetService;
	/** Ordinary uploads use attachments, not cabinet. */
	attachments: AttachmentService;
	onNoteWritten?: (info: { title: string; path: string }) => void;
};

type VoiceJobStatus = "pending" | "running" | "done" | "failed";
type VoiceJob = {
	id: string;
	status: VoiceJobStatus;
	progress: string;
	transcript: string;
	warning: string;
	path: string;
	itemId: string;
	title: string;
	createdAt: number;
	updatedAt: number;
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
	/** Destination note/item path in vault */
	path: string;
	organized: boolean;
	at: string;
	notebookId?: string;
	notebookName?: string;
	itemId?: string;
	itemTitle?: string;
	kind?: "text" | "voice" | "file" | "other";
	/** What was uploaded (filename or text preview) */
	sourceLabel?: string;
	/** Attachment vault path for voice/file */
	sourcePath?: string;
	attachmentId?: string;
	clientSourceId?: string;
};

/**
 * Desktop-only LAN HTTP bridge: phone opens a page, posts text/voice back into vault + AI.
 */

export class MobileBridgeServer {

	private server: http.Server | null = null;

	private recent: RecentItem[] = [];

	private lastError: string | undefined;

	/** In-memory async STT jobs for mobile (audio already on disk). */
	private voiceJobs = new Map<string, VoiceJob>();
	private voiceWriteTails = new Map<string, Promise<void>>();

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
			if (url.pathname === "/api/voice-job" && req.method === "GET") {
				const id = (url.searchParams.get("id") || "").trim();
				const job = id ? this.voiceJobs.get(id) : undefined;
				if (!job) {
					this.json(res, 404, { ok: false, error: "任务不存在或已过期" });
					return;
				}
				this.json(res, 200, { ok: true, job });
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
			title: itemDisplayName(item),
			preview: item.body.slice(0, 80),
			path: item.path,
			organized: false,
			at: recentAt(body),
		});
		this.deps.onNoteWritten?.({ title: itemDisplayName(item), path: item.path });
		this.json(res, 200, { ok: true, item: itemPayload(item) });
	}

	private async resolveStrictNotebook(
		notebookId: string | null | undefined,
	): Promise<NotebookMeta | null> {
		const id = String(notebookId ?? "").trim();
		if (!id) return this.deps.resolveNotebookById(null);
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
		const meta = await this.resolveStrictNotebook(notebookId);
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
				title: itemDisplayName(updated),
				preview: text.slice(0, 80),
				path: updated.path,
				organized: false,
				at: recentAt(body),
				notebookId: meta.notebook_id,
				notebookName: meta.name,
				itemId: updated.frontmatter.item_id,
				itemTitle: itemDisplayName(updated),
				kind: "text",
			sourceLabel:
				typeof text !== "undefined" ? String(text).slice(0, 80) : undefined,
		});
			this.deps.onNoteWritten?.({
				title: itemDisplayName(updated),
				path: updated.path,
			});
			this.json(res, 200, {
				ok: true,
				appended: true,
				itemId: updated.frontmatter.item_id,
				title: itemDisplayName(updated),
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
			title: itemDisplayName(cap.item),
			preview: cap.item.body.slice(0, 80),
			path: cap.item.path,
			organized: cap.organized,
			at: recentAt(body),
			notebookId: meta.notebook_id,
			notebookName: meta.name,
			itemId: cap.item.frontmatter.item_id,
			itemTitle: itemDisplayName(cap.item),
			kind: "text",
			sourceLabel:
				typeof text !== "undefined" ? String(text).slice(0, 80) : undefined,
		});
		this.deps.onNoteWritten?.({
			title: itemDisplayName(cap.item),
			path: cap.item.path,
		});
		this.json(res, 200, {
			ok: true,
			title: itemDisplayName(cap.item),
			path: cap.item.path,
			organized: cap.organized,
			error: cap.error,
		});
	}

	private async handleVoice(
		res: ServerResponse,
		body: Record<string, unknown>,
	): Promise<void> {
		const clientSourceId = sanitizeClientSourceId(body.clientSourceId);
		const b64 = String(body.audioBase64 ?? "").replace(/\s+/g, "");
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
		const meta = await this.resolveStrictNotebook(notebookId);

		let buf: Buffer;
		try {
			buf = Buffer.from(b64, "base64");
		} catch {
			this.json(res, 400, { ok: false, error: "audioBase64 不是合法 Base64" });
			return;
		}
		if (!buf.length) {
			this.json(res, 400, { ok: false, error: "音频数据为空" });
			return;
		}
		const type = mime || "audio/wav";
		const ab = buf.buffer.slice(
			buf.byteOffset,
			buf.byteOffset + buf.byteLength,
		) as ArrayBuffer;
		const blob = new Blob([ab], { type });
		const ext = type.includes("wav")
			? "wav"
			: type.includes("mp3") || type.includes("mpeg")
				? "mp3"
				: type.includes("mp4") || type.includes("m4a")
					? "m4a"
					: type.includes("webm")
						? "webm"
						: "wav";
		const fileName = `phone-voice-${Date.now()}.${ext}`;

		// ——— 1) HARD REQUIREMENT: always land audio first (never blocked by STT) ———
		if (!organize) {
			try {
				const dumped = await this.deps.inbox.dumpBinary({
					fileName,
					data: ab,
					mime: type,
					source: "mobile",
					title: `手机语音 ${new Date().toLocaleString()}`,
					note: "手机 App 语音（仅收件箱）",
				});
				// STT best-effort after dump
				const stt = await this.pollVoiceTranscription(blob, fileName, meta);
				this.pushRecent({
					title: "手机语音",
					preview: stt.transcript?.slice(0, 80) || fileName,
					path: dumped.notePath,
					organized: false,
					at: recentAt(body),
					kind: "voice",
					sourceLabel: fileName,
					sourcePath: dumped.filePath,
					clientSourceId,
				});
				this.json(res, 200, {
					ok: true,
					path: dumped.notePath,
					filePath: dumped.filePath,
					inboxOnly: true,
					transcript: stt.transcript || "",
					warning: stt.warning,
					organized: false,
					clientSourceId,
				});
			} catch (e) {
				this.json(res, 500, {
					ok: false,
					error: `收件箱写入失败: ${e instanceof Error ? e.message : String(e)}`,
				});
			}
			return;
		}

		if (!meta) {
			try {
				const dumped = await this.deps.inbox.dumpBinary({
					fileName,
					data: ab,
					mime: type,
					source: "mobile",
					title: `手机语音 ${new Date().toLocaleString()}`,
					note: "无记录本：音频已进收件箱",
				});
				this.pushRecent({
					title: "手机语音",
					preview: fileName,
					path: dumped.notePath,
					organized: false,
					at: recentAt(body),
					kind: "voice",
					sourceLabel: fileName,
					sourcePath: dumped.filePath,
					clientSourceId,
				});
				this.json(res, 200, {
					ok: true,
					path: dumped.notePath,
					filePath: dumped.filePath,
					organized: false,
					clientSourceId,
					warning: "无记录本：音频已进收件箱",
				});
			} catch (e) {
				this.json(res, 500, {
					ok: false,
					error: `收件箱写入失败: ${e instanceof Error ? e.message : String(e)}`,
				});
			}
			return;
		}

		// Resolve / create target item, then attach audio into body FIRST
		let item =
			itemId ? await this.deps.items.findById(meta, itemId) : null;
		if (itemId && !item) {
			this.json(res, 404, {
				ok: false,
				error: `条目不存在（item_id=${itemId}）。请重新选择条目后再发。`,
			});
			return;
		}
		let created = false;
		if (!item) {
			item = await this.deps.items.createItem(meta, {
				title: `手机语音 ${new Date().toLocaleString()}`,
				body: "",
				capturedAt: pickCapturedAt(body),
				fields: { source: "mobile-voice" },
			});
			created = true;
		}

		let stored;
		try {
			stored = await this.deps.attachments.importBinary(meta, {
				displayName: fileName,
				data: ab,
				mime: type,
				item_id: item.frontmatter.item_id,
				itemName: itemDisplayName(item),
				kind: "voice",
				origin: "mobile-voice",
			});
		} catch (e) {
			this.json(res, 500, {
				ok: false,
				error: `音频附件保存失败: ${e instanceof Error ? e.message : String(e)}`,
			});
			return;
		}

				const embed = buildAttachmentEmbedMarkdown(stored, {
			caption: `手机语音 · ${fileName} · ${type}`,
		});
		// Step 1: audio first + a path-addressable pending block
		item = await this.deps.items.appendToItem(item, {
			body: buildVoiceBlock({
				vaultPath: stored.vaultPath,
				embedMarkdown: embed,
				pending: true,
			}),
			fields: {
				source: "mobile-voice",
				transcribe_status: "pending",
				audio_path: stored.vaultPath,
			},
		});

		const jobId = shortId(createId(), 12);
		const job: VoiceJob = {
			id: jobId,
			status: "pending",
			progress: "音频已写入，排队转写…",
			transcript: "",
			warning: "",
			path: item.path,
			itemId: item.frontmatter.item_id,
			title: itemDisplayName(item),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.voiceJobs.set(jobId, job);
		this.pruneVoiceJobs();

		this.pushRecent({
			title: itemDisplayName(item),
			preview: fileName,
			path: item.path,
			organized: false,
			at: recentAt(body),
			notebookId: meta.notebook_id,
			notebookName: meta.name,
			itemId: item.frontmatter.item_id,
			itemTitle: itemDisplayName(item),
			kind: "voice",
			sourceLabel: fileName,
			sourcePath: stored.vaultPath,
			attachmentId: stored.id,
			clientSourceId,
		});
		this.deps.onNoteWritten?.({
			title: itemDisplayName(item),
			path: item.path,
		});

		// Immediate success for transfer; STT continues in background
		this.json(res, 200, {
			ok: true,
			appended: !created,
			created,
			jobId,
			transcribeStatus: "pending",
			transcript: "",
			itemId: item.frontmatter.item_id,
			title: itemDisplayName(item),
			path: item.path,
			vaultPath: stored.vaultPath,
			attachmentId: stored.id,
			clientSourceId,
			organized: false,
			message: "传输成功，转写进行中",
		});

		void this.runMobileVoiceSttJob({
			jobId,
			meta,
			itemId: item.frontmatter.item_id,
			blob,
			fileName,
			arrayBuffer: ab,
			vaultPath: stored.vaultPath,
			embed,
		});
	}

	private async runMobileVoiceSttJob(input: {
		jobId: string;
		meta: NotebookMeta;
		itemId: string;
		blob: Blob;
		fileName: string;
		arrayBuffer: ArrayBuffer;
		vaultPath: string;
		embed: string;
	}): Promise<void> {
		const job = this.voiceJobs.get(input.jobId);
		if (!job) return;
		const setJob = (patch: Partial<VoiceJob>) => {
			const cur = this.voiceJobs.get(input.jobId);
			if (!cur) return;
			this.voiceJobs.set(input.jobId, {
				...cur,
				...patch,
				updatedAt: Date.now(),
			});
		};
		setJob({ status: "running", progress: "开始转写…" });

		const pipe = this.deps.voicePipeline;
		if (!pipe) {
			const stt = await this.pollVoiceTranscription(
				input.blob,
				input.fileName,
				input.meta,
			);
			await this.finalizeMobileVoiceStt({
				jobId: input.jobId,
				meta: input.meta,
				itemId: input.itemId,
				embed: input.embed,
				vaultPath: input.vaultPath,
				transcript: stt.transcript,
				warning: stt.warning,
				polished: "",
			});
			return;
		}

		try {
			const result = await pipe.process(
				input.meta,
				input.blob,
				input.fileName,
				{
					existing: {
						vaultPath: input.vaultPath,
						arrayBuffer: input.arrayBuffer,
					},
					onProgress: (msg) => setJob({ progress: msg }),
				},
			);
			// Keep original mobile embed so we can surgically patch the same block
			await this.finalizeMobileVoiceStt({
				jobId: input.jobId,
				meta: input.meta,
				itemId: input.itemId,
				embed: input.embed,
				vaultPath: input.vaultPath,
				transcript: result.ok ? result.transcript : "",
				warning: result.ok
					? ""
					: shortWarn(
							[result.error, result.errorDetail]
								.filter(Boolean)
								.join(" · ") || "自动转写未成功",
						),
				polished: result.polished || "",
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			await this.finalizeMobileVoiceStt({
				jobId: input.jobId,
				meta: input.meta,
				itemId: input.itemId,
				embed: input.embed,
				vaultPath: input.vaultPath,
				transcript: "",
				warning: shortWarn(msg),
				polished: "",
			});
		}
	}

	private async finalizeMobileVoiceStt(input: {
		jobId: string;
		meta: NotebookMeta;
		itemId: string;
		embed: string;
		vaultPath: string;
		transcript: string;
		warning: string;
		polished: string;
	}): Promise<void> {
		const key = input.meta.notebook_id + ":" + input.itemId;
		const previous = this.voiceWriteTails.get(key) ?? Promise.resolve();
		const current = previous.then(() => this.finalizeMobileVoiceSttInternal(input));
		this.voiceWriteTails.set(key, current.catch(() => undefined));
		try {
			await current;
		} finally {
			if (this.voiceWriteTails.get(key) === current) this.voiceWriteTails.delete(key);
		}
	}

	private async finalizeMobileVoiceSttInternal(input: {
		jobId: string;
		meta: NotebookMeta;
		itemId: string;
		embed: string;
		vaultPath: string;
		transcript: string;
		warning: string;
		polished: string;
	}): Promise<void> {
		const job = this.voiceJobs.get(input.jobId);
		try {
			// Re-read item so concurrent mobile writes are preserved
			const item = await this.deps.items.findById(input.meta, input.itemId);
			if (!item) {
				if (job) {
					this.voiceJobs.set(input.jobId, {
						...job,
						status: "failed",
						progress: "条目已不存在，无法写回转写",
						warning: "条目不存在",
						updatedAt: Date.now(),
					});
				}
				return;
			}

			const raw = (input.transcript || "").trim();
			if (raw) {
				try {
					await this.deps.inbox.saveVoiceRaw(raw);
				} catch {
					/* ignore */
				}
			}

			const nextBody = applyMobileVoiceSttToBody(item.body || "", {
				embed: input.embed,
				vaultPath: input.vaultPath,
				transcript: raw,
				polished: (input.polished || "").trim(),
				warning: input.warning || "",
			});
			if (nextBody === (item.body || "") && !nextBody.includes(input.vaultPath)) {
				throw new Error("语音块已删除或无法定位");
			}

			const updated = await this.deps.items.updateItem(item, {
				body: nextBody,
				fields: {
					source: "mobile-voice",
					transcribe_status: raw ? "done" : "failed",
					audio_path: input.vaultPath,
				},
			});

			if (job) {
				this.voiceJobs.set(input.jobId, {
					...job,
					status: raw ? "done" : "failed",
					progress: raw ? "转写完成" : "转写失败（录音已保留）",
					transcript: raw,
					warning: raw ? "" : input.warning,
					path: updated.path,
					title: itemDisplayName(updated),
					updatedAt: Date.now(),
				});
			}
			this.deps.onNoteWritten?.({
				title: itemDisplayName(updated),
				path: updated.path,
			});
		} catch (e) {
			if (job) {
				const msg = shortWarn(e instanceof Error ? e.message : String(e));
				this.voiceJobs.set(input.jobId, {
					...job,
					status: "failed",
					progress: msg,
					warning: msg,
					updatedAt: Date.now(),
				});
			}
		}
	}

	private pruneVoiceJobs(): void {
		const maxAge = 2 * 60 * 60 * 1000;
		const now = Date.now();
		for (const [id, j] of this.voiceJobs) {
			if (now - j.createdAt > maxAge) this.voiceJobs.delete(id);
		}
		if (this.voiceJobs.size > 80) {
			const sorted = [...this.voiceJobs.entries()].sort(
				(a, b) => a[1].createdAt - b[1].createdAt,
			);
			for (const [id] of sorted.slice(0, this.voiceJobs.size - 60)) {
				this.voiceJobs.delete(id);
			}
		}
	}


	private async pollVoiceTranscription(
		blob: Blob,
		fileName: string,
		meta: NotebookMeta | null,
	): Promise<{ transcript: string; warning: string }> {
		const chain =
			this.deps.resolveVoiceChain?.(meta) ||
			(() => {
				const one = this.deps.resolveVoice(meta);
				return one ? [{ profile: one.profile, model: one.model }] : [];
			})();
		if (!chain.length) {
			return {
				transcript: "",
				warning: "未配置语音转写 Provider（设置 → 用途「语音转写」）",
			};
		}
		const errors: string[] = [];
		for (let i = 0; i < chain.length; i++) {
			const cand = chain[i]!;
			const model = (cand.model || "").trim() || "whisper-1";
			const label = `${cand.profile.name || cand.profile.id}/${model}`;
			try {
				const tr = await this.deps.voice.transcribe(
					cand.profile,
					model,
					blob,
					fileName,
				);
				if (tr.ok && (tr.text || "").trim()) {
					return { transcript: tr.text.trim(), warning: "" };
				}
				errors.push(
					`${i + 1}/${chain.length} ${label}: ${tr.ok ? "空文本" : shortWarn(tr.error || "失败")}`,
				);
			} catch (e) {
				errors.push(
					`${i + 1}/${chain.length} ${label}: ${shortWarn(e instanceof Error ? e.message : String(e))}`,
				);
			}
		}
		return {
			transcript: "",
			warning: `语音链 ${chain.length} 个候选均失败：${errors.slice(0, 4).join(" | ")}`,
		};
	}

	private async handleFile(
		res: ServerResponse,
		body: Record<string, unknown>,
	): Promise<void> {
		const clientSourceId = sanitizeClientSourceId(body.clientSourceId);
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
		const organize =
			body.organize === undefined ? true : Boolean(body.organize);
		const buf = Buffer.from(b64, "base64");
		const noteTitle = String(body.title ?? fileName)
			.replace(/^mobile file:\s*/i, "")
			.slice(0, 80);

		if (!organize) {
			const abInbox = buf.buffer.slice(
				buf.byteOffset,
				buf.byteOffset + buf.byteLength,
			) as ArrayBuffer;
			const dumped = await this.deps.inbox.dumpBinary({
				fileName,
				data: abInbox,
				mime,
				source: "mobile",
				title: noteTitle,
				note: body.note ? String(body.note) : "",
			});
			this.pushRecent({
				title: noteTitle,
				preview: `${fileName}（收件箱文件）`,
				path: dumped.notePath,
				organized: false,
				at: new Date().toISOString(),
				kind: "file",
				sourceLabel: fileName,
				sourcePath: dumped.filePath,
				clientSourceId,
			});
			this.json(res, 200, {
				ok: true,
				path: dumped.notePath,
				filePath: dumped.filePath,
				inboxOnly: true,
				organized: false,
				clientSourceId,
			});
			return;
		}

const meta = await this.resolveStrictNotebook(notebookId);
		const ab = buf.buffer.slice(
			buf.byteOffset,
			buf.byteOffset + buf.byteLength,
		) as ArrayBuffer;

		if (!meta) {
			const dumped = await this.deps.inbox.dumpBinary({
				fileName,
				data: ab,
				mime,
				source: "mobile",
				title: noteTitle,
			});
			this.pushRecent({
				title: noteTitle,
				preview: fileName,
				path: dumped.notePath,
				organized: false,
				at: new Date().toISOString(),
				kind: "file",
				sourceLabel: fileName,
				sourcePath: dumped.filePath,
				clientSourceId,
			});
			this.json(res, 200, {
				ok: true,
				path: dumped.notePath,
				filePath: dumped.filePath,
				organized: false,
				clientSourceId,
				warning: "无记录本：文件已进收件箱，待选择记录本整理",
			});
			return;
		}
		const targetItem = itemId
			? await this.deps.items.findById(meta, itemId)
			: null;
		if (itemId && !targetItem) {
			this.json(res, 404, { ok: false, error: "条目不存在" });
			return;
		}

		// Create/resolve item first so attachment lands under final item path.
		let item = targetItem;
		let created = false;
		if (!item) {
			item = await this.deps.items.createItem(meta, {
				title: noteTitle || fileName,
				body: body.note ? String(body.note) : "",
				capturedAt: pickCapturedAt(body),
				fields: {
					source: "mobile-web-file",
					url: "",
				},
			});
			created = true;
		}

		const stored = await this.deps.attachments.importBinary(meta, {
			displayName: fileName,
			data: ab,
			mime,
			item_id: item.frontmatter.item_id,
			itemName: itemDisplayName(item),
			kind: "backup",
			origin: "mobile-upload",
		});

		const noteExtra = body.note ? String(body.note).trim() : "";
		const embedBlock = [
			noteExtra && !created ? noteExtra : "",
			buildAttachmentEmbedMarkdown(stored, {
				caption: `${fileName} · ${mime} · ${buf.length} 字节`,
			}),
		]
			.filter(Boolean)
			.join(String.fromCharCode(10, 10));

		const updated = created
			? await this.deps.items.updateItem(item, {
					body: [item.body, embedBlock].filter(Boolean).join(String.fromCharCode(10, 10)),
			  })
			: await this.deps.items.appendToItem(item, {
					body: embedBlock,
					heading: `附件 · ${fileName}`,
			  });

		this.pushRecent({
			title: itemDisplayName(updated),
			preview: fileName,
			path: updated.path,
			organized: false,
			at: new Date().toISOString(),
			notebookId: meta.notebook_id,
			notebookName: meta.name,
			itemId: updated.frontmatter.item_id,
			itemTitle: itemDisplayName(updated),
			kind: "file",
			sourceLabel: fileName,
			sourcePath: stored.vaultPath,
			attachmentId: stored.id,
			clientSourceId,
		});
		this.deps.onNoteWritten?.({
			title: itemDisplayName(updated),
			path: updated.path,
		});
		this.json(res, 200, {
			ok: true,
			appended: !created,
			itemId: updated.frontmatter.item_id,
			title: itemDisplayName(updated),
			path: updated.path,
			vaultPath: stored.vaultPath,
			attachmentId: stored.id,
			clientSourceId,
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
	const fileTitle = itemBasename(item.path);
	return {
		id: item.frontmatter.item_id,
		// Primary label for App/pickers: vault file name under items/
		title: fileTitle || item.frontmatter.title || "未命名",
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

/** Strip HTML / cap length for UI-facing warnings. */

/**
 * Surgically write STT result next to THIS voice embed.
 * NEVER replaces the whole note body — preserves prior text / files / other voices.
 */
function applyMobileVoiceSttToBody(
	oldBody: string,
	opts: {
		embed: string;
		vaultPath: string;
		transcript: string;
		polished: string;
		warning: string;
	},
): string {
	const updated = applyRetranscribeToBody(oldBody || "", {
		vaultPath: opts.vaultPath,
		transcript: opts.transcript,
		polished: opts.polished,
		warning: opts.warning,
	});
	if (updated !== oldBody) return updated;
	// The audio was just attached; fail closed if an external edit removed it.
	return oldBody;
}

function buildMobileSttBlock(opts: {
	transcript: string;
	polished: string;
	warning: string;
}): string {
	const raw = (opts.transcript || "").trim();
	if (raw) {
		const polished = (opts.polished || "").trim();
		const parts = ["### 语音转写", "", raw];
		if (polished && polished !== raw) {
			parts.push("", "### 润色", "", polished);
		}
		return parts.join("\n");
	}
	const warn = shortWarn(opts.warning || "全部候选失败");
	return `> ⚠️ 转写失败：${warn}（录音已保留）`;
}

/** Unique strings that identify this voice attachment in the note body. */
function collectEmbedMarkers(embed: string, vaultPath: string): string[] {
	const out: string[] = [];
	const idMatch = embed.match(/ai-notebook-attachment:([a-f0-9-]+)/i);
	if (idMatch) out.push(`ai-notebook-attachment:${idMatch[1]}`);
	const path = (vaultPath || "").replace(/\\/g, "/").trim();
	if (path) {
		out.push(`![[${path}]]`);
		out.push(path);
	}
	// Full embed first line as weak fallback
	const firstLine = (embed || "").split("\n").find((l) => l.trim());
	if (firstLine && firstLine.trim().length >= 12) out.push(firstLine.trim());
	return [...new Set(out.filter(Boolean))];
}

function findEmbedAnchor(
	body: string,
	markers: string[],
): { start: number; end: number } | null {
	for (const mk of markers) {
		const idx = body.indexOf(mk);
		if (idx < 0) continue;
		// Expand to cover the embed block: from line start of marker,
		// through following ![[...]] / caption lines until blank-blank or pending/heading.
		let start = body.lastIndexOf("\n", idx);
		start = start < 0 ? 0 : start + 1;
		// If HTML comment is on previous line, include it
		if (start > 0) {
			const prevNl = body.lastIndexOf("\n", start - 2);
			const prevLine = body.slice(prevNl < 0 ? 0 : prevNl + 1, start - 1);
			if (/ai-notebook-attachment:/i.test(prevLine)) {
				start = prevNl < 0 ? 0 : prevNl + 1;
			}
		}
		let end = idx + mk.length;
		// Consume rest of current line + a few following non-structural lines of the embed
		const afterMarker = body.slice(end);
		const lineEnd = afterMarker.indexOf("\n");
		if (lineEnd >= 0) end += lineEnd + 1;
		else end = body.length;
		// Include subsequent lines that are part of embed (media / caption), stop at pending or ##
		let guard = 0;
		while (guard++ < 6 && end < body.length) {
			const rest = body.slice(end);
			const nl = rest.indexOf("\n");
			const line = nl < 0 ? rest : rest.slice(0, nl);
			const trimmed = line.trim();
			if (!trimmed) {
				// single blank stays with embed; stop before double or content
				end += nl < 0 ? rest.length : nl + 1;
				const next = body.slice(end);
				const n2 = next.indexOf("\n");
				const nextLine = (n2 < 0 ? next : next.slice(0, n2)).trim();
				if (
					!nextLine ||
					nextLine.startsWith(">") ||
					nextLine.startsWith("#") ||
					nextLine.startsWith("<!--")
				) {
					break;
				}
				// caption line without markdown heading — include one
				if (!/^!\[\[/.test(nextLine) && !/^\[\[/.test(nextLine)) {
					end += n2 < 0 ? next.length : n2 + 1;
				}
				break;
			}
			if (
				trimmed.startsWith(">") ||
				trimmed.startsWith("#") ||
				/ai-notebook-attachment:/i.test(trimmed)
			) {
				break;
			}
			// media / caption line
			end += nl < 0 ? rest.length : nl + 1;
			if (nl < 0) break;
		}
		return { start, end };
	}
	return null;
}

function shortWarn(msg: string): string {
	return String(msg || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
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

function sanitizeClientSourceId(value: unknown): string {
	return String(value ?? "")
		.trim()
		.replace(/[^A-Za-z0-9._-]/g, "")
		.slice(0, 80);
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
