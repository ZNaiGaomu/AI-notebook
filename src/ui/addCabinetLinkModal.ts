import { App, Modal, Notice, Setting } from "obsidian";

export type AddCabinetLinkResult = {
	url: string;
	title: string;
	note: string;
};

/**
 * Modal for adding a cabinet link (URL required; title/note optional).
 */
export class AddCabinetLinkModal extends Modal {
	private url = "";
	private title = "";
	private note = "";
	private resolve: ((v: AddCabinetLinkResult | null) => void) | null = null;
	private settled = false;

	constructor(app: App, initial?: Partial<AddCabinetLinkResult>) {
		super(app);
		if (initial?.url) this.url = initial.url;
		if (initial?.title) this.title = initial.title;
		if (initial?.note) this.note = initial.note;
	}

	waitForResult(): Promise<AddCabinetLinkResult | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ai-notebook-create-modal");
		contentEl.createEl("h2", { text: "添加链接到收藏柜" });

		new Setting(contentEl).setName("URL").setDesc("必填").addText((t) => {
			t.setPlaceholder("https://…");
			t.setValue(this.url);
			t.inputEl.style.width = "100%";
			t.onChange((v) => {
				this.url = v;
			});
			// focus
			window.setTimeout(() => t.inputEl.focus(), 20);
		});

		new Setting(contentEl).setName("标题").setDesc("可选，留空则用 URL").addText((t) => {
			t.setPlaceholder("显示名称");
			t.setValue(this.title);
			t.onChange((v) => {
				this.title = v;
			});
		});

		new Setting(contentEl).setName("备注").setDesc("可选").addTextArea((t) => {
			t.setPlaceholder("一句话说明…");
			t.setValue(this.note);
			t.inputEl.rows = 3;
			t.onChange((v) => {
				this.note = v;
			});
		});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("取消").onClick(() => {
					this.finish(null);
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("添加")
					.setCta()
					.onClick(() => {
						const url = this.url.trim();
						if (!url) {
							new Notice("请填写 URL");
							return;
						}
						// light validation
						if (!/^https?:\/\//i.test(url) && !url.includes(".")) {
							new Notice("URL 看起来不完整，请检查");
							return;
						}
						this.finish({
							url,
							title: this.title.trim(),
							note: this.note.trim(),
						});
					}),
			);
	}

	onClose(): void {
		if (!this.settled) this.finish(null);
		this.contentEl.empty();
	}

	private finish(value: AddCabinetLinkResult | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve?.(value);
		this.close();
	}
}
