import { Notice, TFile, type App } from "obsidian";
import type { NotebookItem, NotebookMeta } from "../domain/types";
import type { ItemService } from "./itemService";
import type { NotebookService } from "./notebookService";
import type { VoicePipeline } from "./voicePipeline";

export type RetranscribeDeps = {
	app: App;
	voicePipeline: VoicePipeline;
	items: ItemService;
	notebooks: NotebookService;
	onProgress?: (msg: string) => void;
	onDone?: (ok: boolean, msg: string) => void;
};

export type VoiceBlockInput = {
	vaultPath: string;
	embedMarkdown: string;
	transcript?: string;
	polished?: string;
	warning?: string;
	pending?: boolean;
};

const AUDIO_EXTENSIONS = "m4a|mp3|wav|ogg|webm|mp4";
const inFlight = new Map<string, Promise<{ ok: boolean; message: string }>>();

export function normalizeVoicePath(path: string): string {
	return String(path || "")
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.trim();
}

export function voiceBlockStart(vaultPath: string): string {
	return `%% ai-notebook-voice:start path="${encodeURIComponent(normalizeVoicePath(vaultPath))}" %%`;
}

export function voiceBlockEnd(vaultPath: string): string {
	return `%% ai-notebook-voice:end path="${encodeURIComponent(normalizeVoicePath(vaultPath))}" %%`;
}

function legacyVoiceBlockStart(vaultPath: string): string {
	return `<!-- ai-notebook-voice:start path="${encodeURIComponent(normalizeVoicePath(vaultPath))}" -->`;
}

function legacyVoiceBlockEnd(vaultPath: string): string {
	return `<!-- ai-notebook-voice:end path="${encodeURIComponent(normalizeVoicePath(vaultPath))}" -->`;
}

