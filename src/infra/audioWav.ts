/**
 * Browser-side PCM capture → WAV encoding for Whisper-compatible uploads.
 * Avoids broken webm/opus duration parsers on many OpenAI-compatible gateways.
 */

export type WavCaptureHandle = {
	stop: () => Promise<{ blob: Blob; durationMs: number; sampleRate: number }>;
};

/** Encode mono Float32 PCM to 16-bit PCM WAV. */
export function encodeWavMono(
	samples: Float32Array,
	sampleRate: number,
): Blob {
	const numChannels = 1;
	const bitsPerSample = 16;
	const blockAlign = (numChannels * bitsPerSample) / 8;
	const byteRate = sampleRate * blockAlign;
	const dataSize = samples.length * 2;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	writeString(view, 0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeString(view, 8, "WAVE");
	writeString(view, 12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);
	writeString(view, 36, "data");
	view.setUint32(40, dataSize, true);

	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]!));
		view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		offset += 2;
	}
	return new Blob([buffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}

export function mergeFloat32(chunks: Float32Array[]): Float32Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Float32Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

/** True when browser allows getUserMedia (HTTPS or localhost). */
export function canUseMicrophone(): {
	ok: boolean;
	reason?: string;
} {
	if (typeof window === "undefined") {
		return { ok: false, reason: "非浏览器环境" };
	}
	const md =
		navigator.mediaDevices ||
		// legacy
		(navigator as unknown as { webkitGetUserMedia?: unknown }).webkitGetUserMedia;
	if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
		const insecure =
			typeof window.isSecureContext === "boolean" && !window.isSecureContext;
		if (insecure) {
			return {
				ok: false,
				reason:
					"当前页面不是 HTTPS（局域网 http://192.168.x.x 在手机上通常禁止麦克风）。请：①用文字发送；或②电脑生成 HTTPS 公网链接（Cloudflare/ngrok）后再录音。",
			};
		}
		return {
			ok: false,
			reason: "浏览器未提供麦克风 API（mediaDevices）",
		};
	}
	if (typeof window.isSecureContext === "boolean" && !window.isSecureContext) {
		// Some desktops still expose API on LAN IP; phones often don't
		return {
			ok: true,
			reason:
				"非安全上下文：部分手机浏览器仍会拒绝麦克风，若失败请改用 HTTPS 公网链接或文字输入",
		};
	}
	void md;
	return { ok: true };
}

/**
 * Record mic to WAV using AudioContext (no webm).
 */
export async function startWavCapture(
	stream: MediaStream,
): Promise<WavCaptureHandle> {
	const AudioCtx =
		window.AudioContext ||
		(window as unknown as { webkitAudioContext: typeof AudioContext })
			.webkitAudioContext;
	const ctx = new AudioCtx();
	const source = ctx.createMediaStreamSource(stream);
	// ScriptProcessor is deprecated but widely available; buffer size 4096
	const processor = ctx.createScriptProcessor(4096, 1, 1);
	const chunks: Float32Array[] = [];
	const startedAt = Date.now();
	let stopped = false;

	processor.onaudioprocess = (ev) => {
		if (stopped) return;
		const input = ev.inputBuffer.getChannelData(0);
		chunks.push(new Float32Array(input));
	};

	source.connect(processor);
	// Keep graph alive (mute to avoid feedback)
	const gain = ctx.createGain();
	gain.gain.value = 0;
	processor.connect(gain);
	gain.connect(ctx.destination);

	if (ctx.state === "suspended") {
		await ctx.resume();
	}

	return {
		stop: async () => {
			stopped = true;
			const durationMs = Date.now() - startedAt;
			try {
				processor.disconnect();
				source.disconnect();
				gain.disconnect();
			} catch {
				// ignore
			}
			stream.getTracks().forEach((t) => t.stop());
			const sampleRate = ctx.sampleRate || 48000;
			await ctx.close().catch(() => undefined);
			const samples = mergeFloat32(chunks);
			if (samples.length < sampleRate * 0.15) {
				throw new Error("录音太短，请至少说半秒以上");
			}
			const blob = encodeWavMono(samples, sampleRate);
			return { blob, durationMs, sampleRate };
		},
	};
}

