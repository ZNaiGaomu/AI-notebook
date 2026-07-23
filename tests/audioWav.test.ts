import { describe, expect, it } from "vitest";
import { encodeWavMono, mergeFloat32 } from "../src/infra/audioWav";

describe("audioWav", () => {
	it("merges float chunks", () => {
		const a = new Float32Array([1, 2]);
		const b = new Float32Array([3]);
		const m = mergeFloat32([a, b]);
		expect(Array.from(m)).toEqual([1, 2, 3]);
	});

	it("encodes wav header and size", () => {
		const samples = new Float32Array(100);
		for (let i = 0; i < 100; i++) samples[i] = Math.sin(i / 10) * 0.5;
		const blob = encodeWavMono(samples, 16000);
		expect(blob.type).toBe("audio/wav");
		expect(blob.size).toBe(44 + 100 * 2);
	});
});
