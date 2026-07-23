import { z } from "zod";
import type { Blueprint } from "./types";

const fieldTypeSchema = z.enum([
	"text",
	"markdown",
	"number",
	"date",
	"url",
	"select",
	"multi-select",
	"tags",
	"checkbox",
	"note-ref",
	"file-ref",
]);

const fieldSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	type: fieldTypeSchema,
	required: z.boolean().optional(),
	showInList: z.boolean().optional(),
	options: z.array(z.string()).optional(),
});

const entityTypeSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	fields: z.array(fieldSchema).min(1),
	list: z
		.object({
			sort: z
				.enum(["updated_desc", "updated_asc", "created_desc", "title_asc"])
				.optional(),
			filterFields: z.array(z.string()).optional(),
		})
		.optional(),
});

const hookStepSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("notify"), message: z.string() }),
	z.object({ type: z.literal("ai.extract") }),
	z.object({ type: z.literal("cabinet.attachIfUrl") }),
]);

export const blueprintSchema = z.object({
	$schema: z.literal("ai-notebook-blueprint/v1"),
	blueprintVersion: z.number().int().positive(),
	name: z.string().min(1),
	description: z.string(),
	entityTypes: z.array(entityTypeSchema).min(1),
	views: z.array(
		z.object({
			id: z.string().min(1),
			type: z.enum(["list", "detail", "table", "board"]),
			entityType: z.string().min(1),
		}),
	),
	commands: z.array(
		z.object({
			id: z.string().min(1),
			label: z.string().min(1),
			action: z.enum([
				"openCaptureModal",
				"openChat",
				"openFeatureEdit",
				"refreshList",
			]),
			entityType: z.string().optional(),
		}),
	),
	hooks: z.object({
		onCreate: z.array(hookStepSchema),
	}),
	cabinet: z.object({
		enabled: z.boolean(),
		buckets: z.array(z.enum(["links", "files"])),
	}),
	aiBehaviors: z.object({
		systemHints: z.string(),
		allowedTools: z.array(z.string()),
	}),
	ui: z.object({
		primaryView: z.literal("list"),
		homePrompt: z.string(),
		featureEditPrompt: z.string(),
	}),
});

export type BlueprintParseResult =
	| { ok: true; data: Blueprint }
	| { ok: false; error: string };

export function parseBlueprint(input: unknown): BlueprintParseResult {
	const result = blueprintSchema.safeParse(input);
	if (!result.success) {
		const msg = result.error.issues
			.map((i) => `${i.path.join(".")}: ${i.message}`)
			.join("; ");
		return { ok: false, error: msg };
	}
	return { ok: true, data: result.data as Blueprint };
}

export function assertBlueprint(input: unknown): Blueprint {
	const parsed = parseBlueprint(input);
	if (!parsed.ok) {
		throw new Error(`Invalid blueprint: ${parsed.error}`);
	}
	return parsed.data;
}
