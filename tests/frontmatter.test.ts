import { describe, expect, it } from "vitest";
import {
	parseFrontmatter,
	serializeFrontmatter,
} from "../src/infra/frontmatter";

describe("frontmatter roundtrip", () => {
	it("serializes and parses scalars and arrays", () => {
		const content = serializeFrontmatter(
			{
				ai_notebook: true,
				title: "测试标题",
				schema_version: 3,
				tags: ["a", "b"],
				url: "https://example.com/path?x=1",
				empty: "",
			},
			"正文内容\n第二行\n",
		);
		const { frontmatter, body } = parseFrontmatter(content);
		expect(frontmatter.ai_notebook).toBe(true);
		expect(frontmatter.title).toBe("测试标题");
		expect(frontmatter.schema_version).toBe(3);
		expect(frontmatter.tags).toEqual(["a", "b"]);
		expect(frontmatter.url).toBe("https://example.com/path?x=1");
		expect(body).toContain("正文内容");
	});
});
