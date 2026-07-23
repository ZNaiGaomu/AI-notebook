import type { RouteSlot } from "./types";
import { PURPOSE_ROUTE_CHAIN_LEN } from "./types";

const emptySlot = (): RouteSlot => ({ providerId: null, model: null });

/**
 * Normalize legacy single-slot `{ providerId, model }` or array into a fixed-length chain.
 * Empty / invalid entries become null slots (UI shows "跟随默认").
 */
export function normalizeRouteChain(raw: unknown): RouteSlot[] {
	const slots: RouteSlot[] = [];

	if (Array.isArray(raw)) {
		for (const item of raw) {
			slots.push(normalizeSlot(item));
		}
	} else if (raw && typeof raw === "object") {
		const o = raw as Record<string, unknown>;
		// New shape: { chain: [...] }
		if (Array.isArray(o.chain)) {
			for (const item of o.chain) {
				slots.push(normalizeSlot(item));
			}
		} else {
			// Legacy single route: { providerId, model }
			slots.push(normalizeSlot(o));
		}
	}

	// Drop pure-empty trailing slots later; keep first N with content padded
	const trimmed = slots.filter(
		(s, i) =>
			s.providerId ||
			s.model ||
			// keep leading structure only up to last non-empty
			false,
	);
	// Prefer: keep all non-empty in order, then pad to CHAIN_LEN for UI
	const nonEmpty = slots.filter((s) => s.providerId || s.model);
	const out: RouteSlot[] = [];
	for (let i = 0; i < PURPOSE_ROUTE_CHAIN_LEN; i++) {
		out.push(nonEmpty[i] ?? emptySlot());
	}
	// If everything empty, still return 3 nulls
	void trimmed;
	return out;
}

export function normalizeSlot(raw: unknown): RouteSlot {
	if (!raw || typeof raw !== "object") return emptySlot();
	const o = raw as Record<string, unknown>;
	return {
		providerId:
			typeof o.providerId === "string" && o.providerId.trim()
				? o.providerId.trim()
				: null,
		model:
			typeof o.model === "string" && o.model.trim()
				? o.model.trim()
				: null,
	};
}

/** First non-empty slot (legacy-compatible view of a chain). */
export function primarySlot(chain: RouteSlot[] | undefined): RouteSlot {
	if (!chain?.length) return emptySlot();
	for (const s of chain) {
		if (s.providerId || s.model) return s;
	}
	return emptySlot();
}

export function mergeRouteChains(
	base: RouteSlot[],
	patch: RouteSlot[] | undefined,
): RouteSlot[] {
	if (!patch) return normalizeRouteChain(base);
	return normalizeRouteChain(patch.length ? patch : base);
}
