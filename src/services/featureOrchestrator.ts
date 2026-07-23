import { assertBlueprint, parseBlueprint } from "../domain/blueprintSchema";
import type {
	AiNotebookSettings,
	Blueprint,
	ProviderProfile,
} from "../domain/types";
import type { ChatMessage } from "../infra/aiGateway";
import {
	resolveProviderChain,
	type Purpose,
} from "./providerResolver";

/** Minimal gateway surface for orchestration (class or mock). */
export type ChatGateway = {
	chat(
		profile: ProviderProfile,
		model: string,
		messages: ChatMessage[],
		opts?: { maxTokens?: number; temperature?: number },
	): Promise<
		| { ok: true; content: string; raw: unknown }
		| { ok: false; error: string }
	>;
};
import type { DiffLine, VersionService } from "./versionService";

export type FeatureChangePlan = {
	blueprint: Blueprint;
	changeSummary: string;
	diff: DiffLine[];
	rawModelText: string;
};

export type OrchestrateResult =
	| { ok: true; plan: FeatureChangePlan }
	| { ok: false; error: string };

const SYSTEM_PROMPT = `你是 Obsidian 插件「AI 记录本」的功能配置编译器。
用户会用自然语言描述想要如何修改记录本功能。
你必须输出**一个 JSON 对象**（不要 Markdown 代码围栏以外的解释），格式：
{
  "changeSummary": "一句话中文摘要",
  "blueprint": { ...完整蓝图... }
}

蓝图必须符合：
- "$schema": "ai-notebook-blueprint/v1"
- blueprintVersion: 数字（可沿用当前值，系统会重写）
- name, description: string
- entityTypes: 至少 1 个；fields 的 type 只能是:
  text|markdown|number|date|url|select|multi-select|tags|checkbox|note-ref|file-ref
- select/multi-select 必须带 options: string[]
- views: [{ id, type: "list"|"detail"|"table"|"board", entityType }]
- commands: action 只能是 openCaptureModal|openChat|openFeatureEdit|refreshList
- hooks.onCreate: 步骤 type 只能是 notify|ai.extract|cabinet.attachIfUrl
- cabinet: { enabled: boolean, buckets: ["links","files"] 的子集 }
- aiBehaviors: { systemHints, allowedTools: string[] }
- ui: { primaryView: "list", homePrompt, featureEditPrompt }

规则：
1. 在**当前蓝图**基础上修改，不要无故删除用户已有字段（除非用户明确要求删除）。
2. 字段 id 使用稳定英文 snake/camel，label 可用中文。
3. 只输出 JSON 对象。`;

export class FeatureOrchestrator {
	constructor(
		private readonly gateway: ChatGateway,
		private readonly versions: VersionService,
		private readonly getSettings: () => AiNotebookSettings,
		private readonly resolveProvider: (
			purpose: Purpose,
		) => { profile: ProviderProfile; model: string } | null,
	) {}

