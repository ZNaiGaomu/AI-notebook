import { App, Modal, Setting } from "obsidian";
import type { DiffLine } from "../services/versionService";

export class DiffConfirmModal extends Modal {
	private lines: DiffLine[];
	private titleText: string;
	private resolveFn: ((ok: boolean) => void) | null = null;

	constructor(app: App, titleText: string, lines: DiffLine[]) {
		super(app);
		this.titleText = titleText;
		this.lines = lines;
	}

	/** Open and wait for user confirm/cancel. */
	waitForConfirm(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolveFn = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: this.titleText });
		contentEl.createEl("p", {
			text: "请确认以下功能变更后再应用。",
			cls: "setting-item-description",
		});
		const pre = contentEl.createEl("pre");
		pre.style.whiteSpace = "pre-wrap";
		pre.style.maxHeight = "320px";
		pre.style.overflow = "auto";
		pre.textContent = this.lines
			.map((l) => {
				const tag =
					l.kind === "add"
						? "+"
						: l.kind === "remove"
							? "-"
							: l.kind === "change"
								? "~"
								: " ";
				return `${tag} ${l.text}`;
			})
			.join("\n");

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("取消").onClick(() => {
					this.resolveFn?.(false);
					this.resolveFn = null;
					this.close();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("确认应用")
					.setCta()
					.onClick(() => {
						this.resolveFn?.(true);
						this.resolveFn = null;
						this.close();
					}),
			);
	}

	onClose(): void {
		if (this.resolveFn) {
			this.resolveFn(false);
			this.resolveFn = null;
		}
		this.contentEl.empty();
	}
}
