import type { Blueprint, BlueprintField } from "../domain/types";
import {
	availableItemViewModes,
	primaryEntityId as resolvePrimaryEntityId,
	resolveBoardColumnField,
	resolveItemViewMode,
} from "./listQuery";

/**
 * Resolves fields, commands, and view preferences from blueprint.
 * Hot-reload is simply reloading blueprint JSON; UI re-renders from this.
 */
export class CapabilityRuntime {
	private blueprint: Blueprint | null = null;

	load(blueprint: Blueprint): void {
		this.blueprint = blueprint;
	}

	clear(): void {
		this.blueprint = null;
	}

	getBlueprint(): Blueprint | null {
		return this.blueprint;
	}

	primaryEntityId(): string | null {
		if (!this.blueprint) return null;
		return resolvePrimaryEntityId(this.blueprint);
	}

	fieldsFor(entityTypeId?: string): BlueprintField[] {
		if (!this.blueprint) return [];
		const entity =
			this.blueprint.entityTypes.find((e) => e.id === entityTypeId) ??
			this.blueprint.entityTypes[0];
		return entity?.fields ?? [];
	}

	listColumns(entityTypeId?: string): BlueprintField[] {
		const fields = this.fieldsFor(entityTypeId);
		const shown = fields.filter((f) => f.showInList);
		return shown.length > 0 ? shown : fields.slice(0, 3);
	}

	filterFields(entityTypeId?: string): BlueprintField[] {
		if (!this.blueprint) return [];
		const entity =
			this.blueprint.entityTypes.find((e) => e.id === entityTypeId) ??
			this.blueprint.entityTypes[0];
		const ids = entity?.list?.filterFields ?? [];
		return ids
			.map((id) => entity?.fields.find((f) => f.id === id))
			.filter((f): f is BlueprintField => Boolean(f));
	}

	defaultItemViewMode(): "list" | "table" | "board" {
		if (!this.blueprint) return "list";
		return resolveItemViewMode(this.blueprint);
	}

	availableItemViewModes(): Array<"list" | "table" | "board"> {
		if (!this.blueprint) return ["list"];
		return availableItemViewModes(this.blueprint);
	}

	boardColumn(entityTypeId?: string) {
		if (!this.blueprint) return null;
		return resolveBoardColumnField(this.blueprint, entityTypeId);
	}

	commands(): Blueprint["commands"] {
		return this.blueprint?.commands ?? [];
	}

	onCreateHooks(): Blueprint["hooks"]["onCreate"] {
		return this.blueprint?.hooks?.onCreate ?? [];
	}
}
