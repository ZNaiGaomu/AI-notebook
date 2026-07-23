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
