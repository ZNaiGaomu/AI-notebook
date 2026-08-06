import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import type { BridgeStatus } from "../bridge/mobileBridgeServer";
import QRCode from "qrcode";

export class BridgeLinkModal extends Modal {
	private status: BridgeStatus;
	private busy = false;
	private handlers: {
		onStartLocal: () => Promise<BridgeStatus>;
		onStartPublic: () => Promise<BridgeStatus>;
		onStop: () => Promise<BridgeStatus>;
		onRefresh: () => BridgeStatus;
		onSavePublicBase: (url: string) => Promise<BridgeStatus>;
	};

	constructor(
		app: App,
		status: BridgeStatus,
		handlers: {
			onStartLocal: () => Promise<BridgeStatus>;
			onStartPublic: () => Promise<BridgeStatus>;
			onStop: () => Promise<BridgeStatus>;
			onRefresh: () => BridgeStatus;
			onSavePublicBase: (url: string) => Promise<BridgeStatus>;
		},
	) {
		super(app);
		this.status = status;
		this.handlers = handlers;
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "手机网页入口" });

		contentEl.createEl("p", {
			text: "电脑开着 Obsidian 时，生成一个网页链接。手机可通过 Tailscale 虚拟局域网、同 Wi‑Fi 局域网或公网隧道打开；内容写回本机笔记并由 AI 整理。也可用「高木的速记工坊」App 扫码接入。",
			cls: "setting-item-description",
		});

		const st = contentEl.createDiv();
		st.createEl("p", {
			text: this.status.running
				? `本地服务：运行中 · 端口 ${this.status.port}`
				: `本地服务：未启动 · 端口 ${this.status.port}`,
		});
		if (this.status.publicBaseUrl) {
			st.createEl("p", {
				text: `公网基址：${this.status.publicBaseUrl}`,
			});
		}
		if (this.status.error) {
			st.createEl("p", {
				text: `错误：${this.status.error}`,
				cls: "mod-warning",
			});
		}
		if (this.status.tunnelHint) {
			const pre = st.createEl("pre");
			pre.style.whiteSpace = "pre-wrap";
			pre.style.fontSize = "0.85em";
			pre.textContent = this.status.tunnelHint;
		}

		// ——— Tailscale virtual LAN ———
		contentEl.createEl("h3", { text: "① Tailscale 虚拟局域网（推荐稳定）" });
		contentEl.createEl("p", {
			text: this.status.running
				? "电脑和手机都登录同一个 Tailscale 后，手机复制下面的 100.x 链接即可访问；不要求同一 Wi‑Fi，也不需要公网隧道。App 可扫码。"
				: "先启动本地服务，再复制 100.x 的 Tailscale 链接到手机浏览器；电脑和手机需登录同一个 Tailscale。",
			cls: "setting-item-description",
		});
		if (this.status.tailscaleUrls.length === 0) {
			contentEl.createEl("p", {
				text: "未检测到 Tailscale 地址。请确认电脑端 Tailscale 已连接，然后点「启动/刷新 Tailscale 链接」；若仍为空，可在 Tailscale 客户端查看本机 100.x 地址。",
				cls: "setting-item-description",
			});
		} else {
			this.renderUrlList(contentEl, this.status.tailscaleUrls, true);
		}
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText(
					this.status.running
						? "刷新 Tailscale 链接"
						: "启动/刷新 Tailscale 链接",
				)
				.onClick(async () => {
					try {
						if (!this.status.running) {
							this.status = await this.handlers.onStartLocal();
						} else {
							this.status = this.handlers.onRefresh();
						}
						this.render();
					} catch (e) {
						new Notice(String(e));
					}
				}),
		);

		// ——— Public ———
		contentEl.createEl("h3", { text: "② 任意网络公网链接（Cloudflare/ngrok）" });
		contentEl.createEl("p", {
			text: "需要公网隧道：一键 Cloudflare 临时隧道，或手动填入 ngrok 等地址。Tailscale 可用时通常不需要这一项。",
			cls: "setting-item-description",
		});
		if (this.status.publicUrls.length === 0) {
			contentEl.createEl("p", {
				text: "尚未生成公网链接。点下方「生成任意网络链接」。",
				cls: "setting-item-description",
			});
		} else {
			this.renderUrlList(contentEl, this.status.publicUrls, true);
		}
		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("生成任意网络链接（Cloudflare）")
					.setCta()
					.setDisabled(this.busy)
					.onClick(async () => {
						this.busy = true;
						this.render();
						try {
							this.status = await this.handlers.onStartPublic();
							new Notice("已生成公网链接，可复制或扫码到手机");
						} catch (e) {
							new Notice(String(e));
						} finally {
							this.busy = false;
							this.render();
						}
					}),
			)
			.addText((t: TextComponent) => {
				t.setPlaceholder("https://xxx.trycloudflare.com");
				t.setValue(this.status.publicBaseUrl || "");
				t.inputEl.style.minWidth = "220px";
				const save = contentEl.createEl("button", { text: "保存并使用" });
				save.style.marginLeft = "8px";
				save.onclick = async () => {
					const v = t.getValue().trim();
					this.status = await this.handlers.onSavePublicBase(v);
					this.render();
					new Notice("已保存公网基址");
				};
			});

		// ——— LAN ———
		contentEl.createEl("h3", { text: "③ 仅同一 Wi‑Fi（普通局域网）" });
		contentEl.createEl("p", {
			text: "不经过公网。手机必须和电脑同一路由器。优先复制 192.168.x.x，不要用 127.0.0.1 给手机。",
			cls: "setting-item-description",
		});
		this.renderUrlList(contentEl, this.status.urls, false);

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("停止入口").onClick(async () => {
					this.status = await this.handlers.onStop();
					this.render();
				}),
			)
			.addButton((b) =>
				b.setButtonText("关闭").onClick(() => this.close()),
			);
	}

	private renderUrlList(
		parent: HTMLElement,
		urls: string[],
		highlight: boolean,
	): void {
		const list = parent.createDiv();
		if (urls.length === 0) {
			list.createEl("p", {
				text: "（无）",
				cls: "setting-item-description",
			});
			return;
		}
		for (const url of urls) {
			const row = list.createDiv({ cls: "ai-notebook-settings-actions" });
			row.style.marginBottom = "14px";
			row.style.paddingBottom = "10px";
			row.style.borderBottom = "1px solid var(--background-modifier-border)";

			const code = row.createEl("code");
			code.setText(url);
			code.style.wordBreak = "break-all";
			code.style.display = "block";
			code.style.marginBottom = "6px";
			if (highlight) {
				code.style.color = "var(--text-accent)";
			}

			const actions = row.createDiv();
			actions.style.display = "flex";
			actions.style.flexWrap = "wrap";
			actions.style.gap = "8px";
			actions.style.alignItems = "flex-start";

			const btn = actions.createEl("button", { text: "复制" });
			btn.addEventListener("click", async () => {
				await navigator.clipboard.writeText(url);
				new Notice("已复制链接");
			});

			const qrBox = actions.createDiv();
			qrBox.style.display = "flex";
			qrBox.style.flexDirection = "column";
			qrBox.style.alignItems = "center";
			const img = qrBox.createEl("img");
			img.alt = "二维码";
			img.style.width = "160px";
			img.style.height = "160px";
			img.style.imageRendering = "pixelated";
			img.style.background = "#fff";
			img.style.padding = "6px";
			img.style.borderRadius = "8px";
			const cap = qrBox.createEl("div", {
				text: "App 扫码接入",
				cls: "setting-item-description",
			});
			cap.style.fontSize = "0.8em";
			cap.style.marginTop = "4px";
			void QRCode.toDataURL(url, {
				margin: 1,
				width: 240,
				errorCorrectionLevel: "M",
			})
				.then((dataUrl) => {
					img.src = dataUrl;
				})
				.catch((e) => {
					img.replaceWith(
						qrBox.createEl("span", {
							text: `二维码生成失败：${e instanceof Error ? e.message : String(e)}`,
							cls: "mod-warning",
						}),
					);
				});
		}
	}
}
