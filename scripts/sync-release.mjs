/**
 * Sync Obsidian install files into the folder the user loads in Obsidian:
 *   release/ai-notebook/
 *
 * Copies: main.js, styles.css, manifest.json
 * Does NOT touch data.json / user secrets (those live in the vault plugin dir).
 */
import { mkdir, copyFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "release", "ai-notebook");

const FILES = ["main.js", "styles.css", "manifest.json"];

export async function syncRelease(opts = {}) {
	const quiet = Boolean(opts.quiet);
	await mkdir(outDir, { recursive: true });

	const missing = [];
	for (const file of FILES) {
		const src = join(root, file);
		try {
			await access(src);
		} catch {
			missing.push(file);
			continue;
		}
		await copyFile(src, join(outDir, file));
	}

	if (missing.length) {
		const msg = `sync-release: skipped missing: ${missing.join(", ")}`;
		if (!quiet) console.warn(msg);
		return { ok: false, missing, outDir };
	}

	if (!quiet) {
		console.log(`sync-release: → ${outDir}`);
		for (const f of FILES) console.log(`  · ${f}`);
	}
	return { ok: true, missing: [], outDir };
}

// CLI: node scripts/sync-release.mjs
const isMain =
	process.argv[1] &&
	fileURLToPath(import.meta.url).replace(/\\/g, "/") ===
		String(process.argv[1]).replace(/\\/g, "/");

if (isMain || process.argv[1]?.endsWith("sync-release.mjs")) {
	const result = await syncRelease({ quiet: false });
	process.exit(result.ok ? 0 : 1);
}
