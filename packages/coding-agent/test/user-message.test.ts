import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("keeps a one-row user message compact with OSC markers in zone order at line start", () => {
		initTheme("dark");

		const lines = new UserMessageComponent("hello").render(20);

		expect(lines).toHaveLength(1);
		expect(lines[0]!.startsWith(OSC133_ZONE_START + OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[0]).toContain("hello");
		expect(lines[0]!.endsWith(BG_RESET)).toBe(true);
	});

	test("moves closing OSC markers to the start of the last row of a multi-row message", () => {
		initTheme("dark");

		const lines = new UserMessageComponent("first line\n\nsecond line").render(20);

		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]!.startsWith(OSC133_ZONE_START)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines.at(-1)!.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines.at(-1)!.endsWith(BG_RESET)).toBe(true);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});
});