/** Convert an audio Blob (webm/mp4/…) to WAV via decodeAudioData when possible. */
export async function blobToWav(blob: Blob): Promise<Blob> {
	if (blob.type.includes("wav") || blob.type.includes("wave")) {
		return blob;
	}
	const AudioCtx =
		window.AudioContext ||
		(window as unknown as { webkitAudioContext: typeof AudioContext })
			.webkitAudioContext;
	const ctx = new AudioCtx();
	try {
		const ab = await blob.arrayBuffer();
		const audio = await ctx.decodeAudioData(ab.slice(0));
		const ch0 = audio.getChannelData(0);
		// downmix if multi-channel
		let samples = new Float32Array(ch0.length);
		if (audio.numberOfChannels === 1) {
			samples = new Float32Array(ch0);
		} else {
			for (let i = 0; i < ch0.length; i++) {
				let sum = 0;
				for (let c = 0; c < audio.numberOfChannels; c++) {
					sum += audio.getChannelData(c)[i] ?? 0;
				}
				samples[i] = sum / audio.numberOfChannels;
			}
		}
		return encodeWavMono(samples, audio.sampleRate);
	} finally {
		await ctx.close().catch(() => undefined);
	}
}


export type RecordFormatPreference = "auto" | "wav" | "webm" | "m4a" | "mp3";

export type NegotiatedRecordFormat = {
	/** Container we will try to produce */
	preference: RecordFormatPreference;
	/** Actual mime for MediaRecorder (empty → browser default) */
	mimeType: string;
	extension: string;
	/** True when we capture via AudioContext→WAV path */
	useWavPipeline: boolean;
	label: string;
};

const MIME_CANDIDATES: Array<{ mime: string; ext: string; kind: string }> = [
	{ mime: "audio/mp4", ext: "m4a", kind: "m4a" },
	{ mime: "audio/webm;codecs=opus", ext: "webm", kind: "webm" },
	{ mime: "audio/webm", ext: "webm", kind: "webm" },
	{ mime: "audio/ogg;codecs=opus", ext: "ogg", kind: "webm" },
	{ mime: "audio/mpeg", ext: "mp3", kind: "mp3" },
];

function isMimeSupported(mime: string): boolean {
	try {
		return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime);
	} catch {
		return false;
	}
}

/**
 * Pick recording format from user preference + browser capability.
 * wav always uses AudioContext pipeline (most STT-friendly).
 */
export function negotiateRecordFormat(
	pref: RecordFormatPreference = "auto",
): NegotiatedRecordFormat {
	if (pref === "wav") {
		return {
			preference: "wav",
			mimeType: "audio/wav",
			extension: "wav",
			useWavPipeline: true,
			label: "WAV (PCM)",
		};
	}

	const wantKind =
		pref === "auto" ? null : pref === "m4a" ? "m4a" : pref === "mp3" ? "mp3" : "webm";

	const ordered =
		pref === "auto"
			? MIME_CANDIDATES
			: [
					...MIME_CANDIDATES.filter((c) => c.kind === wantKind),
					...MIME_CANDIDATES.filter((c) => c.kind !== wantKind),
				];

	for (const c of ordered) {
		if (isMimeSupported(c.mime)) {
			return {
				preference: pref,
				mimeType: c.mime,
				extension: c.ext,
				useWavPipeline: false,
				label: `${c.ext} (${c.mime})`,
			};
		}
	}

	// Fallback: WAV pipeline always works if getUserMedia works
	return {
		preference: pref,
		mimeType: "audio/wav",
		extension: "wav",
		useWavPipeline: true,
		label: "WAV (fallback)",
	};
}

