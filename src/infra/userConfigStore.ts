import type { App } from "obsidian";
import type {
	AiNotebookSettings,
	ProviderProfile,
	PurposeRouting,
} from "../domain/types";

/**
 * Durable user config stored OUTSIDE the plugin install folder:
 *   {vault}/.obsidian/ai-notebook-user.json
 *
 * Survives replacing/copying plugins/ai-notebook/* (main.js etc.).
 */
export const USER_CONFIG_FILENAME = "ai-notebook-user.json";

export type UserDurableConfig = {
	schemaVersion: number;
	providers: ProviderProfile[];
	defaultProviderId: string | null;
	purposeRouting: PurposeRouting;
	/** ISO time last saved */
	updatedAt?: string;
};

export class UserConfigStore {
	constructor(private readonly app: App) {}

	private path(): string {
		// configDir is typically ".obsidian" relative to vault root
		return `${this.app.vault.configDir}/${USER_CONFIG_FILENAME}`;
	}

	async load(): Promise<UserDurableConfig | null> {
		const p = this.path();
		try {
			const exists = await this.app.vault.adapter.exists(p);
			if (!exists) return null;
			const raw = await this.app.vault.adapter.read(p);
			const data = JSON.parse(raw) as Partial<UserDurableConfig>;
			if (!data || typeof data !== "object") return null;
			return {
				schemaVersion: 1,
				providers: Array.isArray(data.providers)
					? data.providers.map(normalizeProvider)
					: [],
				defaultProviderId:
					typeof data.defaultProviderId === "string" ||
					data.defaultProviderId === null
						? (data.defaultProviderId ?? null)
						: null,
				purposeRouting: {
					planner: normalizeRoute(data.purposeRouting?.planner),
					worker: normalizeRoute(data.purposeRouting?.worker),
					voice: normalizeRoute(data.purposeRouting?.voice),
				},
				updatedAt:
					typeof data.updatedAt === "string" ? data.updatedAt : undefined,
			};
		} catch {
			return null;
		}
	}

	async save(config: UserDurableConfig): Promise<void> {
		const p = this.path();
		const payload: UserDurableConfig = {
			schemaVersion: 1,
			providers: config.providers,
			defaultProviderId: config.defaultProviderId,
			purposeRouting: config.purposeRouting,
			updatedAt: new Date().toISOString(),
		};
		await this.app.vault.adapter.write(
			p,
			`${JSON.stringify(payload, null, 2)}\n`,
		);
	}

	/** Merge durable providers into full settings (immutable). */
	mergeIntoSettings(
		settings: AiNotebookSettings,
		durable: UserDurableConfig | null,
	): AiNotebookSettings {
		if (!durable) return settings;
		return {
			...settings,
			providers: durable.providers,
			defaultProviderId: durable.defaultProviderId,
			purposeRouting: durable.purposeRouting,
		};
	}

	extractFromSettings(settings: AiNotebookSettings): UserDurableConfig {
		return {
			schemaVersion: 1,
			providers: settings.providers,
			defaultProviderId: settings.defaultProviderId,
			purposeRouting: settings.purposeRouting,
			updatedAt: new Date().toISOString(),
		};
	}
}

function normalizeRoute(
	route: { providerId?: string | null; model?: string | null } | undefined,
): { providerId: string | null; model: string | null } {
	return {
		providerId:
			typeof route?.providerId === "string" || route?.providerId === null
				? (route?.providerId ?? null)
				: null,
		model:
			typeof route?.model === "string" || route?.model === null
				? (route?.model ?? null)
				: null,
	};
}

function normalizeProvider(p: unknown): ProviderProfile {
	const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
	const models = Array.isArray(o.models)
		? o.models.filter((m): m is string => typeof m === "string" && m.trim() !== "")
		: [];
	return {
		id: typeof o.id === "string" && o.id ? o.id : "",
		name: typeof o.name === "string" ? o.name : "未命名服务商",
		baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : "",
		apiKey: typeof o.apiKey === "string" ? o.apiKey : "",
		models,
		defaultModel:
			typeof o.defaultModel === "string" && o.defaultModel
				? o.defaultModel
				: (models[0] ?? ""),
	};
}