/** Stable, path-addressable voice block used by all new voice writes. */
export function buildVoiceBlock(input: VoiceBlockInput): string {
	const path = normalizeVoicePath(input.vaultPath);
	const embed = normalizeEmbed(input.embedMarkdown, path);
	const parts = [voiceBlockStart(path), "## 语音录音", "", embed];
	if (input.pending) {
		parts.push("", "> ⏳ 转写处理中…（进度见电脑端；完成后自动写回）");
	} else if ((input.transcript || "").trim()) {
		parts.push("", buildSttBlock(input));
	} else if ((input.warning || "").trim()) {
		parts.push("", buildSttBlock(input));
	}
	parts.push(voiceBlockEnd(path));
	return parts.join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

/**
 * Re-run STT on an existing vault audio file and update only that audio block.
 */
export async function retranscribeVaultAudio(
	deps: RetranscribeDeps,
	input: {
		vaultPath: string;
		item?: NotebookItem | null;
		meta?: NotebookMeta | null;
	},
): Promise<{ ok: boolean; message: string }> {
	const path = normalizeVoicePath(input.vaultPath);
	if (!path) return fail(deps, "无效的录音路径");
	const file = deps.app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return fail(deps, `找不到录音文件：${path}`);

	const resolved = await resolveItemContext(deps, path, input.item, input.meta);
	if (!resolved) {
		return fail(deps, "无法定位该录音所属条目（请在 AI 记录本条目中打开）");
	}
	const { meta, item } = resolved;
	const key = `${item.path}::${path}`;
	const running = inFlight.get(key);
	if (running) return running;

	const task = runRetranscribe(deps, meta, item, file, path).finally(() => {
		inFlight.delete(key);
	});
	inFlight.set(key, task);
	return task;
}

async function runRetranscribe(
	deps: RetranscribeDeps,
	meta: NotebookMeta,
	item: NotebookItem,
	file: TFile,
	path: string,
): Promise<{ ok: boolean; message: string }> {
	const progress = (msg: string) => {
		try {
			deps.onProgress?.(msg);
		} catch {
			/* ignore */
		}
	};
	progress("再转写 · 读取音频…");

	try {
		const arrayBuffer = await deps.app.vault.readBinary(file);
		const name = path.split("/").pop() || "audio.m4a";
		const blob = new Blob([arrayBuffer], { type: guessAudioMime(name) });
		let last = "";
		const pipe = await deps.voicePipeline.process(meta, blob, name, {
			existing: { vaultPath: path, arrayBuffer },
			onProgress: (msg) => {
				if (msg !== last) {
					last = msg;
					progress(`再转写 · ${msg}`);
				}
			},
		});

		// Re-read immediately before write to preserve concurrent changes.
		const fresh = await deps.items.findById(meta, item.frontmatter.item_id);
		if (!fresh) return fail(deps, "条目已不存在", false);
		if (!containsVoicePath(fresh.body, path)) {
			return fail(deps, "正文已不包含该录音，已取消写回", false);
		}

		const raw = pipe.ok ? (pipe.transcript || "").trim() : "";
		const polished = (pipe.polished || "").trim();
		const nextBody = applyRetranscribeToBody(fresh.body || "", {
			vaultPath: path,
			transcript: raw,
			polished,
			warning: pipe.ok
				? ""
				: [pipe.error, pipe.errorDetail].filter(Boolean).join(" · ") ||
					"自动转写未成功",
		});
		if (nextBody === fresh.body && !raw) {
			return fail(deps, "无法安全定位该语音段，已取消写回", false);
		}
		await deps.items.updateItem(fresh, {
			body: nextBody,
			fields: {
				transcribe_status: raw ? "done" : "failed",
				audio_path: path,
			},
		});

		if (raw) {
			const message =
				polished && polished !== raw ? "再转写完成 · 含润色" : "再转写完成";
			return done(deps, true, message);
		}
		return done(
			deps,
			false,
			`再转写未成功${pipe.error ? "：" + pipe.error : ""}（录音保留）`,
		);
	} catch (error) {
		return fail(
			deps,
			`再转写失败：${error instanceof Error ? error.message : String(error)}`,
			false,
		);
	}
}

/**
 * Marker blocks are exact. Legacy blocks are upgraded only when an exact embed/path exists.
 * Missing/ambiguous targets fail closed and leave the body unchanged.
 */
export function applyRetranscribeToBody(
	oldBody: string,
	opts: {
		vaultPath: string;
		transcript: string;
		polished: string;
		warning: string;
	},
): string {
	const old = oldBody || "";
	const path = normalizeVoicePath(opts.vaultPath);
	if (!path) return old;

	const marked = findMarkedBlock(old, path);
	if (marked) {
		const current = old.slice(marked.start, marked.end);
		const replacement = buildVoiceBlock({
			vaultPath: path,
			embedMarkdown: extractEmbedMarkdown(current, path),
			transcript: opts.transcript,
			polished: opts.polished,
			warning: opts.warning,
		});
		if (current.trim() === replacement.trim()) return old;
		return replaceRange(old, marked.start, marked.end, replacement);
	}

	const legacy = findLegacyVoiceBlock(old, path);
	if (!legacy) return old;
	const current = old.slice(legacy.start, legacy.end);
	const replacement = buildVoiceBlock({
		vaultPath: path,
		embedMarkdown: extractEmbedMarkdown(current, path),
		transcript: opts.transcript,
		polished: opts.polished,
		warning: opts.warning,
	});
	return replaceRange(old, legacy.start, legacy.end, replacement);
}

function findMarkedBlock(
	body: string,
	path: string,
): { start: number; end: number } | null {
	for (const [startMarker, endMarker] of [
		[voiceBlockStart(path), voiceBlockEnd(path)],
		[legacyVoiceBlockStart(path), legacyVoiceBlockEnd(path)],
	] as const) {
		const start = body.indexOf(startMarker);
		if (start < 0) continue;
		const endIndex = body.indexOf(endMarker, start + startMarker.length);
		if (endIndex >= 0) return { start, end: endIndex + endMarker.length };
	}
	return null;
}

function findLegacyVoiceBlock(
	body: string,
	path: string,
): { start: number; end: number } | null {
	const escaped = escapeRegExp(path);
	const embed = new RegExp(`!\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\]`, "i").exec(body);
	const pathLine = body.indexOf(path);
	const anchor = embed?.index ?? pathLine;
	if (anchor < 0) return null;

	const headings = [...body.matchAll(/^##\s+([^\n]+)$/gm)].map((match) => ({
		index: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
		name: match[1]!.trim(),
	}));
	const before = headings.filter((heading) => heading.index < anchor);
	const previous = before[before.length - 1];
	const start = previous && isVoiceHeading(previous.name)
		? previous.index
		: lineStartIncludingAttachmentMarker(body, anchor);

	let end = body.length;
	let consumedResultHeading = false;
	for (const heading of headings) {
		if (heading.index <= anchor) continue;
		if (isResultHeading(heading.name) && !consumedResultHeading) {
			consumedResultHeading = true;
			continue;
		}
		// A second recording heading or any unrelated h2 starts the next block.
		end = heading.index;
		break;
	}
	if (end <= start) return null;
	return { start, end };
}

