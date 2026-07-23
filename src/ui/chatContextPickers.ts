import { App, FuzzySuggestModal, Notice } from "obsidian";
import type { NotebookItem, NotebookMeta } from "../domain/types";
import type AiNotebookPlugin from "../main";

/** Pick a notebook (for chat float). */
export class ChatPickNotebookModal extends FuzzySuggestModal<NotebookMeta> {
	private items: NotebookMeta[] = [];
	private onPick: (meta: NotebookMeta) => void;

	constructor(
		app: App,
		private readonly plugin: AiNotebookPlugin,
		onPick: (meta: NotebookMeta) => void,
	) {
		super(app);
		this.onPick = onPick;
		this.setPlaceholder("选择记录本…");
	}

	async openAndLoad(): Promise<void> {
		this.items = await this.plugin.notebooks.listNotebooks();
		if (this.items.length === 0) {
			new Notice("还没有记录本");
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
		this.onPick(item);
	}
}

/** Pick an item within current notebook (for chat float). */
export class ChatPickItemModal extends FuzzySuggestModal<NotebookItem> {
	constructor(
		app: App,
		private readonly items: NotebookItem[],
		private readonly onPick: (item: NotebookItem) => void,
	) {
		super(app);
		this.setPlaceholder("选择条目…");
	}

	getItems(): NotebookItem[] {
		return this.items;
	}

	getItemText(item: NotebookItem): string {
		const title = item.frontmatter.title || "未命名";
		const id = item.frontmatter.item_id.slice(0, 8);
		return `${title}  (${id}…)`;
	}

	onChooseItem(item: NotebookItem): void {
		this.onPick(item);
	}
}
