import type {
	Blueprint,
	BlueprintIndex,
	BlueprintVersionMeta,
	AiNotebookSettings,
} from "../domain/types";
import { assertBlueprint } from "../domain/blueprintSchema";
import { nowIso } from "../domain/ids";
import {
	blueprintFilePath,
	blueprintIndexPath,
} from "../infra/paths";
import type { IVaultFs } from "../infra/vaultPort";

export type DiffLine = {
	kind: "add" | "remove" | "change" | "info";
	text: string;
};

export class VersionService {
	constructor(
		private readonly vault: IVaultFs,
		private readonly getSettings: () => AiNotebookSettings,
	) {}

	async loadIndex(folderName: string): Promise<BlueprintIndex> {
		const settings = this.getSettings();
		const path = blueprintIndexPath(settings, folderName);
		return this.vault.readJson<BlueprintIndex>(path);
	}

	async loadBlueprint(
		folderName: string,
		version: number,
	): Promise<Blueprint> {
		const settings = this.getSettings();
		const path = blueprintFilePath(settings, folderName, version);
		const raw = await this.vault.readJson<unknown>(path);
		return assertBlueprint(raw);
	}

	async loadCurrentBlueprint(folderName: string): Promise<{
		index: BlueprintIndex;
		blueprint: Blueprint;
	}> {
		const index = await this.loadIndex(folderName);
		const blueprint = await this.loadBlueprint(folderName, index.current);
		return { index, blueprint };
	}

	/**
	 * Commit a full blueprint as a new version (after validation).
	 * Automatically attaches changeDetails from parent → new diff when not provided.
	 */
	async commit(
		folderName: string,
		notebookId: string,
		blueprint: Blueprint,
		meta: {
			author: BlueprintVersionMeta["author"];
			changeSummary: string;
			sourcePrompt?: string | null;
			restoredFrom?: number;
			/** 可选；不传则与父版本 diff 自动生成 */
			changeDetails?: string[];
		},
	): Promise<{ version: number; blueprint: Blueprint }> {
		assertBlueprint(blueprint);
		const settings = this.getSettings();
		let index: BlueprintIndex;
		try {
			index = await this.loadIndex(folderName);
		} catch {
			index = { notebook_id: notebookId, current: 0, versions: [] };
		}
		const parentVersion = index.current > 0 ? index.current : null;
		const version = (index.current || 0) + 1;
		const file = `v${String(version).padStart(4, "0")}.json`;
		const toWrite: Blueprint = {
			...blueprint,
			blueprintVersion: version,
		};
		assertBlueprint(toWrite);

		let changeDetails = meta.changeDetails;
		if (!changeDetails || changeDetails.length === 0) {
			if (parentVersion != null) {
				try {
					const parentBp = await this.loadBlueprint(folderName, parentVersion);
					changeDetails = this.humanizeDiff(
						this.diffBlueprints(parentBp, toWrite),
					);
				} catch {
					changeDetails = [meta.changeSummary];
				}
			} else {
				changeDetails = this.describeInitialBlueprint(toWrite, meta.changeSummary);
			}
		}

		const versionMeta: BlueprintVersionMeta = {
			version,
			file,
			createdAt: nowIso(),
			author: meta.author,
			sourcePrompt: meta.sourcePrompt ?? null,
			changeSummary: meta.changeSummary,
			changeDetails,
			parentVersion,
			...(meta.restoredFrom != null
				? { restoredFrom: meta.restoredFrom }
				: {}),
		};

		const newIndex: BlueprintIndex = {
			notebook_id: notebookId,
			current: version,
			versions: [...index.versions, versionMeta],
		};

		await this.vault.writeJson(
			blueprintFilePath(settings, folderName, version),
			toWrite,
		);
		await this.vault.writeJson(blueprintIndexPath(settings, folderName), newIndex);
		return { version, blueprint: toWrite };
	}

	async restore(
		folderName: string,
		notebookId: string,
		targetVersion: number,
	): Promise<{ version: number; blueprint: Blueprint }> {
		const old = await this.loadBlueprint(folderName, targetVersion);
		const { index } = await this.loadCurrentBlueprint(folderName);
		let details: string[] | undefined;
		try {
			const current = await this.loadBlueprint(folderName, index.current);
			details = [
				`恢复功能配置为 v${targetVersion} 的内容`,
				...this.humanizeDiff(this.diffBlueprints(current, old)),
			];
		} catch {
			details = [`恢复功能配置为 v${targetVersion} 的内容`];
		}
		return this.commit(folderName, notebookId, old, {
			author: "user-restore",
			changeSummary: `恢复自 v${targetVersion}`,
			restoredFrom: targetVersion,
			changeDetails: details,
		});
	}

