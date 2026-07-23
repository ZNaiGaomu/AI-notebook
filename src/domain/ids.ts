/** Generate RFC-like UUID v4 (crypto when available). */
export function createId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

export function shortId(id: string, len = 6): string {
	return id.replace(/-/g, "").slice(0, len);
}

export function todayDatePrefix(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/**
 * Parse client capture time (ISO string or epoch ms) into a Date.
 * Invalid / missing → null.
 */
export function parseCaptureTime(
	raw: string | number | null | undefined,
): Date | null {
	if (raw == null || raw === "") return null;
	if (typeof raw === "number" && Number.isFinite(raw)) {
		const d = new Date(raw);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	const s = String(raw).trim();
	if (!s) return null;
	// pure digits → epoch ms
	if (/^\d{10,13}$/.test(s)) {
		const n = Number(s);
		const ms = s.length <= 10 ? n * 1000 : n;
		const d = new Date(ms);
		return Number.isNaN(d.getTime()) ? null : d;
	}
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Item filename time segment (local wall clock).
 * Fullwidth colon U+FF1A so Windows accepts it, looks like 19:43:58.
 * Example: 2026-07-21-19：43：58
 */
export function dateTimeFilePrefix(at?: Date | null): string {
	const d = at && !Number.isNaN(at.getTime()) ? at : new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	const colon = "："; // fullwidth ：
	return `${y}-${m}-${day}-${hh}${colon}${mm}${colon}${ss}`;
}

/** @deprecated alias — prefer dateTimeFilePrefix(at) */
export function nowDateTimePrefix(): string {
	return dateTimeFilePrefix(new Date());
}

/** Display: 2026-07-21 19:15:30（本地时区） */
export function formatDateTimeLocal(
	isoOrDate: string | Date | number | null | undefined,
): string {
	if (isoOrDate == null || isoOrDate === "") return "";
	const d =
		isoOrDate instanceof Date
			? isoOrDate
			: typeof isoOrDate === "number"
				? new Date(isoOrDate)
				: new Date(isoOrDate);
	if (Number.isNaN(d.getTime())) {
		return String(isoOrDate)
			.replace("T", " ")
			.replace(/\.\d{3}Z?$/, "")
			.slice(0, 19);
	}
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

export function nowIso(): string {
	return new Date().toISOString();
}

/** ISO for a given instant (default now). */
export function toIso(at?: Date | null): string {
	if (at && !Number.isNaN(at.getTime())) return at.toISOString();
	return nowIso();
}
