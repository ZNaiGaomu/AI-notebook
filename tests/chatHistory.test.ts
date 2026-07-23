import { describe, expect, it } from "vitest";
import type { ChatThread } from "../src/services/chatHistoryStore";

// Pure helper mirrored from store.toApiMessages for unit test without App
function toApiMessages(
	thread: ChatThread,
	systemPrompt?: string,
	maxTurns = 24,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
	const out: Array<{
		role: "system" | "user" | "assistant";
		content: string;
	}> = [];
	if (systemPrompt?.trim()) {
		out.push({ role: "system", content: systemPrompt.trim() });
	}
	const recent = thread.messages
		.filter((m) => m.role === "user" || m.role === "assistant")
		.slice(-maxTurns);
	for (const m of recent) {
		out.push({
			role: m.role as "user" | "assistant",
			content: m.content,
		});
	}
	return out;
}

describe("chat history context", () => {
	it("builds multi-turn messages with system prompt", () => {
		const thread: ChatThread = {
			id: "t1",
			mode: "assistant",
			notebookId: "n1",
				itemId: "item-1",
				itemTitle: "note",
			title: "test",
			createdAt: "a",
			updatedAt: "b",
			messages: [
				{ id: "1", role: "user", content: "你好", createdAt: "1" },
				{ id: "2", role: "assistant", content: "你好！", createdAt: "2" },
				{ id: "3", role: "user", content: "继续", createdAt: "3" },
			],
		};
		const msgs = toApiMessages(thread, "系统提示", 20);
		expect(msgs[0]).toEqual({ role: "system", content: "系统提示" });
		expect(msgs).toHaveLength(4);
		expect(msgs[3]?.content).toBe("继续");
	});
});