	/**
	 * Call AI to produce a new blueprint from natural language.
	 * Does NOT commit; caller must confirm then commit.
	 * Tries purposeRouting.planner chain (顺序1→2→3) on request failure.
	 */
	async propose(
		folderName: string,
		userInstruction: string,
		opts?: { maxRetries?: number },
	): Promise<OrchestrateResult> {
		const instruction = userInstruction.trim();
		if (!instruction) {
			return { ok: false, error: "请输入要修改的功能描述" };
		}

		const settings = this.getSettings();
		const chain = resolveProviderChain(settings, "planner", null);
		const fallback = this.resolveProvider("planner");
		const candidates =
			chain.length > 0
				? chain
				: fallback
					? [{ ...fallback, slotIndex: 1 }]
					: [];

		if (candidates.length === 0) {
			return {
				ok: false,
				error: "未配置 AI Provider。请先在设置中添加 Base URL、API Key 与模型。",
			};
		}

		const { blueprint: current } =
			await this.versions.loadCurrentBlueprint(folderName);

		const maxRetries = opts?.maxRetries ?? 2;
		let lastError = "";
		let lastRaw = "";
		const tried: string[] = [];

		for (const resolved of candidates) {
			tried.push(`${resolved.profile.name}/${resolved.model}`);
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				const messages: ChatMessage[] = [
					{ role: "system", content: SYSTEM_PROMPT },
					{
						role: "user",
						content: [
							"## 当前蓝图",
							JSON.stringify(current, null, 2),
							"",
							"## 用户修改要求",
							instruction,
							attempt > 0
								? `\n## 上次输出校验失败，请修正后重新输出完整 JSON\n${lastError}`
								: "",
						].join("\n"),
					},
				];

				const chat = await this.gateway.chat(
					resolved.profile,
					resolved.model,
					messages,
					{ maxTokens: 4096, temperature: 0.2 },
				);
				if (!chat.ok) {
					lastError = `AI 请求失败: ${chat.error}`;
					// try next provider in chain
					break;
				}
				lastRaw = chat.content;
				const extracted = extractJsonObject(chat.content);
				if (!extracted.ok) {
					lastError = extracted.error;
					continue;
				}

				const summary =
					typeof extracted.value.changeSummary === "string"
						? extracted.value.changeSummary
						: "AI 更新功能配置";
				const bpRaw = extracted.value.blueprint ?? extracted.value;
				const candidate =
					bpRaw && typeof bpRaw === "object" && "$schema" in (bpRaw as object)
						? bpRaw
						: extracted.value.blueprint;

				if (!candidate) {
					lastError = "JSON 中缺少 blueprint 字段";
					continue;
				}

				const normalized = {
					...(candidate as object),
					$schema: "ai-notebook-blueprint/v1",
					blueprintVersion:
						typeof (candidate as Blueprint).blueprintVersion === "number"
							? (candidate as Blueprint).blueprintVersion
							: current.blueprintVersion,
					ui: {
						primaryView: "list",
						homePrompt:
							(candidate as Blueprint).ui?.homePrompt ?? current.ui.homePrompt,
						featureEditPrompt:
							(candidate as Blueprint).ui?.featureEditPrompt ??
							current.ui.featureEditPrompt,
					},
				};

				const parsed = parseBlueprint(normalized);
				if (!parsed.ok) {
					lastError = parsed.error;
					continue;
				}

				const blueprint = assertBlueprint(parsed.data);
				const diff = this.versions.diffBlueprints(current, blueprint);
				return {
					ok: true,
					plan: {
						blueprint,
						changeSummary: summary,
						diff,
						rawModelText: lastRaw,
					},
				};
			}
		}

		return {
			ok: false,
			error: `AI 输出的蓝图未通过校验（已试 ${tried.join(" → ") || "无模型"}）: ${lastError}`,
		};
	}

	/**
	 * After user confirms: commit as new version.
	 */
	async apply(
		folderName: string,
		notebookId: string,
		plan: FeatureChangePlan,
		sourcePrompt: string,
	): Promise<{ version: number; blueprint: Blueprint }> {
		const changeDetails = this.versions.humanizeDiff(plan.diff);
		return this.versions.commit(folderName, notebookId, plan.blueprint, {
			author: "ai",
			changeSummary: plan.changeSummary,
			sourcePrompt,
			changeDetails:
				changeDetails.length > 0
					? changeDetails
					: [plan.changeSummary],
		});
	}
}

function extractJsonObject(
	text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
	const trimmed = text.trim();
	// strip ```json fences
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = fence ? fence[1]!.trim() : trimmed;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) {
		return { ok: false, error: "响应中未找到 JSON 对象" };
	}
	const slice = body.slice(start, end + 1);
	try {
		const value = JSON.parse(slice) as Record<string, unknown>;
		return { ok: true, value };
	} catch (e) {
		return {
			ok: false,
			error: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}
