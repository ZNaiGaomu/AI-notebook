import { describe, expect, it } from "vitest";
import { defaultNotebookName } from "../src/ui/createNotebookModal";

describe("CreateNotebookModal defaults", () => {
	it("provides a real default name for every template", () => {
		expect(defaultNotebookName("literature")).toBe("文献本");
		expect(defaultNotebookName("idea")).toBe("灵感本");
		expect(defaultNotebookName("meeting")).toBe("会议本");
		expect(defaultNotebookName("cabinet-first")).toBe("收藏向");
		expect(defaultNotebookName("blank")).toBe("空白本");
	});
});
