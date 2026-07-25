/**
 * One-off: probe ALL configured providers × models for STT + chat-audio.
 * Not a plugin feature — run with: npx tsx scripts/probe-voice-models.ts
 * or via vitest/node after build helpers.
 *
 * Reads vault user config: .obsidian/ai-notebook-user.json (path via env or arg)
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

type Provider = {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	models: string[];
	defaultModel: string;
};

type UserCfg = {
	providers?: Provider[];
	defaultProviderId?: string | null;
	purposeRouting?: unknown;
};

function normalizeBaseUrl(baseUrl: string): string {
	let u = (baseUrl || "").trim().replace(/\/+$/, "");
	if (!u) return "";
	if (!/^https?:\/\//i.test(u)) u = "https://" + u;
	return u.replace(/\/+$/, "");
}

function uniqueModels(p: Provider): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const m of [p.defaultModel, ...(p.models || [])]) {
		const s = (m || "").trim();
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out;
}

/** Minimal silent wav (not real speech — only tests endpoint acceptance). */
function makeTinyWav(): Buffer {
	// 16-bit mono PCM 16kHz ~0.1s of quiet noise
	const sampleRate = 16000;
	const n = Math.floor(sampleRate * 0.15);
	const dataSize = n * 2;
	const buf = Buffer.alloc(44 + dataSize);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + dataSize, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(dataSize, 40);
	for (let i = 0; i < n; i++) {
		const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 2000;
		buf.writeInt16LE(Math.max(-32767, Math.min(32767, sample | 0)), 44 + i * 2);
	}
	return buf;
}

function extractTranscript(data: unknown): string | null {
	if (data == null) return null;
	if (typeof data === "string" && data.trim()) {
		const s = data.trim();
		if (s.startsWith("{") || s.startsWith("[")) {
			try {
				return extractTranscript(JSON.parse(s));
			} catch {
				return s;
			}
		}
		return s;
	}
	if (typeof data !== "object") return null;
	const o = data as Record<string, unknown>;
	if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
	for (const k of ["result", "transcript", "transcription", "content"]) {
		const v = o[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	if (o.data != null) {
		const n = extractTranscript(o.data);
		if (n) return n;
	}
	if (o.output && typeof o.output === "object") {
		const n = extractTranscript(o.output);
		if (n) return n;
	}
	return null;
}

async function probeStt(
	baseUrl: string,
	apiKey: string,
	model: string,
	wav: Buffer,
): Promise<{ ok: boolean; detail: string }> {
	const base = normalizeBaseUrl(baseUrl);
	const url = `${base}/audio/transcriptions`;
	const boundary = "----Probe" + Date.now().toString(16);
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	const push = (s: string) => parts.push(enc.encode(s));
	push(`--${boundary}\r\n`);
	push(`Content-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`);
	push(`--${boundary}\r\n`);
	push(
		`Content-Disposition: form-data; name="file"; filename="probe.wav"\r\n`,
	);
	push(`Content-Type: audio/wav\r\n\r\n`);
	parts.push(new Uint8Array(wav));
	push(`\r\n--${boundary}--\r\n`);
	const total = parts.reduce((n, c) => n + c.length, 0);
	const body = new Uint8Array(total);
	let off = 0;
	for (const c of parts) {
		body.set(c, off);
		off += c.length;
	}
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 25000);
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
			},
			body,
			signal: ctrl.signal,
		});
		clearTimeout(timer);
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
				detail: `HTTP ${res.status} ${(text || "").slice(0, 120)}`,
			};
		}
		const tr = extractTranscript(data) || extractTranscript(text);
		if (tr?.trim()) {
			return { ok: true, detail: "text=" + tr.trim().slice(0, 60) };
		}
		return { ok: false, detail: "HTTP 200 but no transcript field" };
	} catch (e) {
		return {
			ok: false,
			detail: e instanceof Error ? e.message : String(e),
		};
	}
}

async function main() {
	const cfgPath =
		process.argv[2] ||
		process.env.AI_NOTEBOOK_USER_JSON ||
		"";
	if (!cfgPath || !existsSync(cfgPath)) {
		console.error(
			"Usage: npx tsx scripts/probe-voice-models.ts <path-to-ai-notebook-user.json>\n" +
				"Or set AI_NOTEBOOK_USER_JSON.\n" +
				"Typical: <vault>/.obsidian/ai-notebook-user.json",
		);
		process.exit(1);
	}
	const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as UserCfg;
	const providers = Array.isArray(raw.providers) ? raw.providers : [];
	const wav = makeTinyWav();
	const sttOk: string[] = [];
	const sttFail: string[] = [];
	const lines: string[] = [];
	lines.push("# 语音转写能力一次性体检（脚本，非插件功能）");
	lines.push("");
	lines.push("配置: " + resolve(cfgPath));
	lines.push("时间: " + new Date().toISOString());
	lines.push("");
	lines.push("说明: 仅测 POST {base}/audio/transcriptions；用合成短 WAV，不打印 API Key。");
	lines.push("");

	let total = 0;
	for (const p of providers) {
		if (!p?.baseUrl?.trim() || !p?.apiKey?.trim()) continue;
		total += uniqueModels(p).length;
	}
	let done = 0;
	for (const p of providers) {
		if (!p?.baseUrl?.trim() || !p?.apiKey?.trim()) {
			lines.push(`## ${p?.name || p?.id || "?"} — 跳过（无 URL/Key）`);
			lines.push("");
			continue;
		}
		const models = uniqueModels(p);
		lines.push(`## ${p.name || p.id}  (${normalizeBaseUrl(p.baseUrl)})`);
		lines.push("");
		for (const model of models) {
			done++;
			const label = `${p.name || p.id}/${model}`;
			process.stderr.write(`[${done}/${total}] STT ${label} ... `);
			const r = await probeStt(p.baseUrl, p.apiKey, model, wav);
			if (r.ok) {
				sttOk.push(label);
				lines.push(`- ✓ STT ${model}: ${r.detail}`);
				process.stderr.write("OK\n");
			} else {
				sttFail.push(label + " :: " + r.detail);
				lines.push(`- ✗ STT ${model}: ${r.detail}`);
				process.stderr.write("FAIL\n");
			}
		}
		lines.push("");
	}

	lines.push("## 结论：STT 真正可用");
	lines.push("");
	if (sttOk.length) {
		for (const s of sttOk) lines.push("- " + s);
	} else {
		lines.push("- （无）当前所有已配模型的 /audio/transcriptions 均不可用。");
		lines.push(
			"- 这通常表示中转未开通 Whisper/ASR 通道，而不是「录音文件坏了」。",
		);
	}
	lines.push("");
	lines.push(`合计: 可用 ${sttOk.length} / 失败 ${sttFail.length}`);
	lines.push("");

	const outPath = resolve(
		process.cwd(),
		"voice-stt-probe-result.md",
	);
	writeFileSync(outPath, lines.join("\n"), "utf-8");
	console.log("\nWrote " + outPath);
	console.log("STT OK (" + sttOk.length + "):");
	for (const s of sttOk) console.log("  " + s);
	if (!sttOk.length) {
		console.log("  (none)");
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