	/**
	 * Structural + hooks/views/ai/ui diff between two blueprints.
	 */
	diffBlueprints(a: Blueprint, b: Blueprint): DiffLine[] {
		const lines: DiffLine[] = [];
		if (a.name !== b.name) {
			lines.push({ kind: "change", text: `名称: "${a.name}" → "${b.name}"` });
		}
		if (a.description !== b.description) {
			lines.push({ kind: "change", text: "描述文案有更新" });
		}

		const aEntities = new Map(a.entityTypes.map((e) => [e.id, e]));
		const bEntities = new Map(b.entityTypes.map((e) => [e.id, e]));
		for (const id of bEntities.keys()) {
			if (!aEntities.has(id)) {
				const e = bEntities.get(id)!;
				lines.push({
					kind: "add",
					text: `实体类型 + ${e.label}（${id}）`,
				});
			}
		}
		for (const id of aEntities.keys()) {
			if (!bEntities.has(id)) {
				const e = aEntities.get(id)!;
				lines.push({
					kind: "remove",
					text: `实体类型 - ${e.label}（${id}）`,
				});
			}
		}
		for (const [id, be] of bEntities) {
			const ae = aEntities.get(id);
			if (!ae) continue;
			if (ae.label !== be.label) {
				lines.push({
					kind: "change",
					text: `实体「${id}」名称: ${ae.label} → ${be.label}`,
				});
			}
			if ((ae.list?.sort ?? "") !== (be.list?.sort ?? "")) {
				lines.push({
					kind: "change",
					text: `实体「${id}」列表排序: ${ae.list?.sort ?? "默认"} → ${be.list?.sort ?? "默认"}`,
				});
			}
			const aFilters = (ae.list?.filterFields ?? []).join(",");
			const bFilters = (be.list?.filterFields ?? []).join(",");
			if (aFilters !== bFilters) {
				lines.push({
					kind: "change",
					text: `实体「${id}」筛选项: [${aFilters || "无"}] → [${bFilters || "无"}]`,
				});
			}

			const aFields = new Map(ae.fields.map((f) => [f.id, f]));
			const bFields = new Map(be.fields.map((f) => [f.id, f]));
			for (const [fid, bf] of bFields) {
				if (!aFields.has(fid)) {
					lines.push({
						kind: "add",
						text: `字段 + ${bf.label}（${id}.${fid}, ${bf.type}）`,
					});
				}
			}
			for (const [fid, af] of aFields) {
				if (!bFields.has(fid)) {
					lines.push({
						kind: "remove",
						text: `字段 - ${af.label}（${id}.${fid}）`,
					});
				}
			}
			for (const [fid, bf] of bFields) {
				const af = aFields.get(fid);
				if (!af) continue;
				const bits: string[] = [];
				if (af.type !== bf.type) bits.push(`类型 ${af.type}→${bf.type}`);
				if (af.label !== bf.label) bits.push(`标签 ${af.label}→${bf.label}`);
				if (Boolean(af.required) !== Boolean(bf.required)) {
					bits.push(bf.required ? "设为必填" : "取消必填");
				}
				if (Boolean(af.showInList) !== Boolean(bf.showInList)) {
					bits.push(bf.showInList ? "显示在列表" : "列表中隐藏");
				}
				const ao = (af.options ?? []).join("|");
				const bo = (bf.options ?? []).join("|");
				if (ao !== bo) bits.push(`选项 [${ao || "无"}]→[${bo || "无"}]`);
				if (bits.length) {
					lines.push({
						kind: "change",
						text: `字段 ~ ${id}.${fid}: ${bits.join("；")}`,
					});
				}
			}
		}

		// views
		const viewKey = (v: Blueprint["views"][number]) =>
			`${v.id}:${v.type}:${v.entityType}`;
		const aViews = new Set(a.views.map(viewKey));
		const bViews = new Set(b.views.map(viewKey));
		for (const v of b.views) {
			const k = viewKey(v);
			if (!aViews.has(k)) {
				lines.push({
					kind: "add",
					text: `视图 + ${viewTypeLabel(v.type)}（${v.id} → ${v.entityType}）`,
				});
			}
		}
		for (const v of a.views) {
			const k = viewKey(v);
			if (!bViews.has(k)) {
				lines.push({
					kind: "remove",
					text: `视图 - ${viewTypeLabel(v.type)}（${v.id}）`,
				});
			}
		}

		// commands
		const aCmd = new Map(a.commands.map((c) => [c.id, c]));
		const bCmd = new Map(b.commands.map((c) => [c.id, c]));
		for (const [id, c] of bCmd) {
			if (!aCmd.has(id)) {
				lines.push({ kind: "add", text: `命令 + ${c.label}（${id}）` });
			}
		}
		for (const [id, c] of aCmd) {
			if (!bCmd.has(id)) {
				lines.push({ kind: "remove", text: `命令 - ${c.label}（${id}）` });
			}
		}

		// hooks
		const hookKey = (h: Blueprint["hooks"]["onCreate"][number]) =>
			h.type === "notify" ? `notify:${h.message}` : h.type;
		const aHooks = a.hooks.onCreate.map(hookKey);
		const bHooks = b.hooks.onCreate.map(hookKey);
		for (const h of b.hooks.onCreate) {
			const k = hookKey(h);
			if (!aHooks.includes(k)) {
				lines.push({
					kind: "add",
					text: `创建钩子 + ${hookLabel(h)}`,
				});
			}
		}
		for (const h of a.hooks.onCreate) {
			const k = hookKey(h);
			if (!bHooks.includes(k)) {
				lines.push({
					kind: "remove",
					text: `创建钩子 - ${hookLabel(h)}`,
				});
			}
		}

		// cabinet
		if (a.cabinet.enabled !== b.cabinet.enabled) {
			lines.push({
				kind: "change",
				text: b.cabinet.enabled ? "开启收藏柜" : "关闭收藏柜",
			});
		}
		const aBuckets = [...a.cabinet.buckets].sort().join(",");
		const bBuckets = [...b.cabinet.buckets].sort().join(",");
		if (aBuckets !== bBuckets) {
			lines.push({
				kind: "change",
				text: `收藏柜分桶: [${aBuckets}] → [${bBuckets}]`,
			});
		}

		// ai / ui prompts (short)
		if (a.aiBehaviors.systemHints !== b.aiBehaviors.systemHints) {
			lines.push({ kind: "change", text: "AI 系统提示词有更新" });
		}
		const aTools = [...a.aiBehaviors.allowedTools].sort().join(",");
		const bTools = [...b.aiBehaviors.allowedTools].sort().join(",");
		if (aTools !== bTools) {
			lines.push({
				kind: "change",
				text: `AI 工具白名单: [${aTools}] → [${bTools}]`,
			});
		}
		if (a.ui.homePrompt !== b.ui.homePrompt) {
			lines.push({ kind: "change", text: "助手首页提示语有更新" });
		}
		if (a.ui.featureEditPrompt !== b.ui.featureEditPrompt) {
			lines.push({ kind: "change", text: "改功能提示语有更新" });
		}

		if (lines.length === 0) {
			lines.push({ kind: "info", text: "无结构性差异（或仅空白/格式变化）" });
		}
		return lines;
	}

