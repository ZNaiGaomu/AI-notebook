/** Minimal mock for vitest — real Obsidian injects these at runtime. */

export function requestUrl(_opts: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}): Promise<{ status: number; text: string }> {
	// Force httpClient to fall back to fetch in unit tests
	return Promise.reject(new Error("obsidian mock: use fetch"));
}

export class Notice {
	constructor(_msg: string) {}
}

export class Plugin {}
export class ItemView {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {
	constructor(_el: unknown) {}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	addText() {
		return this;
	}
	addButton() {
		return this;
	}
	addToggle() {
		return this;
	}
	addDropdown() {
		return this;
	}
	addTextArea() {
		return this;
	}
}

export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export class WorkspaceLeaf {}
export class FuzzySuggestModal {}
export const Platform = { isDesktopApp: true };
export function normalizePath(p: string) {
	return p.replace(/\\/g, "/");
}
