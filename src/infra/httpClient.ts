import { requestUrl } from "obsidian";

export type HttpJsonResult =
	| { ok: true; status: number; data: unknown; text: string }
	| { ok: false; status: number; error: string; text?: string };

export function formatNetworkError(e: unknown, url: string): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
		return (
			`网络请求失败（Failed to fetch）→ ${url}\n` +
			"若 Grok 可用而其他站不可用，多为该站 CORS/网关策略不同。本插件已用 Obsidian requestUrl 直连（不经页面 CORS）。\n" +
			"仍失败请检查：代理/VPN、防火墙、Base URL 是否为 https://域名/v1、API Key 是否有效。"
		);
	}
	return msg;
}

/**
 * JSON HTTP via Obsidian requestUrl (no browser CORS).
 * This is why some hosts work with Grok but fail with window.fetch.
 */
export async function requestJson(opts: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
}): Promise<HttpJsonResult> {
	const method = (opts.method || "GET").toUpperCase();
	const headers: Record<string, string> = {
		Accept: "application/json",
		...(opts.headers || {}),
	};
	let body: string | ArrayBuffer | undefined;
	if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
		if (typeof opts.body === "string") body = opts.body;
		else if (opts.body instanceof ArrayBuffer) body = opts.body;
		else {
			body = JSON.stringify(opts.body);
			if (!headers["Content-Type"] && !headers["content-type"]) {
				headers["Content-Type"] = "application/json";
			}
		}
	}

	try {
		const res = await requestUrl({
			url: opts.url,
			method,
			headers,
			body,
			throw: false,
		});
		const text = res.text ?? "";
		let data: unknown = null;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = null;
			}
		}
		if (res.status < 200 || res.status >= 300) {
			return {
				ok: false,
				status: res.status,
				error: extractErr(data) || text.slice(0, 200) || `HTTP ${res.status}`,
				text,
			};
		}
		if (data == null && text) {
			return {
				ok: false,
				status: res.status,
				error: `HTTP ${res.status}: 响应不是 JSON`,
				text,
			};
		}
		return { ok: true, status: res.status, data, text };
	} catch (e) {
		// Unit tests / mock: fall back to fetch
		return requestJsonViaFetch(opts, e);
	}
}

async function requestJsonViaFetch(
	opts: {
		url: string;
		method?: string;
		headers?: Record<string, string>;
		body?: unknown;
	},
	primaryError?: unknown,
): Promise<HttpJsonResult> {
	const method = (opts.method || "GET").toUpperCase();
	try {
		const headers: Record<string, string> = {
			Accept: "application/json",
			...(opts.headers || {}),
		};
		const init: RequestInit = { method, headers };
		if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
			init.body =
				typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
			if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
		}
		const res = await fetch(opts.url, init);
		const text = await res.text();
		let data: unknown = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = null;
		}
		if (!res.ok) {
			return {
				ok: false,
				status: res.status,
				error: extractErr(data) || text.slice(0, 200) || `HTTP ${res.status}`,
				text,
			};
		}
		return { ok: true, status: res.status, data, text };
	} catch (e2) {
		return {
			ok: false,
			status: 0,
			error: formatNetworkError(e2 ?? primaryError, opts.url),
		};
	}
}

export async function requestMultipart(opts: {
	url: string;
	headers?: Record<string, string>;
	fields: Record<string, string>;
	file: {
		fieldName: string;
		filename: string;
		mime: string;
		data: ArrayBuffer;
	};
}): Promise<HttpJsonResult> {
	const boundary = "----AiNotebookForm" + Date.now().toString(16);
	const chunks: Uint8Array[] = [];
	const enc = new TextEncoder();
	const push = (s: string) => chunks.push(enc.encode(s));
	for (const [k, v] of Object.entries(opts.fields)) {
		push(`--${boundary}\r\n`);
		push(`Content-Disposition: form-data; name="${k}"\r\n\r\n`);
		push(`${v}\r\n`);
	}
	push(`--${boundary}\r\n`);
	push(
		`Content-Disposition: form-data; name="${opts.file.fieldName}"; filename="${opts.file.filename}"\r\n`,
	);
	push(`Content-Type: ${opts.file.mime}\r\n\r\n`);
	chunks.push(new Uint8Array(opts.file.data));
	push(`\r\n--${boundary}--\r\n`);

	const total = chunks.reduce((n, c) => n + c.length, 0);
	const body = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		body.set(c, off);
		off += c.length;
	}
	const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);

	try {
		const res = await requestUrl({
			url: opts.url,
			method: "POST",
			headers: {
				...(opts.headers || {}),
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
			},
			body: ab,
			throw: false,
		});
		const text = res.text ?? "";
		let data: unknown = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = null;
		}
		if (res.status < 200 || res.status >= 300) {
			return {
				ok: false,
				status: res.status,
				error: extractErr(data) || text.slice(0, 200) || `HTTP ${res.status}`,
				text,
			};
		}
		return { ok: true, status: res.status, data, text };
	} catch {
		try {
			const form = new FormData();
			for (const [k, v] of Object.entries(opts.fields)) form.append(k, v);
			const blob = new Blob([opts.file.data], { type: opts.file.mime });
			form.append(opts.file.fieldName, blob, opts.file.filename);
			const res = await fetch(opts.url, {
				method: "POST",
				headers: opts.headers || {},
				body: form,
			});
			const text = await res.text();
			let data: unknown = null;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				data = null;
			}
			if (!res.ok) {
				return {
					ok: false,
					status: res.status,
					error: extractErr(data) || text.slice(0, 200),
					text,
				};
			}
			return { ok: true, status: res.status, data, text };
		} catch (e2) {
			return {
				ok: false,
				status: 0,
				error: formatNetworkError(e2, opts.url),
			};
		}
	}
}

function extractErr(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const err = (data as { error?: unknown }).error;
	if (typeof err === "string") return err;
	if (err && typeof err === "object") {
		const m = (err as { message?: unknown }).message;
		if (typeof m === "string") return m;
	}
	const msg = (data as { message?: unknown }).message;
	return typeof msg === "string" ? msg : null;
}
