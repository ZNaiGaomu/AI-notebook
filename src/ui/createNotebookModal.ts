import { App, Modal, Notice } from "obsidian";
import type { TemplateId } from "../domain/types";
import { TEMPLATES } from "../domain/templates";
import type AiNotebookPlugin from "../main";

export function defaultNotebookName(templateId: TemplateId): string {
	const label = TEMPLATES.find((tpl) => tpl.id === templateId)?.label;
	return label ? `${label}` : "AI 记录本";
}

export class CreateNotebookModal extends Modal {
	private name = defaultNotebookName("literature");
	private nameTouched = false;
	private templateId: TemplateId = "literature";
	private plugin: AiNotebookPlugin;
	private onCreated: () => void;

	constructor(app: App, plugin: AiNotebookPlugin, onCreated: () => void) {
		super(app);
		this.plugin = plugin;
		this.onCreated = onCreated;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ai-notebook-create-modal");
		contentEl.createEl("h2", { text: "新建 AI 记录本" });

		const nameBlock = contentEl.createDiv({ cls: "ai-notebook-create-name" });
		nameBlock.createEl("label", { text: "记录本名称" });
		const nameInput = nameBlock.createEl("input", {
			type: "text",
			value: this.name,
			placeholder: "例如：文献本",
		});
		nameInput.addEventListener("input", () => {
			this.nameTouched = true;
			this.name = nameInput.value;
		});
		nameInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				void this.createNotebook();
			}
		});
		window.setTimeout(() => {
			nameInput.focus();
			nameInput.select();
		}, 0);

		contentEl.createEl("h3", { text: "选择模板" });
		const grid = contentEl.createDiv({ cls: "template-grid" });
		const cards: HTMLElement[] = [];

		const renderSelection = () => {
			for (const card of cards) {
				card.toggleClass(
					"is-selected",
					card.dataset.templateId === this.templateId,
				);
			}
		};

		const selectTemplate = (templateId: TemplateId) => {
			this.templateId = templateId;
			if (!this.nameTouched || !this.name.trim()) {
				this.name = defaultNotebookName(templateId);
				nameInput.value = this.name;
			}
			renderSelection();
		};

		for (const tpl of TEMPLATES) {
			const card = grid.createDiv({ cls: "template-card" });
			card.dataset.templateId = tpl.id;
			card.tabIndex = 0;
			card.setAttribute("role", "button");
			card.setAttribute("aria-label", `选择模板：${tpl.label}`);
			card.createEl("h4", { text: tpl.label });
			card.createEl("p", { text: tpl.description });
			card.addEventListener("click", () => {
				selectTemplate(tpl.id);
			});
			card.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					selectTemplate(tpl.id);
				}
			});
			cards.push(card);
		}
		renderSelection();

		const actions = contentEl.createDiv({ cls: "ai-notebook-create-actions" });
		const createButton = actions.createEl("button", { text: "创建" });
		createButton.addClass("mod-cta");
		createButton.addEventListener("click", () => {
			void this.createNotebook();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async createNotebook(): Promise<void> {
		try {
			const meta = await this.plugin.notebooks.createNotebook({
				name: this.name.trim() || defaultNotebookName(this.templateId),
				templateId: this.templateId,
			});
			this.plugin.settings = {
				...this.plugin.settings,
				ui: {
					...this.plugin.settings.ui,
					lastNotebookId: meta.notebook_id,
				},
			};
			await this.plugin.saveSettings();
			new Notice(`已创建：${meta.name}`);
			this.close();
			await this.plugin.openNotebook(meta.notebook_id);
			this.onCreated();
		} catch (e) {
			new Notice(`创建失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
