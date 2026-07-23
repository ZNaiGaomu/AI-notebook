import type { ProviderProfile } from "../domain/types";
import { requestJson } from "./httpClient";

export type ChatTextPart = { type: "text"; text: string };
export type ChatInputAudioPart = {
	type: "input_audio";
	input_audio: { data: string; format: "wav" | "mp3" };
};
export type ChatImageUrlPart = {
	type: "image_url";
	image_url: { url: string; detail?: "auto" | "low" | "high" };
};
export type ChatContentPart = ChatTextPart | ChatInputAudioPart | ChatImageUrlPart;

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string | ChatContentPart[];
};

export type ChatResult =
	| { ok: true; content: string; raw: unknown }
	| { ok: false; error: string };

export type ListModelsResult =
	| { ok: true; models: string[]; raw: unknown }
	| { ok: false; error: string };

/** Normalize base URL to end with /v1 (no trailing slash beyond that). */
export function normalizeBaseUrl(baseUrl: string): string {
	let u = baseUrl.trim().replace(/\/+$/, "");
	if (!u) return u;
	if (!/\/v1$/i.test(u)) {
		u = `${u}/v1`;
	}
	return u;
}

/**
 * Parse OpenAI-compatible GET /models response into sorted unique model ids.
 * Supports: { data: [{ id }] }, { data: ["id"] }, { models: [...] }
 */
export function parseModelsResponse(data: unknown): string[] {
	if (!data || typeof data !== "object") return [];
	const root = data as Record<string, unknown>;
	let list: unknown[] = [];
	if (Array.isArray(root.data)) list = root.data;
	else if (Array.isArray(root.models)) list = root.models;
	else if (Array.isArray(root)) list = root;

	const ids: string[] = [];
	for (const item of list) {
		if (typeof item === "string" && item.trim()) {
			ids.push(item.trim());
			continue;
		}
		if (item && typeof item === "object") {
			const o = item as Record<string, unknown>;
			const id =
				(typeof o.id === "string" && o.id) ||
				(typeof o.model === "string" && o.model) ||
				(typeof o.name === "string" && o.name) ||
				"";
			if (id.trim()) ids.push(id.trim());
		}
	}
	return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export class AiGateway {
	async testConnection(profile: ProviderProfile): Promise<ChatResult> {
		if (!profile.baseUrl.trim()) {
			return { ok: false, error: "未配置 Base URL" };
		}
		if (!profile.apiKey.trim()) {
			return { ok: false, error: "未配置 API Key" };
		}
		// Prefer models endpoint — works even when chat model id is wrong
		const listed = await this.listModels(profile);
		if (listed.ok) {
			const n = listed.models.length;
			const sample = listed.models.slice(0, 3).join(", ");
			return {
				ok: true,
				content: `OK · 上游 ${n} 个模型${sample ? `（如 ${sample}）` : ""}`,
				raw: listed.raw,
			};
		}
		const model = profile.defaultModel || profile.models[0];
		if (!model) {
			return {
				ok: false,
				error: `拉取模型失败: ${listed.error}；且未配置本地模型名`,
			};
		}
		return this.chat(profile, model, [
			{ role: "user", content: "Reply with exactly: ok" },
		], { maxTokens: 16, temperature: 0 });
	}

	/**
	 * GET {base}/models — OpenAI-compatible model list.
	 */
	async listModels(profile: ProviderProfile): Promise<ListModelsResult> {
		if (!profile.baseUrl.trim()) {
			return { ok: false, error: "未配置 Base URL" };
		}
		if (!profile.apiKey.trim()) {
			return { ok: false, error: "未配置 API Key（获取模型列表需要 Key）" };
		}
		const base = normalizeBaseUrl(profile.baseUrl);
		const url = `${base}/models`;
		// Use Obsidian requestUrl (no CORS). Do not send Content-Type on GET.
		const res = await requestJson({
			url,
			method: "GET",
			headers: {
				Authorization: `Bearer ${profile.apiKey.trim()}`,
			},
		});
		if (!res.ok) {
			const text = res.text || "";
			if (
				res.status === 403 ||
				/cloudflare|just a moment|cf-ray/i.test(text)
			) {
				return {
					ok: false,
					error: `HTTP ${res.status}: 被网关拦截。请确认 URL/Key；或手动添加模型名（如 whisper-1）。详情：${res.error}`,
				};
			}
			return {
				ok: false,
				error:
					res.status === 0
						? res.error
						: `HTTP ${res.status}: ${res.error}`,
			};
		}
		const models = parseModelsResponse(res.data);
		if (models.length === 0) {
			return {
				ok: false,
				error: "上游返回了空模型列表（或格式无法识别）。可手动添加如 whisper-1",
			};
		}
		return { ok: true, models, raw: res.data };
	}

	async chat(
		profile: ProviderProfile,
		model: string,
		messages: ChatMessage[],
		opts?: { maxTokens?: number; temperature?: number },
	): Promise<ChatResult> {
		return this.chatRaw(profile, model, messages, opts);
	}

	/**
	 * Multimodal chat: try several payload shapes so a model that can "hear"
	 * returns transcript text. Does NOT send base64 as plain text (models treat
	 * that as "no audio provided").
	 */
	async chatTranscribeAudio(
		profile: ProviderProfile,
		model: string,
		audioBase64: string,
		format: "wav" | "mp3" = "wav",
	): Promise<ChatResult> {
		const instruction =
			"请把这段音频完整转写成纯文本。只输出转写正文，不要解释、不要加标题、不要用代码块。语言与音频一致（中文就写中文）。若你完全收不到音频，只回复：NO_AUDIO";

		const dataUri = `data:audio/${format};base64,${audioBase64}`;
		const mime = format === "mp3" ? "audio/mpeg" : "audio/wav";

		const rawAttempts: Array<{ name: string; body: unknown }> = [
			{
				name: "input_audio",
				body: {
					model,
					temperature: 0,
					max_tokens: 2048,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: instruction },
								{
									type: "input_audio",
									input_audio: { data: audioBase64, format },
								},
							],
						},
					],
				},
			},
			{
				name: "input_audio+wav",
				body: {
					model,
					temperature: 0,
					max_tokens: 2048,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: instruction },
								{
									type: "input_audio",
									input_audio: {
										data: audioBase64,
										format: "wav",
									},
								},
							],
						},
					],
				},
			},
			{
				name: "audio_url.data",
				body: {
					model,
					temperature: 0,
					max_tokens: 2048,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: instruction },
								{
									type: "audio_url",
									audio_url: { url: dataUri },
								},
							],
						},
					],
				},
			},
			{
				name: "file.audio_url",
				body: {
					model,
					temperature: 0,
					max_tokens: 2048,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: instruction },
								{
									type: "file",
									file: {
										filename: `audio.${format}`,
										file_data: dataUri,
									},
								},
							],
						},
					],
				},
			},
			{
				name: "multipart-style-json",
				body: {
					model,
					temperature: 0,
					max_tokens: 2048,
					modalities: ["text", "audio"],
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: instruction },
								{
									type: "input_audio",
									input_audio: {
										data: audioBase64,
										format,
										// some stacks want mime
										mime_type: mime,
									},
								},
							],
						},
					],
				},
			},
		];

		const errors: string[] = [];
		for (const a of rawAttempts) {
			const r = await this.chatRawBody(profile, a.body);
			if (!r.ok) {
				errors.push(`${a.name}: ${r.error}`);
				continue;
			}
			const text = r.content.trim();
			if (!text || isNoAudioReply(text)) {
				errors.push(
					`${a.name}: 模型未真正收到音频（回复: ${text.slice(0, 80)}）`,
				);
				continue;
			}
			return r;
		}

		return {
			ok: false,
			error:
				errors.slice(0, 5).join(" | ") ||
				"对话模型无法接收音频（可能仅支持纯文本）",
		};
	}

	private async chatRaw(
		profile: ProviderProfile,
		model: string,
		messages: ChatMessage[],
		opts?: { maxTokens?: number; temperature?: number },
	): Promise<ChatResult> {
		return this.chatRawBody(profile, {
			model,
			messages,
			max_tokens: opts?.maxTokens ?? 256,
			temperature: opts?.temperature ?? 0.2,
		});
	}

	/** Low-level chat with arbitrary JSON body (for multimodal experiments). */
	async chatRawBody(
		profile: ProviderProfile,
		body: unknown,
	): Promise<ChatResult> {
		const base = normalizeBaseUrl(profile.baseUrl);
		const url = `${base}/chat/completions`;
		const res = await requestJson({
			url,
			method: "POST",
			headers: {
				Authorization: `Bearer ${profile.apiKey}`,
			},
			body,
		});
		if (!res.ok) {
			return {
				ok: false,
				error:
					res.status === 0
						? res.error
						: `HTTP ${res.status}: ${res.error}`,
			};
		}
		const content = extractContent(res.data);
		if (content == null) {
			return { ok: false, error: "响应中无 message content" };
		}
		return { ok: true, content, raw: res.data };
	}
}

