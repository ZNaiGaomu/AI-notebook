import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

export type TunnelStartResult =
	| { ok: true; publicBaseUrl: string; method: "cloudflared" | "manual" }
	| { ok: false; error: string; hint?: string };

/**
 * Temporary public HTTPS tunnel to local bridge port (any network can open the page).
 * Uses Cloudflare quick tunnel when `cloudflared` is available.
 */
export class PublicTunnel {
	private child: ChildProcess | null = null;
	private publicBaseUrl: string | null = null;

	getPublicBaseUrl(): string | null {
		return this.publicBaseUrl;
	}

	isRunning(): boolean {
		return this.child != null && !this.child.killed;
	}

	async stop(): Promise<void> {
		const c = this.child;
		this.child = null;
		this.publicBaseUrl = null;
		if (!c) return;
		try {
			c.kill();
		} catch {
			// ignore
		}
	}

	/**
	 * Start cloudflared quick tunnel → https://xxxx.trycloudflare.com
	 */
	async startCloudflared(
		localPort: number,
		cloudflaredPath?: string,
		timeoutMs = 45000,
	): Promise<TunnelStartResult> {
		await this.stop();
		const bin = resolveCloudflared(cloudflaredPath);
		if (!bin) {
			return {
				ok: false,
				error: "未找到 cloudflared",
				hint:
					"安装 Cloudflare Tunnel 客户端后即可一键生成「任意网络可打开」的 https 链接。\n" +
					"下载：https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/\n" +
					"Windows：安装后确保 cloudflared 在 PATH，或在插件设置里填写 cloudflared.exe 完整路径。\n" +
					"也可使用 ngrok：在终端运行 ngrok http " +
					localPort +
					" ，把 https 地址填到设置「公网地址」。",
			};
		}

		return new Promise((resolve) => {
			let settled = false;
			const args = ["tunnel", "--url", `http://127.0.0.1:${localPort}`];
			let child: ChildProcess;
			try {
				child = spawn(bin, args, {
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (e) {
				resolve({
					ok: false,
					error: e instanceof Error ? e.message : String(e),
					hint: "无法启动 cloudflared，请检查路径与权限。",
				});
				return;
			}
			this.child = child;

			const finishOk = (url: string) => {
				if (settled) return;
				settled = true;
				this.publicBaseUrl = url.replace(/\/+$/, "");
				clearTimeout(timer);
				resolve({
					ok: true,
					publicBaseUrl: this.publicBaseUrl,
					method: "cloudflared",
				});
			};
			const finishErr = (msg: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				void this.stop();
				resolve({
					ok: false,
					error: msg,
					hint: "也可改用 ngrok：ngrok http " + localPort,
				});
			};

			const onChunk = (buf: Buffer) => {
				const text = buf.toString("utf8");
				const m =
					text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i) ||
					text.match(/https:\/\/[a-zA-Z0-9.-]+\.cfargotunnel\.com/i);
				if (m?.[0]) finishOk(m[0]);
			};

			child.stdout?.on("data", onChunk);
			child.stderr?.on("data", onChunk);
			child.on("error", (err) => finishErr(err.message));
			child.on("exit", (code) => {
				if (!settled) {
					finishErr(`cloudflared 已退出 (code ${code})`);
				}
			});

			const timer = setTimeout(() => {
				finishErr("等待公网链接超时（cloudflared 未输出 trycloudflare 地址）");
			}, timeoutMs);
		});
	}

	/** Use a user-provided public base (ngrok / frp / caddy etc.) */
	setManualPublicBase(url: string): TunnelStartResult {
		const cleaned = url.trim().replace(/\/+$/, "");
		if (!/^https?:\/\//i.test(cleaned)) {
			return {
				ok: false,
				error: "公网地址需以 http:// 或 https:// 开头",
			};
		}
		this.publicBaseUrl = cleaned;
		return { ok: true, publicBaseUrl: cleaned, method: "manual" };
	}
}

function resolveCloudflared(configured?: string): string | null {
	const candidates: string[] = [];
	if (configured?.trim()) candidates.push(configured.trim());
	candidates.push("cloudflared");
	if (process.platform === "win32") {
		candidates.push("cloudflared.exe");
		const pf = process.env["ProgramFiles"] || "C:\\Program Files";
		const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
		const local = process.env["LOCALAPPDATA"] || "";
		candidates.push(path.join(pf, "cloudflared", "cloudflared.exe"));
		candidates.push(path.join(pf86, "cloudflared", "cloudflared.exe"));
		if (local) {
			candidates.push(path.join(local, "cloudflared", "cloudflared.exe"));
		}
	}
	for (const c of candidates) {
		if (c === "cloudflared" || c === "cloudflared.exe") {
			// PATH resolution happens at spawn; accept bare name
			return c;
		}
		try {
			if (fs.existsSync(c)) return c;
		} catch {
			// continue
		}
	}
	// bare name last resort (spawn may still find via PATH)
	return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

export function withToken(publicBaseUrl: string, token: string): string {
	const base = publicBaseUrl.replace(/\/+$/, "");
	const u = new URL(base.includes("://") ? base : `https://${base}`);
	if (token) u.searchParams.set("t", token);
	// URL with only origin + / + query
	return `${u.origin}/${u.search}`;
}