	/** DiffLine[] → 用户可读的改动详情列表（diff 文案已是中文，原样整理） */
	humanizeDiff(lines: DiffLine[]): string[] {
		const out = lines
			.filter((l) => !(l.kind === "info" && lines.length > 1))
			.map((l) => l.text);
		return out.length ? out : ["无明细"];
	}

	describeInitialBlueprint(bp: Blueprint, summary: string): string[] {
		const details: string[] = [summary];
		for (const e of bp.entityTypes) {
			details.push(
				`实体「${e.label}」字段: ${e.fields.map((f) => f.label).join("、")}`,
			);
			if (e.list?.sort) details.push(`默认排序: ${e.list.sort}`);
			if (e.list?.filterFields?.length) {
				details.push(`可筛字段: ${e.list.filterFields.join("、")}`);
			}
		}
		const viewTypes = [...new Set(bp.views.map((v) => viewTypeLabel(v.type)))];
		if (viewTypes.length) details.push(`视图: ${viewTypes.join("、")}`);
		if (bp.cabinet.enabled) details.push("收藏柜: 已开启");
		const hooks = bp.hooks.onCreate.map(hookLabel);
		if (hooks.length) details.push(`创建钩子: ${hooks.join("、")}`);
		return details;
	}

	/**
	 * For old index entries without changeDetails: compute from adjacent blueprint files.
	 */
	async resolveChangeDetails(
		folderName: string,
		meta: BlueprintVersionMeta,
	): Promise<string[]> {
		if (meta.changeDetails && meta.changeDetails.length > 0) {
			return meta.changeDetails;
		}
		try {
			const bp = await this.loadBlueprint(folderName, meta.version);
			if (meta.parentVersion == null) {
				return this.describeInitialBlueprint(bp, meta.changeSummary);
			}
			const parent = await this.loadBlueprint(folderName, meta.parentVersion);
			return this.humanizeDiff(this.diffBlueprints(parent, bp));
		} catch {
			return [meta.changeSummary];
		}
	}
}

function viewTypeLabel(t: string): string {
	switch (t) {
		case "list":
			return "列表";
		case "table":
			return "表格";
		case "board":
			return "看板";
		case "detail":
			return "详情";
		default:
			return t;
	}
}

function hookLabel(h: Blueprint["hooks"]["onCreate"][number]): string {
	switch (h.type) {
		case "notify":
			return `通知「${h.message}」`;
		case "ai.extract":
			return "AI 抽取字段";
		case "cabinet.attachIfUrl":
			return "有 URL 时写入收藏柜";
		default:
			return (h as { type: string }).type;
	}
}
