/**
 * Minimal YAML-ish frontmatter parse/serialize for notebook items.
 * Handles flat scalars, string arrays, booleans, numbers. Not a full YAML engine.
 */

export type FmValue = string | number | boolean | string[] | null;

export function parseFrontmatter(content: string): {
	frontmatter: Record<string, FmValue>;
	body: string;
} {
	const normalized = content.replace(/^﻿/, "");
	if (!normalized.startsWith("---")) {
		return { frontmatter: {}, body: normalized };
	}
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) {
		return { frontmatter: {}, body: normalized };
	}
	const yamlBlock = normalized.slice(4, end).trim();
	const body = normalized.slice(end + 4).replace(/^\r?\n/, "");
	return { frontmatter: parseSimpleYaml(yamlBlock), body };
}

export function serializeFrontmatter(
	frontmatter: Record<string, unknown>,
	body: string,
): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(frontmatter)) {
		lines.push(formatYamlLine(key, value));
	}
	lines.push("---");
	const bodyPart = body.startsWith("\n") ? body : `\n${body}`;
	return `${lines.join("\n")}${bodyPart.endsWith("\n") ? bodyPart : `${bodyPart}\n`}`;
}

function parseSimpleYaml(block: string): Record<string, FmValue> {
	const result: Record<string, FmValue> = {};
	const lines = block.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (!line.trim() || line.trim().startsWith("#")) {
			i++;
			continue;
		}
		const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
		if (!m) {
			i++;
			continue;
		}
		const key = m[1] as string;
		const rest = (m[2] ?? "").trim();
		if (rest === "" || rest === "|" || rest === ">") {
			// block / empty → treat following indented list or empty string
			const list: string[] = [];
			let j = i + 1;
			while (j < lines.length) {
				const next = lines[j] ?? "";
				const lm = next.match(/^\s+-\s+(.*)$/);
				if (!lm) break;
				list.push(unquote(lm[1] ?? ""));
				j++;
			}
			if (j > i + 1) {
				result[key] = list;
				i = j;
				continue;
			}
			result[key] = rest === "" ? "" : "";
			i++;
			continue;
		}
		if (rest.startsWith("[") && rest.endsWith("]")) {
			result[key] = parseInlineArray(rest);
			i++;
			continue;
		}
		result[key] = parseScalar(rest);
		i++;
	}
	return result;
}

function parseInlineArray(raw: string): string[] {
	const inner = raw.slice(1, -1).trim();
	if (!inner) return [];
	return inner.split(",").map((s) => unquote(s.trim()));
}

function parseScalar(raw: string): FmValue {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null" || raw === "~") return null;
	if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
	return unquote(raw);
}

function unquote(s: string): string {
	if (
		(s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'"))
	) {
		return s.slice(1, -1);
	}
	return s;
}

function formatYamlLine(key: string, value: unknown): string {
	if (Array.isArray(value)) {
		if (value.length === 0) return `${key}: []`;
		const items = value.map((v) => JSON.stringify(String(v))).join(", ");
		return `${key}: [${items}]`;
	}
	if (typeof value === "boolean" || typeof value === "number") {
		return `${key}: ${value}`;
	}
	if (value === null || value === undefined) {
		return `${key}: null`;
	}
	const s = String(value);
	if (s === "" || /[:#\n\r]/.test(s) || s.startsWith(" ") || s.endsWith(" ")) {
		return `${key}: ${JSON.stringify(s)}`;
	}
	return `${key}: ${s}`;
}

export function asStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((v) => String(v));
	}
	if (typeof value === "string" && value.trim()) {
		return value.split(",").map((s) => s.trim()).filter(Boolean);
	}
	return [];
}
