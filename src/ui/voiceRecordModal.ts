import { App, Modal, Notice, Setting } from "obsidian";
import type { VoiceRecordFormat } from "../domain/types";
import {
	canUseMicrophone,
	negotiateRecordFormat,
	startMediaRecorderCapture,
	type MediaRecordHandle,
	type NegotiatedRecordFormat,
} from "../infra/audioWav";

export type VoiceRecordResult =
	| { ok: true; blob: Blob; durationMs: number; filename: string }
	| { ok: false; error: string; cancelled?: boolean };

/**
 * Start/stop voice recorder with configurable container format.
 */
export type VoiceTargetOption = { id: string; title: string };

export class VoiceRecordModal extends Modal {
	private resolveFn: ((r: VoiceRecordResult) => void) | null = null;
	private capture: MediaRecordHandle | null = null;
	private stream: MediaStream | null = null;
	private startedAt = 0;
	private timerEl: HTMLElement | null = null;
	private timerHandle: number | null = null;
	private statusEl: HTMLElement | null = null;
	private recording = false;
	private negotiated: NegotiatedRecordFormat;
	/** "" = create new item; otherwise append to existing item id */
	private selectedTargetId = "";

	constructor(
		app: App,
		private readonly formatPref: VoiceRecordFormat = "auto",
		private readonly targetOptions: VoiceTargetOption[] = [],
		private readonly defaultTargetId: string = "",
	) {
		super(app);
		this.negotiated = negotiateRecordFormat(formatPref);
		this.selectedTargetId = defaultTargetId || "";
	}

	/** Selected target after close (only meaningful on ok result). */
	getSelectedTargetId(): string {
		return this.selectedTargetId;
	}

	waitForResult(): Promise<VoiceRecordResult> {
		return new Promise((resolve) => {
			this.resolveFn = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "语音录入" });
		contentEl.createEl("p", {
			text: `点击开始录音，说完后点停止。当前格式：${this.negotiated.label}（可在设置中更改）。`,
			cls: "setting-item-description",
		});

		// Target: new item vs append to existing
		const targetWrap = contentEl.createDiv({ cls: "setting-item" });
		const targetInfo = targetWrap.createDiv({ cls: "setting-item-info" });
		targetInfo.createDiv({
			cls: "setting-item-name",
			text: "写入目标",
		});
		targetInfo.createDiv({
			cls: "setting-item-description",
			text: "可新建条目，或追加到已有条目正文末尾。",
		});
		const targetControl = targetWrap.createDiv({
			cls: "setting-item-control",
		});
		const select = targetControl.createEl("select");
		select.style.minWidth = "220px";
		const optNew = select.createEl("option", {
			text: "＋ 新建条目（默认）",
			attr: { value: "" },
		});
		// Obsidian createEl option value
		(optNew as HTMLOptionElement).value = "";
		for (const t of this.targetOptions) {
			const o = select.createEl("option", {
				text: t.title || "未命名",
			});
			(o as HTMLOptionElement).value = t.id;
		}
		select.value = this.selectedTargetId;
		select.addEventListener("change", () => {
			this.selectedTargetId = select.value || "";
		});

		const mic = canUseMicrophone();
		if (!mic.ok) {
			contentEl.createEl("p", {
				text: mic.reason || "无法使用麦克风",
				cls: "mod-warning",
			});
		} else if (mic.reason) {
			contentEl.createEl("p", {
				text: mic.reason,
				cls: "setting-item-description",
			});
		}

		this.statusEl = contentEl.createDiv({ text: "就绪" });
		this.timerEl = contentEl.createDiv({
			text: "00:00",
			cls: "ai-notebook-voice-timer",
		});

		const startBtn = contentEl.createEl("button", { text: "开始录音" });
		startBtn.addClass("mod-cta");
		const stopBtn = contentEl.createEl("button", { text: "停止并转写" });
		stopBtn.disabled = true;
		const cancelBtn = contentEl.createEl("button", { text: "取消" });

		startBtn.addEventListener("click", () => {
			void this.start(startBtn, stopBtn);
		});
		stopBtn.addEventListener("click", () => {
			void this.stop();
		});
		cancelBtn.addEventListener("click", () => {
			void this.cleanup();
			this.finish({ ok: false, error: "已取消", cancelled: true });
		});

		new Setting(contentEl)
			.setName("转写失败时")
			.setDesc("可粘贴已有文字直接入库")
			.addButton((b) =>
				b.setButtonText("改用文字输入").onClick(() => {
					const text = window.prompt("粘贴或输入要记录的文字：");
					if (text == null || !text.trim()) return;
					this.finish({
						ok: false,
						error: `TEXT_FALLBACK:${text.trim()}`,
						cancelled: false,
					});
				}),
			);
	}

	onClose(): void {
		if (this.resolveFn) {
			void this.cleanup();
			this.resolveFn({ ok: false, error: "已关闭", cancelled: true });
			this.resolveFn = null;
		}
		this.contentEl.empty();
	}

	private async start(
		startBtn: HTMLButtonElement,
		stopBtn: HTMLButtonElement,
	): Promise<void> {
		if (this.recording) return;
		const mic = canUseMicrophone();
		if (!mic.ok) {
			this.finish({ ok: false, error: mic.reason || "无法使用麦克风" });
			return;
		}
		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					channelCount: 1,
				},
			});
			this.capture = await startMediaRecorderCapture(
				this.stream,
				this.negotiated,
			);
			this.recording = true;
			this.startedAt = Date.now();
			startBtn.disabled = true;
			stopBtn.disabled = false;
			if (this.statusEl) {
				this.statusEl.setText(`录音中…（${this.negotiated.label}）`);
			}
			this.timerHandle = window.setInterval(() => {
				const sec = Math.floor((Date.now() - this.startedAt) / 1000);
				const m = String(Math.floor(sec / 60)).padStart(2, "0");
				const s = String(sec % 60).padStart(2, "0");
				if (this.timerEl) this.timerEl.setText(`${m}:${s}`);
			}, 250);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`无法打开麦克风: ${msg}`);
			await this.cleanup();
			this.finish({ ok: false, error: msg });
		}
	}

	private async stop(): Promise<void> {
		if (!this.capture || !this.recording) {
			this.finish({ ok: false, error: "未在录音" });
			return;
		}
		if (this.statusEl) this.statusEl.setText("生成音频…");
		if (this.timerHandle != null) {
			window.clearInterval(this.timerHandle);
			this.timerHandle = null;
		}
		this.recording = false;
		try {
			const { blob, durationMs, filename } = await this.capture.stop();
			this.capture = null;
			this.stream = null;
			this.finish({
				ok: true,
				blob,
				durationMs,
				filename: filename || `audio.${this.negotiated.extension}`,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.finish({ ok: false, error: msg });
		}
	}

	private async cleanup(): Promise<void> {
		if (this.timerHandle != null) {
			window.clearInterval(this.timerHandle);
			this.timerHandle = null;
		}
		try {
			if (this.capture && this.recording) {
				await this.capture.stop();
			}
		} catch {
			// ignore
		}
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = null;
		this.capture = null;
		this.recording = false;
	}

	private finish(result: VoiceRecordResult): void {
		const fn = this.resolveFn;
		this.resolveFn = null;
		void this.cleanup();
		this.close();
		fn?.(result);
	}
}
