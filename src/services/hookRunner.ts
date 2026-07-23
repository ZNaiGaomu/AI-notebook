import type {
	Blueprint,
	HookStep,
	NotebookItem,
	NotebookMeta,
} from "../domain/types";
import type { CabinetService } from "./cabinetService";
import type { ItemService } from "./itemService";
import type { OrganizeService } from "./organizeService";

export type HookStepResult = {
	type: HookStep["type"];
	ok: boolean;
	detail?: string;
};

export type HookRunResult = {
	item: NotebookItem;
	steps: HookStepResult[];
};

export type HookRunnerDeps = {
	cabinet: CabinetService;
	items: ItemService;
	organize: OrganizeService;
	/** UI Notice adapter; tests inject a collector. */
	notify: (message: string) => void;
};

/**
 * Executes blueprint hooks.onCreate after an item is created.
 * Failures in individual steps are recorded; they do not throw
 * (create already succeeded). ai.extract may update the item in place.
 */
export class HookRunner {
	constructor(private readonly deps: HookRunnerDeps) {}

	async runOnCreate(input: {
		meta: NotebookMeta;
		item: NotebookItem;
		blueprint: Blueprint;
	}): Promise<HookRunResult> {
		const steps: HookStepResult[] = [];
		let item = input.item;
		const hooks = input.blueprint.hooks?.onCreate ?? [];

		for (const step of hooks) {
			const result = await this.runStep(step, input.meta, item, input.blueprint);
			steps.push(result.step);
			if (result.item) item = result.item;
		}

		return { item, steps };
	}

	private async runStep(
		step: HookStep,
		meta: NotebookMeta,
		item: NotebookItem,
		blueprint: Blueprint,
	): Promise<{ step: HookStepResult; item?: NotebookItem }> {
		switch (step.type) {
			case "notify":
				try {
					this.deps.notify(step.message);
					return {
						step: { type: "notify", ok: true, detail: step.message },
					};
				} catch (e) {
					return {
						step: {
							type: "notify",
							ok: false,
							detail: e instanceof Error ? e.message : String(e),
						},
					};
				}

			case "cabinet.attachIfUrl":
				return this.runAttachIfUrl(meta, item);

			case "ai.extract":
				return this.runAiExtract(meta, item, blueprint);

			default: {
				const _exhaustive: never = step;
				return {
					step: {
						type: (_exhaustive as HookStep).type,
						ok: false,
						detail: "未知钩子类型",
					},
				};
			}
		}
	}

	private async runAttachIfUrl(
		meta: NotebookMeta,
		item: NotebookItem,
	): Promise<{ step: HookStepResult; item?: NotebookItem }> {
		try {
			const url = item.frontmatter.url;
			const hasUrl = typeof url === "string" && url.trim().length > 0;
			if (!hasUrl) {
				return {
					step: {
						type: "cabinet.attachIfUrl",
						ok: true,
						detail: "跳过：无 url 字段",
					},
				};
			}
			const link = await this.deps.cabinet.attachIfUrl(meta, {
				item_id: item.frontmatter.item_id,
				url,
				title: item.frontmatter.title,
			});
			// link id into cabinet_refs if not already
			if (link && !item.frontmatter.cabinet_refs.includes(link.id)) {
				const next = await this.deps.items.updateItem(item, {
					fields: {
						cabinet_refs: [...item.frontmatter.cabinet_refs, link.id],
					},
				});
				return {
					step: {
						type: "cabinet.attachIfUrl",
						ok: true,
						detail: link.url,
					},
					item: next,
				};
			}
			return {
				step: {
					type: "cabinet.attachIfUrl",
					ok: true,
					detail: link?.url ?? "已存在",
				},
			};
		} catch (e) {
			return {
				step: {
					type: "cabinet.attachIfUrl",
					ok: false,
					detail: e instanceof Error ? e.message : String(e),
				},
			};
		}
	}

	private async runAiExtract(
		meta: NotebookMeta,
		item: NotebookItem,
		_blueprint: Blueprint,
	): Promise<{ step: HookStepResult; item?: NotebookItem }> {
		try {
			if (item.frontmatter.organized === true) {
				return {
					step: {
						type: "ai.extract",
						ok: true,
						detail: "跳过：条目已结构化",
					},
				};
			}
			const raw = [item.frontmatter.title, item.body]
				.filter(Boolean)
				.join("\n\n")
				.trim();
			if (!raw) {
				return {
					step: {
						type: "ai.extract",
						ok: true,
						detail: "跳过：内容为空",
					},
				};
			}
			const result = await this.deps.organize.organizeText(meta, raw, {
				entityType: item.frontmatter.entity_type,
				sourceHint: "onCreate 钩子 ai.extract",
			});
			if (!result.ok) {
				return {
					step: {
						type: "ai.extract",
						ok: false,
						detail: result.error,
					},
				};
			}
			const body = result.summary
				? `> ${result.summary}\n\n${result.body}`
				: result.body || item.body;
			const updated = await this.deps.items.updateItem(item, {
				title: result.title || item.frontmatter.title,
				body,
				fields: {
					...result.fields,
					organized: true,
				},
			});
			return {
				step: {
					type: "ai.extract",
					ok: true,
					detail: result.title,
				},
				item: updated,
			};
		} catch (e) {
			return {
				step: {
					type: "ai.extract",
					ok: false,
					detail: e instanceof Error ? e.message : String(e),
				},
			};
		}
	}
}