function buildSttBlock(opts: {
	transcript?: string;
	polished?: string;
	warning?: string;
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
	const warning = String(opts.warning || "自动转写未成功")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
	return `> ⚠️ 转写失败：${warning}（录音已保留，可点「再转写」重试）`;
}

function extractEmbedMarkdown(block: string, path: string): string {
	const lines = block.split("\n");
	const index = lines.findIndex((line) => line.includes(`![[${path}`));
	const embedLine = index >= 0 ? lines[index]!.trim() : `![[${path}]]`;
	const previous = index > 0 ? lines[index - 1]!.trim() : "";
	return previous.startsWith("<!-- ai-notebook-attachment:")
		? `${previous}\n${embedLine}`
		: embedLine;
}

function normalizeEmbed(embedMarkdown: string, path: string): string {
	const embed = String(embedMarkdown || "").trim();
	const match = embed.match(/(?:<!-- ai-notebook-attachment:[^>]+-->\s*)?!\[\[[^\]]+\]\]/i);
	return match?.[0]?.trim() || `![[${path}]]`;
}

function replaceRange(body: string, start: number, end: number, replacement: string): string {
	const before = body.slice(0, start).trimEnd();
	const after = body.slice(end).trimStart();
	return [before, replacement.trim(), after].filter(Boolean).join("\n\n").trimEnd();
}

function lineStartIncludingAttachmentMarker(body: string, anchor: number): number {
	let start = body.lastIndexOf("\n", anchor);
	start = start < 0 ? 0 : start + 1;
	const previousEnd = Math.max(0, start - 1);
	const previousStart = body.lastIndexOf("\n", previousEnd - 1);
	const previousLine = body.slice(previousStart < 0 ? 0 : previousStart + 1, previousEnd).trim();
	if (previousLine.startsWith("<!-- ai-notebook-attachment:")) {
		return previousStart < 0 ? 0 : previousStart + 1;
	}
	return start;
}

function isVoiceHeading(name: string): boolean {
	return /^(?:语音)?(?:录音|转写)$/.test(name) || name === "转写";
}

function isResultHeading(name: string): boolean {
	return /^(?:语音)?转写$/.test(name) || name === "润色";
}

