import { App, FuzzySuggestModal, TFile } from "obsidian";

/**
 * Pick an existing file from the vault to register in the cabinet.
 */
export class VaultFileSuggestModal extends FuzzySuggestModal<TFile> {
	private onPick: (file: TFile) => void;

	constructor(app: App, onPick: (file: TFile) => void) {
		super(app);
		this.onPick = onPick;
		this.setPlaceholder("搜索 vault 中的文件…");
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}

/**
 * Open a system file picker and read selected files as ArrayBuffers.
 */
export function pickLocalFiles(opts?: {
	multiple?: boolean;
	accept?: string;
}): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = opts?.multiple !== false;
		if (opts?.accept) input.accept = opts.accept;
		input.style.display = "none";
		document.body.appendChild(input);
		const cleanup = () => {
			input.remove();
		};
		input.addEventListener("change", () => {
			const list = input.files ? Array.from(input.files) : [];
			cleanup();
			resolve(list);
		});
		// cancel: no reliable event; resolve empty after window focus delayed is fragile — leave empty on cancel via blur heuristic
		window.setTimeout(() => {
			// if user cancelled, change may never fire; keep node until change
		}, 0);
		input.click();
	});
}
