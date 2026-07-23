import { App, Modal, Notice, Setting } from "obsidian";
import {
	canUseMicrophone,
	startWavCapture,
	type WavCaptureHandle,
} from "../infra/audioWav";

export type VoiceRecordResult =
	| { ok: true; blob: Blob; durationMs: number; filename: string }
	| { ok: false; error: string; cancelled?: boolean };

/**
 * Start/stop voice recorder → WAV (Whisper-friendly).
 */
export class VoiceRecordModal extends Modal {
	private resolveFn: ((r: VoiceRecordResult) => void) | null = null;
	private capture: WavCaptureHandle | null = null;
	private stream: MediaStream | null = null;
	private startedAt = 0;
	private timerEl: HTMLElement | null = null;
	private timerHandle: number | null = null;
	private statusEl: HTMLElement | null = null;
	private recording = false;

	constructor(app: App) {
		super(app);
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
			text: "点击开始录音，说完后点停止。音频将转为 WAV 再提交转写（兼容更多上游）。",
			cls: "setting-item-description",
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

		// Manual paste fallback
		new Setting(contentEl)
			.setName("转写失败时")
			.setDesc("可粘贴已有文字直接入库")
			.addButton((b) =>
				b.setButtonText("改用文字输入").onClick(() => {
					const text = window.prompt("粘贴或输入要记录的文字：");
					if (text == null || !text.trim()) return;
					// Encode as fake "transcript via text" — caller expects audio;
					// signal cancel and let parent use text — use special finish
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
			this.capture = await startWavCapture(this.stream);
			this.recording = true;
			this.startedAt = Date.now();
			startBtn.disabled = true;
			stopBtn.disabled = false;
			if (this.statusEl) this.statusEl.setText("录音中…（WAV）");
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
		if (this.statusEl) this.statusEl.setText("生成 WAV…");
		if (this.timerHandle != null) {
			window.clearInterval(this.timerHandle);
			this.timerHandle = null;
		}
		this.recording = false;
		try {
			const { blob, durationMs } = await this.capture.stop();
			this.capture = null;
			this.stream = null;
			this.finish({
				ok: true,
				blob,
				durationMs,
				filename: "audio.wav",
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
