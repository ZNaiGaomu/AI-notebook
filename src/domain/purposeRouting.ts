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

	// Keep ALL slots from settings (including empty rows user added via +).
	// Only pad up to PURPOSE_ROUTE_CHAIN_LEN when shorter; never truncate.
	const out: RouteSlot[] = slots.length ? [...slots] : [];
	while (out.length < PURPOSE_ROUTE_CHAIN_LEN) {
		out.push(emptySlot());
	}
	return out;
}

export function normalizeSlot(raw: unknown): RouteSlot {
	if (!raw || typeof raw !== "object") return emptySlot();
	const o = raw as Record<string, unknown>;
	const modelPriority = normalizeSlotPriority(o.modelPriority);
	return {
		providerId:
			typeof o.providerId === "string" && o.providerId.trim()
				? o.providerId.trim()
				: null,
		model:
			typeof o.model === "string" && o.model.trim()
				? o.model.trim()
				: null,
		...(modelPriority ? { modelPriority } : {}),
	};
}

function normalizeSlotPriority(
	raw: unknown,
): Record<string, number> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const used = new Set<number>();
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		const n = typeof v === "number" ? v : Number(v);
		if (!k.trim() || !Number.isFinite(n) || n < 1) continue;
		const prio = Math.floor(n);
		if (used.has(prio)) continue;
		used.add(prio);
		out[k.trim()] = prio;
	}
	return Object.keys(out).length ? out : undefined;
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
