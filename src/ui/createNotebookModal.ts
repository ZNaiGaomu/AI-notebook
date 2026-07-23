import { App, Modal, Notice, Setting } from "obsidian";
import type { TemplateId } from "../domain/types";
import { TEMPLATES } from "../domain/templates";
import type AiNotebookPlugin from "../main";

export class CreateNotebookModal extends Modal {
	private name = "";
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

		new Setting(contentEl).setName("名称").addText((t) => {
			t.setPlaceholder("例如：文献本");
			t.onChange((v) => {
				this.name = v;
			});
		});

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

		for (const tpl of TEMPLATES) {
			const card = grid.createDiv({ cls: "template-card" });
			card.dataset.templateId = tpl.id;
			card.createEl("h4", { text: tpl.label });
			card.createEl("p", { text: tpl.description });
			card.addEventListener("click", () => {
				this.templateId = tpl.id;
				renderSelection();
			});
			cards.push(card);
		}
		renderSelection();

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("创建")
				.setCta()
				.onClick(async () => {
					try {
						const meta = await this.plugin.notebooks.createNotebook({
							name: this.name || "未命名记录本",
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
						new Notice(
							`创建失败: ${e instanceof Error ? e.message : String(e)}`,
						);
					}
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