function containsVoicePath(body: string, path: string): boolean {
	return (
		body.includes(path) ||
		body.includes(voiceBlockStart(path)) ||
		body.includes(legacyVoiceBlockStart(path))
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveItemContext(
	deps: RetranscribeDeps,
	audioPath: string,
	item: NotebookItem | null | undefined,
	meta: NotebookMeta | null | undefined,
): Promise<{ meta: NotebookMeta; item: NotebookItem } | null> {
	if (meta && item) return { meta, item };
	const active = deps.app.workspace.getActiveFile();
	if (active) {
		const fromActive = await tryLoadItemFromPath(deps, active.path);
		if (fromActive) return fromActive;
	}
	const match = audioPath.match(/\/items\/([^/]+)\//);
	if (match?.[1]) {
		const folder = match[1];
		for (const notebook of await deps.notebooks.listNotebooks()) {
			const items = await deps.items.listItems(notebook);
			const hit =
				items.find((candidate) => itemBasename(candidate.path) === folder) ||
				items.find((candidate) => candidate.frontmatter.title === folder);
			if (hit) return { meta: notebook, item: hit };
		}
	}
	return null;
}

async function tryLoadItemFromPath(
	deps: RetranscribeDeps,
	path: string,
): Promise<{ meta: NotebookMeta; item: NotebookItem } | null> {
	try {
		for (const notebook of await deps.notebooks.listNotebooks()) {
			const hit = (await deps.items.listItems(notebook)).find((item) => item.path === path);
			if (hit) return { meta: notebook, item: hit };
		}
	} catch {
		/* ignore */
	}
	return null;
}

export function itemBasename(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const base = normalized.split("/").pop() || "";
	return base.replace(/\.md$/i, "") || base;
}

function guessAudioMime(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith(".wav")) return "audio/wav";
	if (lower.endsWith(".mp3")) return "audio/mpeg";
	if (lower.endsWith(".webm")) return "audio/webm";
	if (lower.endsWith(".ogg")) return "audio/ogg";
	return "audio/mp4";
}

function done(
	deps: RetranscribeDeps,
	ok: boolean,
	message: string,
): { ok: boolean; message: string } {
	deps.onDone?.(ok, message);
	new Notice(message);
	return { ok, message };
}

function fail(
	deps: RetranscribeDeps,
	message: string,
	notifyDone = true,
): { ok: false; message: string } {
	if (notifyDone) deps.onDone?.(false, message);
	new Notice(message);
	return { ok: false, message };
}

/** Extract a normalized vault path from a rendered audio/embed element. */
export function extractAudioVaultPath(el: HTMLElement | null): string | null {
	if (!el) return null;
	const embed = el.closest(
		".internal-embed, .media-embed, span.internal-embed, div.internal-embed",
	) as HTMLElement | null;
	for (const raw of [
		el.getAttribute("src"),
		el.getAttribute("alt"),
		el.getAttribute("data-path"),
		embed?.getAttribute("src"),
		embed?.getAttribute("data-path"),
		(el as HTMLMediaElement).currentSrc,
	]) {
		const path = extractAudioPathFromRaw(raw);
		if (path) return path;
	}
	for (const node of [el, embed, el.parentElement, embed?.parentElement || null]) {
		const path = extractAudioPathFromText(node?.textContent || "");
		if (path) return path;
	}
	return null;
}

export function extractAudioPathFromRaw(
	raw: string | null | undefined,
): string | null {
	if (!raw) return null;
	let value = raw;
	try {
		value = decodeURIComponent(value);
	} catch {
		/* ignore */
	}
	value = value.replace(/\\/g, "/").split("?")[0] || "";
	const attachmentIndex = value.indexOf("attachments/");
	if (attachmentIndex >= 0) {
		const candidate = value.slice(attachmentIndex);
		const match = candidate.match(
			new RegExp(
				"attachments/[^\\n`\\\"'<>\\]]+?\\.(?:" + AUDIO_EXTENSIONS + ")",
				"i",
			),
		);
		return match ? normalizeVoicePath(match[0]) : null;
	}
	return new RegExp(`\\.(?:${AUDIO_EXTENSIONS})$`, "i").test(value) &&
		!/^https?:|^app:/i.test(value)
		? normalizeVoicePath(value)
		: null;
}

function extractAudioPathFromText(text: string): string | null {
	const attachmentIndex = text.indexOf("attachments/");
	if (attachmentIndex < 0) return null;
	return extractAudioPathFromRaw(text.slice(attachmentIndex));
}