function extractContent(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const choices = (data as { choices?: unknown }).choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const first = choices[0] as { message?: { content?: unknown } };
	const content = first?.message?.content;
	if (typeof content === "string") return content;
	// multimodal content array
	if (Array.isArray(content)) {
		const texts = content
			.map((p) => {
				if (typeof p === "string") return p;
				if (p && typeof p === "object" && "text" in p) {
					return String((p as { text: unknown }).text ?? "");
				}
				return "";
			})
			.filter(Boolean);
		return texts.length ? texts.join("\n") : null;
	}
	return null;
}

/** Model got the request but did not receive playable audio. */
export function isNoAudioReply(text: string): boolean {
	const t = text.trim();
	if (!t) return true;
	if (/^NO_AUDIO$/i.test(t)) return true;
	const patterns = [
		/未提供.*音频/,
		/没有.*音频/,
		/无.*音频(文件|内容|数据)?/,
		/no audio/i,
		/cannot (find|access|hear).*audio/i,
		/did not (receive|get|contain).*audio/i,
		/无法(播放|读取|获取|识别).*音频/,
		/消息中.*音频/,
		/I (can't|cannot) (hear|access|find)/i,
	];
	return patterns.some((re) => re.test(t));
}

/** Friendlier message for browser/Electron network failures. */
export function formatFetchError(e: unknown, url: string): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
		return (
			`网络请求失败（Failed to fetch）→ ${url}\n` +
			"常见原因：①电脑断网/代理异常；②URL 写错；③防火墙/公司网拦截；" +
			"④服务商或 Cloudflare 拦截了客户端请求。\n" +
			"处理：浏览器打开该站是否正常；检查 Base URL 是否为 https://域名/v1；" +
			"Key 是否粘贴完整；仍失败可手动添加模型名（如 whisper-1）不必依赖「获取列表」。"
		);
	}
	return msg;
}