export type MediaRecordHandle = {
	stop: () => Promise<{ blob: Blob; durationMs: number; filename: string }>;
};

/** MediaRecorder capture for webm/m4a/mp3 when supported. */
export async function startMediaRecorderCapture(
	stream: MediaStream,
	negotiated: NegotiatedRecordFormat,
): Promise<MediaRecordHandle> {
	if (negotiated.useWavPipeline) {
		const wav = await startWavCapture(stream);
		return {
			stop: async () => {
				const r = await wav.stop();
				return { blob: r.blob, durationMs: r.durationMs, filename: "audio.wav" };
			},
		};
	}

	const chunks: BlobPart[] = [];
	const opts = negotiated.mimeType ? { mimeType: negotiated.mimeType } : undefined;
	let recorder: MediaRecorder;
	try {
		recorder = opts ? new MediaRecorder(stream, opts) : new MediaRecorder(stream);
	} catch {
		// fallback wav
		const wav = await startWavCapture(stream);
		return {
			stop: async () => {
				const r = await wav.stop();
				return { blob: r.blob, durationMs: r.durationMs, filename: "audio.wav" };
			},
		};
	}

	const startedAt = Date.now();
	recorder.ondataavailable = (ev) => {
		if (ev.data && ev.data.size > 0) chunks.push(ev.data);
	};
	recorder.start(250);

	return {
		stop: () =>
			new Promise((resolve, reject) => {
				const finish = () => {
					stream.getTracks().forEach((t) => t.stop());
					const durationMs = Date.now() - startedAt;
					const mime = recorder.mimeType || negotiated.mimeType || "audio/webm";
					const blob = new Blob(chunks, { type: mime });
					if (blob.size < 200) {
						reject(new Error("录音太短或数据为空"));
						return;
					}
					const ext = negotiated.extension || "webm";
					resolve({ blob, durationMs, filename: `audio.${ext}` });
				};
				recorder.onstop = () => finish();
				recorder.onerror = () => reject(new Error("MediaRecorder 错误"));
				try {
					if (recorder.state !== "inactive") recorder.stop();
					else finish();
				} catch (e) {
					reject(e instanceof Error ? e : new Error(String(e)));
				}
			}),
	};
}

/** Downsample mono float PCM to target rate (e.g. 16000) for STT gateways. */
export function resampleMono(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate || samples.length === 0) return samples;
	const ratio = fromRate / toRate;
	const newLen = Math.max(1, Math.round(samples.length / ratio));
	const out = new Float32Array(newLen);
	for (let i = 0; i < newLen; i++) {
		const src = i * ratio;
		const i0 = Math.floor(src);
		const i1 = Math.min(samples.length - 1, i0 + 1);
		const frac = src - i0;
		out[i] = (samples[i0] ?? 0) * (1 - frac) + (samples[i1] ?? 0) * frac;
	}
	return out;
}

/** Decode any audio blob and re-encode as 16k mono WAV (STT-friendly). */
export async function blobTo16kWav(blob: Blob): Promise<Blob> {
	const AudioCtx =
		window.AudioContext ||
		(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
	const ctx = new AudioCtx();
	try {
		const ab = await blob.arrayBuffer();
		const audio = await ctx.decodeAudioData(ab.slice(0));
		const ch0 = audio.getChannelData(0);
		let samples = new Float32Array(ch0.length);
		if (audio.numberOfChannels === 1) {
			samples = new Float32Array(ch0);
		} else {
			for (let i = 0; i < ch0.length; i++) {
				let sum = 0;
				for (let c = 0; c < audio.numberOfChannels; c++) {
					sum += audio.getChannelData(c)[i] ?? 0;
				}
				samples[i] = sum / audio.numberOfChannels;
			}
		}
		const target = 16000;
		const resampled = resampleMono(samples, audio.sampleRate, target);
		return encodeWavMono(resampled, target);
	} finally {
		await ctx.close().catch(() => undefined);
	}
}
