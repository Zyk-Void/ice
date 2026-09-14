import { describe, expect, it } from "vitest";
import type { NormalizedBlock } from "../types.ts";
import { buildSections } from "./build-sections.ts";
import { formatSummary } from "./format.ts";
import { compile } from "./summarize.ts";

const blocks: NormalizedBlock[] = [
	{ kind: "user", text: "Fix the failing test" },
	{ kind: "tool_call", name: "Read", args: { file_path: "/tmp/a.ts" } },
	{ kind: "tool_result", name: "Read", text: "file body", isError: false },
	{ kind: "tool_call", name: "bash", args: { command: "git status" } },
	{ kind: "tool_result", name: "bash", text: "fatal: not a git repository", isError: true },
	{ kind: "tool_call", name: "Edit", args: { file_path: "/tmp/a.ts" } },
	{ kind: "tool_result", name: "Edit", text: "edited", isError: false },
];

describe("last actions section", () => {
	it("lists the most recent tool actions in order and marks failures", () => {
		const data = buildSections({ blocks });
		expect(data.recentActions).toEqual(['Read "/tmp/a.ts"', 'bash "git status" [error]', 'Edit "/tmp/a.ts"']);
	});

	it("renders Last Actions before every other section", () => {
		const data = buildSections({ blocks });
		const formatted = formatSummary(data);
		expect(formatted.indexOf("[Last Actions]")).toBe(0);
		expect(formatted.indexOf("[Session Goal]")).toBeGreaterThan(0);
	});

	it("caps the section at the ten most recent actions", () => {
		const many: NormalizedBlock[] = [];
		for (let i = 0; i < 14; i++) {
			many.push({ kind: "tool_call", name: "Read", args: { file_path: `/tmp/${i}.ts` } });
			many.push({ kind: "tool_result", name: "Read", text: "ok", isError: false });
		}
		const data = buildSections({ blocks: many });
		expect(data.recentActions).toHaveLength(10);
		expect(data.recentActions[0]).toBe('Read "/tmp/4.ts"');
	});

	it("replaces stale Last Actions from the previous summary with fresh ones", () => {
		const previousSummary = '[Last Actions]\n- Stale "thing"\n\n[Session Goal]\n- Fix the failing test';
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "Grep", arguments: { pattern: "TODO" } }],
			},
			{ role: "toolResult", toolName: "Grep", content: "src/a.ts:1: TODO", isError: false },
		] as unknown as Parameters<typeof compile>[0]["messages"];
		const merged = compile({ messages, previousSummary });
		expect(merged).toContain("[Last Actions]");
		expect(merged).toContain('- Grep "TODO"');
		expect(merged).not.toContain('Stale "thing"');
		expect(merged).toContain("[Session Goal]");
	});
});
