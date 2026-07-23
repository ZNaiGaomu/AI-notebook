import { App, FuzzySuggestModal, Notice } from "obsidian";
import type { NotebookMeta } from "../domain/types";
import type AiNotebookPlugin from "../main";

export class PickNotebookModal extends FuzzySuggestModal<NotebookMeta> {
	private plugin: AiNotebookPlugin;
	private items: NotebookMeta[] = [];

	constructor(app: App, plugin: AiNotebookPlugin) {
		super(app);
		this.plugin = plugin;
		this.setPlaceholder("选择要打开的 AI 记录本…");
	}

	async openAndLoad(): Promise<void> {
		this.items = await this.plugin.notebooks.listNotebooks();
		if (this.items.length === 0) {
			new Notice("还没有记录本，请先新建");
			return;
		}
		this.open();
	}

	getItems(): NotebookMeta[] {
		return this.items;
	}

	getItemText(item: NotebookMeta): string {
		return `${item.name}  (v${item.current_blueprint})`;
	}

	onChooseItem(item: NotebookMeta): void {
		void this.plugin.openNotebook(item.notebook_id);
	}
}
