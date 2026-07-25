/**
 * Minimal ZIP reader for plugin install packages.
 * Supports STORE (0) and DEFLATE (8). Pure browser / Electron APIs only.
 */

export type ZipEntry = {
	name: string;
	data: Uint8Array;
};

function u16(v: DataView, o: number): number {
	return v.getUint16(o, true);
}
function u32(v: DataView, o: number): number {
	return v.getUint32(o, true);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	// CompressionStream / DecompressionStream: deflate-raw = zip's method 8
	if (typeof DecompressionStream !== "undefined") {
		const ds = new DecompressionStream("deflate-raw");
		const copy = Uint8Array.from(data);
		const stream = new Blob([copy]).stream().pipeThrough(ds);
		const ab = await new Response(stream).arrayBuffer();
		return new Uint8Array(ab);
	}
	throw new Error("当前环境不支持解压 ZIP（缺少 DecompressionStream）");
}

/**
 * Parse a zip ArrayBuffer and return entries (paths use forward slashes).
 */
export async function unzipEntries(buf: ArrayBuffer): Promise<ZipEntry[]> {
	const bytes = new Uint8Array(buf);
	const view = new DataView(buf);
	const entries: ZipEntry[] = [];
	let offset = 0;

	while (offset + 30 <= bytes.length) {
		const sig = u32(view, offset);
		if (sig !== 0x04034b50) break; // local file header

		const method = u16(view, offset + 8);
		const compSize = u32(view, offset + 18);
		const uncompSize = u32(view, offset + 22);
		const nameLen = u16(view, offset + 26);
		const extraLen = u16(view, offset + 28);
		const nameStart = offset + 30;
		const nameEnd = nameStart + nameLen;
		const dataStart = nameEnd + extraLen;
		const dataEnd = dataStart + compSize;

		if (dataEnd > bytes.length) {
			throw new Error("ZIP 文件截断或不完整");
		}

		const nameBytes = bytes.subarray(nameStart, nameEnd);
		const name = new TextDecoder("utf-8").decode(nameBytes).replace(/\\/g, "/");
		const payload = bytes.subarray(dataStart, dataEnd);

		// skip directories
		if (!name.endsWith("/")) {
			let data: Uint8Array;
			if (method === 0) {
				data = payload.slice();
			} else if (method === 8) {
				data = await inflateRaw(payload);
				if (uncompSize && data.length !== uncompSize && uncompSize !== 0xffffffff) {
					// tolerate mismatch (zip64 / sparse flags) if inflate succeeded
				}
			} else {
				throw new Error(`不支持的 ZIP 压缩方式: ${method}（文件 ${name}）`);
			}
			entries.push({ name, data });
		}

		offset = dataEnd;
	}

	if (!entries.length) {
		throw new Error("ZIP 中没有文件条目");
	}
	return entries;
}

/**
 * Find runtime plugin files in a zip (main.js / manifest.json / styles.css),
 * ignoring nested folder prefixes (e.g. release/ai-notebook/main.js).
 */
export function pickPluginRuntimeFiles(
	entries: ZipEntry[],
): { mainJs?: Uint8Array; manifest?: Uint8Array; styles?: Uint8Array } {
	const want = ["main.js", "manifest.json", "styles.css"] as const;
	const found: Record<string, Uint8Array> = {};

	const score = (path: string, base: string): number => {
		const n = path.replace(/\\/g, "/");
		if (!n.endsWith("/" + base) && n !== base) return -1;
		// prefer shorter / release/ai-notebook paths
		let s = 100 - n.length;
		if (n.includes("release/ai-notebook")) s += 50;
		if (n.includes("ai-notebook")) s += 20;
		if (n.split("/").length <= 2) s += 10;
		return s;
	};

	for (const base of want) {
		let best: { s: number; data: Uint8Array } | null = null;
		for (const e of entries) {
			const s = score(e.name, base);
			if (s < 0) continue;
			if (!best || s > best.s) best = { s, data: e.data };
		}
		if (best) found[base] = best.data;
	}

	return {
		mainJs: found["main.js"],
		manifest: found["manifest.json"],
		styles: found["styles.css"],
	};
}
