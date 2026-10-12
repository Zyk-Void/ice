import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.ts";

describe("edit matching: exact text wins over fuzzy-equivalent text", () => {
	it("accepts a unique exact match when fuzzy-equivalent text exists elsewhere", () => {
		const content = 'a = "hi";\nb = “hi”;\n';
		const { newContent } = applyEditsToNormalizedContent(content, [{ oldText: '"hi"', newText: '"bye"' }], "f.ts");
		expect(newContent).toBe('a = "bye";\nb = “hi”;\n');
	});

	it("rejects duplicate exact matches without using fuzzy matching to choose", () => {
		const content = 'x("hi");\ny("hi");\n';
		expect(() => applyEditsToNormalizedContent(content, [{ oldText: '"hi"', newText: '"bye"' }], "f.ts")).toThrow(
			/Found 2 occurrences/,
		);
	});

	it("rejects ambiguous fuzzy-only matches", () => {
		const content = "x(“hi”);\ny(“hi”);\n";
		expect(() => applyEditsToNormalizedContent(content, [{ oldText: '"hi"', newText: '"bye"' }], "f.ts")).toThrow(
			/Found 2 occurrences/,
		);
	});

	it("keeps an exact edit on its own occurrence when another edit needs fuzzy matching", () => {
		const content = 'one = "hi";\ntwo = “hi”;\nthree = ‘x’ — y;\n';
		const { newContent } = applyEditsToNormalizedContent(
			content,
			[
				{ oldText: 'one = "hi";', newText: 'one = "bye";' },
				{ oldText: "three = 'x' - y;", newText: "three = 'z' - y;" },
			],
			"f.ts",
		);
		expect(newContent).toBe("one = \"bye\";\ntwo = “hi”;\nthree = 'z' - y;\n");
	});

	it("maps an exact match after Unicode text on the same line into fuzzy space", () => {
		const content = "s = “q”; t = 1;\nu = ‘v’;\n";
		const { newContent } = applyEditsToNormalizedContent(
			content,
			[
				{ oldText: "t = 1;", newText: "t = 2;" },
				{ oldText: "u = 'v';", newText: "u = 'w';" },
			],
			"f.ts",
		);
		expect(newContent).toContain("t = 2;");
		expect(newContent).toContain("u = 'w';");
	});
});
